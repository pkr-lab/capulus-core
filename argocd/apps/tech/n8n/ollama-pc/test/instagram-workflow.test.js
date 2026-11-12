'use strict';

// Führt den Code der n8n-Nodes aus workflows/instagram-dm-antworten.json mit Meta-ähnlichen Testdaten aus.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadPromptFiles, buildMessages } = require('../lib/prompt');
const { loadConfig } = require('../lib/config');

const WORKFLOW = path.join(__dirname, '..', '..', 'workflows', 'instagram-dm-antworten.json');
const workflow = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
const nodes = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const SECRET = 'geheim';
const IG = '17841400000000000';
const NUTZER = '99001';

function tmpZustand() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'igdm-')), 'zustand.json');
}

function konfig(overrides = {}) {
  const [{ json }] = new Function('$input', nodes['Konfiguration'].parameters.jsCode)({ first: () => ({ json: {}, binary: undefined }) });
  return { ...json.cfg, igUserId: IG, appSecret: SECRET, verifyToken: 'token', testModus: false, wartezeitSekunden: 0, zustandsDatei: tmpZustand(), ...overrides };
}

// Führt einen Code-Node aus. refs: Daten für $('Name'), input: Eingabe-Items, json: Daten für $json (runOnceForEachItem).
function run(name, { input = [], json = {}, refs = {}, binary } = {}) {
  const ref = (n) => {
    if (!(n in refs)) throw new Error(`Node "${n}" ist im Test nicht belegt`);
    const items = [].concat(refs[n]).map((j) => ({ json: j }));
    return { item: items[0], first: () => items[0], all: () => items };
  };
  const items = input.map((j, i) => ({ json: j, binary: i === 0 ? binary : undefined }));
  const $input = { all: () => items, first: () => items[0], item: items[0] };
  const context = { helpers: { getBinaryDataBuffer: async () => binary && binary.data.buffer } };
  const fn = new AsyncFunction('$', '$json', '$input', 'require', 'Buffer', 'console', 'process', nodes[name].parameters.jsCode);
  return fn.call(context, ref, json, $input, require, Buffer, { log() {} }, process);
}

function ereignis(cfg, messaging, { secret = SECRET, header } = {}) {
  const roh = Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ id: IG, time: 1, messaging }] }));
  const signatur = header || `sha256=${crypto.createHmac('sha256', secret).update(roh).digest('hex')}`;
  return { input: [{ cfg, headers: { 'x-hub-signature-256': signatur }, body: {} }], binary: { data: { buffer: roh } } };
}

const dm = (text, mid = 'm1', extra = {}) => ({ sender: { id: NUTZER }, recipient: { id: IG }, timestamp: 1, message: { mid, text, ...extra } });
const echo = (mid = 'e1') => ({ sender: { id: IG }, recipient: { id: NUTZER }, timestamp: 1, message: { mid, text: 'Hallo vom Team', is_echo: true } });

test('Webhook-Verifizierung: richtiges Token liefert die Challenge, falsches oder Platzhalter nicht', async () => {
  const cfg = konfig();
  const query = (token) => ({ input: [{ cfg, query: { 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '12345' } }] });
  assert.deepEqual((await run('Anfrage auswerten', query('token')))[0].json, { art: 'verify', ok: true, challenge: '12345' });
  assert.equal((await run('Anfrage auswerten', query('falsch')))[0].json.ok, false);
  const platzhalter = konfig({ verifyToken: 'CHANGE-ME-VERIFY-TOKEN' });
  const q = { input: [{ cfg: platzhalter, query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'CHANGE-ME-VERIFY-TOKEN', 'hub.challenge': '1' } }] };
  assert.equal((await run('Anfrage auswerten', q))[0].json.ok, false);
});

test('Ereignis: gültige Signatur → KI-Item; falsche Signatur oder fremdes Secret → verworfen', async () => {
  const cfg = konfig();
  const out = await run('Anfrage auswerten', ereignis(cfg, [dm('Wann ist Training?')]));
  assert.equal(out.length, 1);
  assert.equal(out[0].json.modus, 'ki');
  assert.equal(out[0].json.sender, NUTZER);
  assert.equal(out[0].json.text, 'Wann ist Training?');
  assert.equal(out[0].json.probe, false);
  assert.deepEqual(await run('Anfrage auswerten', ereignis(konfig(), [dm('x')], { secret: 'anderes' })), []);
  assert.deepEqual(await run('Anfrage auswerten', ereignis(konfig(), [dm('x')], { header: 'sha256=00' })), []);
  assert.deepEqual(await run('Anfrage auswerten', ereignis(konfig({ appSecret: 'CHANGE-ME-APP-SECRET' }), [dm('x')])), []);
});

test('Ereignis: Meta liefert doppelt → nur einmal beantwortet', async () => {
  const cfg = konfig();
  assert.equal((await run('Anfrage auswerten', ereignis(cfg, [dm('Hallo?', 'dup')]))).length, 1);
  assert.equal((await run('Anfrage auswerten', ereignis(cfg, [dm('Hallo?', 'dup')]))).length, 0);
});

test('Ereignis: Probelauf bei testModus und bei Nutzer außerhalb der Erlaubtenliste', async () => {
  assert.equal((await run('Anfrage auswerten', ereignis(konfig({ testModus: true }), [dm('a')])))[0].json.probe, true);
  assert.equal((await run('Anfrage auswerten', ereignis(konfig({ erlaubteNutzer: ['1'] }), [dm('a')])))[0].json.probe, true);
  assert.equal((await run('Anfrage auswerten', ereignis(konfig({ erlaubteNutzer: [NUTZER] }), [dm('a')])))[0].json.probe, false);
});

test('Ereignis: Mensch antwortet in der App → KI pausiert; Echo der eigenen API-Antwort zählt nicht', async () => {
  const cfg = konfig();
  await run('Anfrage auswerten', ereignis(cfg, [echo()]));
  assert.deepEqual(await run('Anfrage auswerten', ereignis(cfg, [dm('Danke!', 'n1')])), []);

  const cfg2 = konfig();
  const [vorbereitet] = [await run('Senden vorbereiten', { input: [{ sender: NUTZER, mid: 'x', modus: 'ki', antwort: 'Hi', probe: false }], refs: { Konfiguration: { cfg: cfg2 } } })];
  assert.equal(vorbereitet.length, 1);
  await run('Anfrage auswerten', ereignis(cfg2, [echo('e2')]));
  assert.equal((await run('Anfrage auswerten', ereignis(cfg2, [dm('Und noch eine Frage', 'n2')]))).length, 1);
});

test('Ereignis: Antwort-Limit je Person und Stunde', async () => {
  const cfg = konfig({ maxAntwortenProStunde: 2 });
  for (let i = 0; i < 2; i += 1) {
    await run('Senden vorbereiten', { input: [{ sender: NUTZER, mid: `s${i}`, modus: 'ki', antwort: 'Hi', probe: false }], refs: { Konfiguration: { cfg } } });
  }
  assert.deepEqual(await run('Anfrage auswerten', ereignis(cfg, [dm('Noch eine?', 'l1')])), []);
});

test('Ereignis: Anhang ohne Text → fester Text; Herz/Reaktion → ignoriert; „Mensch“ → Übergabe ohne KI', async () => {
  const cfg = konfig();
  const bild = await run('Anfrage auswerten', ereignis(cfg, [dm('', 'a1', { text: undefined, attachments: [{ type: 'image' }] })]));
  assert.equal(bild[0].json.modus, 'fest');
  assert.equal(bild[0].json.antwort, cfg.ohneTextAntwort);
  assert.deepEqual(await run('Anfrage auswerten', ereignis(cfg, [dm('', 'a2', { text: undefined, attachments: [{ type: 'like_heart' }] })])), []);
  const mensch = await run('Anfrage auswerten', ereignis(cfg, [dm('Kann ich mit einem Menschen sprechen?', 'a3')]));
  assert.equal(mensch[0].json.modus, 'uebergabe');
  assert.equal(mensch[0].json.antwort, cfg.uebergabeText);
  const lang = 'Ich möchte wissen, wie ich als Mensch schwimmen lerne und was das kostet. '.repeat(3);
  assert.equal((await run('Anfrage auswerten', ereignis(cfg, [dm(lang, 'a4')])))[0].json.modus, 'ki');
});

test('Neueste Nachricht: ältere Nachrichten derselben Person werden verworfen', async () => {
  const cfg = konfig();
  await run('Anfrage auswerten', ereignis(cfg, [dm('Erste', 'n1'), dm('Zweite', 'n2')]));
  const items = [{ sender: NUTZER, mid: 'n1' }, { sender: NUTZER, mid: 'n2' }];
  const out = await run('Noch die neueste Nachricht?', { input: items, refs: { Konfiguration: { cfg } } });
  assert.deepEqual(out.map((i) => i.json.mid), ['n2']);
});

test('LLM-Eingabe: Verlauf chronologisch, aktuelle Nachricht nicht doppelt, Payload passt zum KI-Prompt', async () => {
  const cfg = konfig();
  const nachricht = { sender: NUTZER, mid: 'm3', text: 'Und samstags?', modus: 'ki' };
  const verlauf = {
    data: [{ id: 'c1', messages: { data: [
      { id: 'm3', message: 'Und samstags?', from: { id: NUTZER }, created_time: '2026-11-06T09:00:00+0000' },
      { id: 'm2', message: 'Donnerstags 18 Uhr.', from: { id: IG }, created_time: '2026-11-06T08:00:00+0000' },
      { id: 'm1', message: 'Wann ist Training?', from: { id: NUTZER }, created_time: '2026-11-06T07:59:00+0000' },
    ] } }],
  };
  const { json } = await run('LLM-Eingabe bauen', { json: verlauf, refs: { 'Noch die neueste Nachricht?': nachricht, Konfiguration: { cfg } } });
  const payload = JSON.parse(Buffer.from(json.payloadB64, 'base64').toString('utf8'));
  assert.equal(payload.channel, 'instagram');
  assert.equal(payload.profile, 'ausbildung');
  assert.deepEqual(payload.history.map((h) => [h.from, h.text]), [['Anfragende Person', 'Wann ist Training?'], ['DLRG Andernach (Verein)', 'Donnerstags 18 Uhr.']]);
  assert.equal(payload.mail.text, 'Und samstags?');

  const ollama = loadConfig({ OLLAMA_URL: 'http://x:1', OLLAMA_PROMPTS_DIR: path.join(__dirname, '..', 'prompts'), OLLAMA_KNOWLEDGE_DIR: path.join(__dirname, '..', 'knowledge', 'dlrg') });
  const prompts = loadPromptFiles(ollama, { profile: payload.profile, channel: payload.channel });
  const built = buildMessages(prompts, payload, ollama);
  assert.ok(built.messages[1].content.includes('Donnerstags 18 Uhr.'));
  assert.ok(prompts.knowledge.ratio < 0.6, `Wissen belegt ${Math.round(prompts.knowledge.ratio * 100)}% des Kontexts`);

  const fehler = await run('LLM-Eingabe bauen', { json: { error: { message: 'Token' } }, refs: { 'Noch die neueste Nachricht?': nachricht, Konfiguration: { cfg } } });
  assert.deepEqual(JSON.parse(Buffer.from(fehler.json.payloadB64, 'base64').toString('utf8')).history, []);
});

function pruefen(reply, extra = {}) {
  const cfg = konfig();
  const eingabe = { sender: NUTZER, mid: 'm1', text: 'Frage', modus: 'ki', probe: false, payloadB64: 'xx' };
  const stdout = extra.stdout !== undefined ? extra.stdout : `${JSON.stringify({ ok: true, reply })}\n`;
  return run('Antwort prüfen', { json: { stdout, ...extra.rest }, refs: { 'LLM-Eingabe bauen': eingabe, Konfiguration: { cfg } } }).then((r) => ({ ...r.json, cfg }));
}

test('Antwort prüfen: normale Antwort geht durch, Markdown wird entfernt', async () => {
  const out = await pruefen('**Training** ist donnerstags.\n* 18 Uhr\nMehr unter https://andernach.dlrg.de/kurse-und-sicherheit/anmeldung/ oder info@andernach.dlrg.de.');
  assert.equal(out.modus, 'ki');
  assert.ok(out.antwort.startsWith('Training ist donnerstags.\n- 18 Uhr'));
  assert.ok(!('payloadB64' in out));
});

test('Antwort prüfen: [ÜBERGABE] → fester Text bzw. Text davor (Notruf), Grund in der Notiz', async () => {
  const a = await pruefen('[ÜBERGABE: Beschwerde über Trainer]');
  assert.equal(a.modus, 'uebergabe');
  assert.equal(a.antwort, a.cfg.uebergabeText);
  assert.match(a.notiz, /Beschwerde über Trainer/);
  const b = await pruefen('Bei Gefahr bitte sofort den Notruf 112 wählen.\n[ÜBERGABE: AKUTE GEFAHR gemeldet]');
  assert.equal(b.antwort, 'Bei Gefahr bitte sofort den Notruf 112 wählen.');
});

test('Antwort prüfen: Platzhalter, fremde Links/Adressen, leere Antwort und Ollama-Fehler gehen nie raus', async () => {
  for (const reply of ['Hier der Link [KURSLINK: CrashKurs]', 'Siehe Teilnahmebedingungen (`08_kontakt_und_links.md`).', '[BITTE PRÜFEN: Preis] 20 Euro', 'Schau auf https://evil.example/anmelden', 'Schreib an max@gmail.com', 'Siehe www.fake-dlrg.de', '   ']) {
    const out = await pruefen(reply);
    assert.equal(out.modus, 'uebergabe', reply);
    assert.equal(out.antwort, out.cfg.uebergabeText, reply);
  }
  const fehler = await pruefen('', { stdout: JSON.stringify({ ok: false, error: { code: 'OLLAMA_DOWN', message: 'nicht erreichbar' } }) });
  assert.equal(fehler.modus, 'uebergabe');
  assert.match(fehler.notiz, /OLLAMA_DOWN/);
  assert.equal((await pruefen('', { stdout: '', rest: { stderr: 'boom' } })).modus, 'uebergabe');
  const ok = await pruefen('Schau auf https://www.andernach.dlrg.de/ oder https://instagram.com/dlrg_andernach.');
  assert.equal(ok.modus, 'ki');
});

test('Senden vorbereiten: KI-Hinweis angehängt, lange Antwort in Stücke ≤ 900 Byte, Reihenfolge erhalten', async () => {
  const cfg = konfig();
  const absatz = 'Das Schwimmtraining für Kinder findet donnerstags statt. '.repeat(8).trim();
  const antwort = [absatz, absatz, 'Ende.'].join('\n\n');
  const out = await run('Senden vorbereiten', { input: [{ sender: NUTZER, mid: 'm1', modus: 'ki', antwort, probe: false, text: 'x' }], refs: { Konfiguration: { cfg } } });
  assert.ok(out.length >= 2);
  for (const { json } of out) assert.ok(Buffer.byteLength(json.nachrichtText) <= cfg.maxBytesProNachricht);
  assert.equal(out.map((o) => o.json.nachrichtText).join('\n\n').replace(/\n\n/g, '\n\n'), [antwort, cfg.kiHinweis].join('\n\n'));
  assert.deepEqual(out.map((o) => o.json.teil), out.map((_, i) => i + 1));
  const einWort = 'ü'.repeat(1000);
  const hart = await run('Senden vorbereiten', { input: [{ sender: NUTZER, mid: 'm2', modus: 'ki', antwort: einWort, probe: false }], refs: { Konfiguration: { cfg: konfig({ kiHinweis: '' }) } } });
  for (const { json } of hart) assert.ok(Buffer.byteLength(json.nachrichtText) <= 900);
  assert.equal(hart.map((o) => o.json.nachrichtText).join(''), einWort);
});

test('Senden vorbereiten: Probelauf ergibt genau ein Item und sperrt nichts; Übergabe pausiert die KI', async () => {
  const cfg = konfig();
  const probe = await run('Senden vorbereiten', { input: [{ sender: NUTZER, mid: 'p', modus: 'ki', antwort: 'A'.repeat(3000), probe: true }], refs: { Konfiguration: { cfg } } });
  assert.equal(probe.length, 1);
  assert.deepEqual(await run('Anfrage auswerten', ereignis(cfg, [dm('Hallo', 'p1')])).then((r) => r.length), 1);

  await run('Senden vorbereiten', { input: [{ sender: NUTZER, mid: 'u', modus: 'uebergabe', antwort: cfg.uebergabeText, probe: false }], refs: { Konfiguration: { cfg } } });
  assert.deepEqual(await run('Anfrage auswerten', ereignis(cfg, [dm('Hallo?', 'p2')])), [], 'nach Übergabe schweigt die KI');
});

test('Nach dem Senden: Meldung bei Übergabe und bei Sendefehler, sonst keine', async () => {
  const gesendet = [
    { sender: NUTZER, mid: 'a', text: 'Frage', antwort: 'Antwort', notiz: '' },
    { sender: NUTZER, mid: 'b', text: 'Beschwerde', antwort: 'Fester Text', notiz: 'KI übergibt: Beschwerde' },
    { sender: NUTZER, mid: 'c', text: 'Noch eine', antwort: 'Antwort', notiz: '' },
    { sender: NUTZER, mid: 'c', text: 'Noch eine', antwort: 'Antwort', notiz: '' },
  ];
  const antworten = [{ message_id: '1' }, { message_id: '2' }, { message_id: '3' }, { error: { message: '(#10) Außerhalb des Zeitfensters' } }];
  const out = await run('Nach dem Senden', { input: antworten, refs: { 'Senden vorbereiten': gesendet } });
  assert.equal(out.length, 2);
  assert.equal(out[0].json.titel, 'Instagram-DM: Uebergabe an Mensch');
  assert.match(out[0].json.text, /Beschwerde/);
  assert.equal(out[1].json.prioritaet, 'high');
  assert.match(out[1].json.text, /Außerhalb des Zeitfensters/);
  for (const { json } of out) assert.ok(/^[\x20-\x7e]*$/.test(json.titel), 'ntfy-Titel nur ASCII');
});

test('Workflow: Verbindungen zeigen auf vorhandene Nodes, alles inaktiv bis zur Einrichtung', () => {
  assert.equal(workflow.active, false);
  for (const [von, ziele] of Object.entries(workflow.connections)) {
    assert.ok(nodes[von], `Quelle ${von}`);
    for (const ausgang of ziele.main) for (const z of ausgang) assert.ok(nodes[z.node], `Ziel ${z.node}`);
  }
  assert.equal([...new Set(JSON.stringify(workflow).match(/CHANGE-ME-[A-Z-]+/g))].sort().join(), 'CHANGE-ME-APP-SECRET,CHANGE-ME-IG-USER-ID,CHANGE-ME-VERIFY-TOKEN');
  assert.equal(nodes['Konfiguration'].parameters.jsCode.includes('testModus: true'), true);
});
