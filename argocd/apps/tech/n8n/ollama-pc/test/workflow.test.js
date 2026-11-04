'use strict';

// Führt den Code der n8n-Nodes aus workflows/zammad-tickets-verarbeiten.json mit Testdaten aus.
// So fallen Fehler im Zusammenspiel der Nodes auf, nicht erst im laufenden Workflow.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKFLOW = path.join(__dirname, '..', '..', 'workflows', 'zammad-tickets-verarbeiten.json');
const workflow = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
const nodes = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

function run(name, { json = {}, input = [], refs = {}, tickets = '' } = {}) {
  const alle = { 'Von Haupt-Workflow aufgerufen': { tickets }, ...refs };
  const $ = (ref) => {
    if (!(ref in alle)) throw new Error(`Node "${ref}" ist im Test nicht belegt`);
    return { item: { json: alle[ref] }, first: () => ({ json: alle[ref] }) };
  };
  const $input = { all: () => input.map((j) => ({ json: j })) };
  const fn = new Function('$', '$json', '$input', 'Buffer', 'console', nodes[name].parameters.jsCode);
  return fn($, json, $input, Buffer, { log() {} });
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const ticket = { id: 7, number: '10042', title: 'Upload', group_id: 2, owner_id: 5, state_id: 1 };
const payload = {
  context: '',
  history: [{ from: 'Team', date: '2026-10-28 13:12', text: 'Prüfungskurs 2027-CK03: bitte Nachweise hochladen' }],
  mail: { from: 'Lena Fischer <lena@example.org>', date: '2026-11-04 08:10', subject: 'Re: Crashkurs', text: 'Wo kann ich hochladen?' },
};
const eingabe = { ticket, modus: 'entwurf', replyTo: 'lena@example.org', messageId: 'm1', payloadB64: b64(payload) };
const ollama = (reply) => ({ stdout: `${JSON.stringify({ ok: true, reply, warnings: [], stats: {} })}\n` });

const ANTWORT = [
  '[INTERN: Upload-Status prüfen]',
  'Guten Tag Lena Fischer,',
  'vielen Dank für Ihre Nachricht.',
  'Den Upload-Link finden Sie hier:',
  '[KURSLINK: CrashKurs]',
].join('\n');

function extrahieren(reply = ANTWORT, g = ticket) {
  return run('Antwortentwurf extrahieren', { json: ollama(reply), refs: { 'LLM-Eingabe bauen': { ...eingabe, ticket: g } } }).json;
}

function einfuegen(basis, results) {
  const stdout = results === null ? 'kaputt' : JSON.stringify({ ok: true, results });
  return run('Kurslinks in Entwurf einfügen', { json: { stdout }, refs: { 'Antwortentwurf extrahieren': basis } }).json;
}

test('LLM-Eingabe: Ausbildung lädt nur das Profil "ausbildung", andere Gruppen kein Profil', () => {
  const art = [{ id: 1, sender: 'Customer', internal: false, body: 'Hallo', content_type: 'text/plain', from: 'a@b.de', created_at: '2026-11-03T10:00:00Z', message_id: 'm', reply_to: 'a@b.de' }];
  const lesen = (group) => {
    const out = run('LLM-Eingabe bauen', { input: [{ ...ticket, group_id: group, articles: art }] });
    return JSON.parse(Buffer.from(out[0].json.payloadB64, 'base64').toString('utf8'));
  };
  assert.equal(lesen(2).profile, 'ausbildung');
  assert.equal(lesen(5).profile, undefined);
});

test('Entwurf: [KURSLINK] bleibt im Text, Hinweis und Mailkontext gehen an die Nachschlage-Stufe', () => {
  const e = extrahieren();
  assert.deepEqual(e.kurslinkHinweise, ['CrashKurs']);
  assert.ok(e.entwurf.includes('[KURSLINK: CrashKurs]'));
  assert.ok(e.entwurfHtml.includes('[KURSLINK: CrashKurs]'));
  assert.deepEqual(e.hinweise, ['Upload-Status prüfen']);
  const stdin = JSON.parse(Buffer.from(e.kurslinkHinweiseB64, 'base64').toString('utf8'));
  assert.deepEqual(stdin.hints, ['CrashKurs']);
  assert.match(stdin.context, /2027-CK03/);
});

test('Entwurf: Leerzeile nach Anrede und Dank, Signatur zeilenweise mit Namen der Ausbildung', () => {
  const e = extrahieren();
  assert.match(e.entwurf, /^Guten Tag Lena Fischer,\n\nvielen Dank für Ihre Nachricht\.\n\nDen Upload-Link/);
  assert.ok(e.entwurfHtml.includes('<div>Mit freundlichen Grüßen</div><div><br></div><div>Daniela Saxer</div>'));
  assert.ok(!e.entwurfHtml.includes('DLRG OG Andernach e.V.</div><div><br></div><div>--'));
  const andere = extrahieren(ANTWORT, { ...ticket, group_id: 5 });
  assert.ok(andere.entwurf.includes('DLRG OG Andernach e.V.'));
});

test('Entwurf: Ollama-Fehler wirft nicht, sondern liefert ein Fehler-Item', () => {
  const out = run('Antwortentwurf extrahieren', {
    json: { stdout: '{"ok":false,"error":{"code":"OLLAMA_DOWN","message":"nicht erreichbar"}}', stderr: '' },
    refs: { 'LLM-Eingabe bauen': eingabe },
  }).json;
  assert.match(out.fehler, /Ticket #10042.*OLLAMA_DOWN: nicht erreichbar/);
  assert.equal(out.ticket.number, '10042');
});

test('Kurslink: eindeutiger Kurs wird in Text und HTML eingesetzt', () => {
  const entry = { code: '2027-CK03', kursart: 'CrashKurs', url: 'https://example.org/ck03?a=1&b=2' };
  const out = einfuegen(extrahieren(), [{ status: 'link', entry, grund: 'Kurscode in der Mail' }]);
  assert.ok(out.entwurf.includes('\nhttps://example.org/ck03?a=1&b=2\n'));
  assert.ok(out.entwurfHtml.includes('<a href="https://example.org/ck03?a=1&amp;b=2">'));
  assert.ok(!out.entwurf.includes('KURSLINK'));
  assert.ok(!out.entwurfHtml.includes('KURSLINK'));
  assert.ok(!out.notizHtml.includes('KURSLINK'));
  assert.match(out.hinweiseHtml, /automatisch eingefügt: CrashKurs 2027-CK03/);
});

test('Kurslink: 2026 und unklare Kurse bekommen nie einen Link, sondern [BITTE PRÜFEN]', () => {
  const alt = einfuegen(extrahieren(), [{ status: 'ignoriert', kursart: 'Prüfungskurs', grund: 'Kurs vor 2027 (2026-0022)' }]);
  assert.match(alt.entwurf, /\[BITTE PRÜFEN: Upload-Link für Prüfungskurs von Hand einfügen/);
  assert.ok(!alt.entwurf.includes('sharepoint'));
  const unklar = einfuegen(extrahieren(), [{ status: 'unklar', kursart: 'CrashKurs', grund: '7 Kurse dieser Art, Kurs nicht genannt' }]);
  assert.match(unklar.entwurf, /\[BITTE PRÜFEN: Upload-Link für CrashKurs: Kurs nicht eindeutig\]/);
  assert.match(unklar.hinweiseHtml, /nicht eindeutig/);
});

test('Kurslink: fehlgeschlagene oder veraltete Nachschlage-Antwort führt nie zu einem geratenen Link', () => {
  for (const results of [null, [{ matches: [{ url: 'https://example.org/alt' }] }], []]) {
    const out = einfuegen(extrahieren(), results);
    assert.match(out.entwurf, /\[BITTE PRÜFEN: Upload-Link für CrashKurs\]/);
    assert.ok(!out.entwurf.includes('example.org'));
  }
});

test('Kurslink-Stufe und cli.js kurslink arbeiten zusammen (echte Kurslink-Liste)', () => {
  const cli = path.join(__dirname, '..', 'cli.js');
  const aufruf = (input) => JSON.parse(spawnSync('node', [cli, 'kurslink'], { input: JSON.stringify(input), env: { ...process.env, OLLAMA_URL: 'http://127.0.0.1:1' }, encoding: 'utf8' }).stdout);

  const ok = aufruf({ hints: ['CrashKurs'], context: 'Anmeldung 2027-CK03' });
  assert.equal(ok.results[0].status, 'link');
  assert.equal(ok.results[0].entry.code, '2027-CK03');

  const alt = aufruf({ hints: ['Prüfungskurs'], context: 'Prüfungskurs DRSA Bronze/Silber 2 (2026-0022)' });
  assert.equal(alt.results[0].status, 'ignoriert');

  const unklar = aufruf({ hints: ['CrashKurs'], context: '' });
  assert.equal(unklar.results[0].status, 'unklar');

  const altesFormat = aufruf(['2027-CK02']);
  assert.equal(altesFormat.results[0].entry.code, '2027-CK02');
});

test('Fehlerhandling: Ollama- und Zammad-Fehler laufen in den Fehler-Push', () => {
  const ziele = (name, ausgang) => (workflow.connections[name].main[ausgang] || []).map((c) => c.node);
  assert.deepEqual(ziele('Antwortentwurf extrahieren', 0), ['Ollama-Fehler?']);
  assert.deepEqual(ziele('Ollama-Fehler?', 0), ['Fehler-Push senden']);
  assert.deepEqual(ziele('Ollama-Fehler?', 1), ['Kurslink-Hinweise vorhanden?']);
  for (const name of ['Entwurf als interne Notiz speichern', 'Interne Hinweise als Notiz speichern']) {
    assert.equal(nodes[name].onError, 'continueErrorOutput', name);
    assert.deepEqual(ziele(name, 1), ['Fehler-Push senden'], name);
  }
  assert.deepEqual(ziele('Fehler-Push senden', 0), ['Abschluss (immer genau 1 Item)']);
});

test('Workflow: alle Verbindungen zeigen auf vorhandene Nodes', () => {
  for (const [von, ziel] of Object.entries(workflow.connections)) {
    assert.ok(nodes[von], `Quelle ${von}`);
    for (const ausgang of ziel.main) for (const c of ausgang) assert.ok(nodes[c.node], `Ziel ${c.node}`);
  }
});

const formular = JSON.parse(fs.readFileSync(path.join(WORKFLOW, '..', 'zammad-ki-neu-formular.json'), 'utf8'));
const formNodes = Object.fromEntries(formular.nodes.map((n) => [n.name, n]));

function artikel(extra) {
  return { sender: 'Customer', internal: false, content_type: 'text/plain', from: 'k@example.org', created_at: '2026-11-01T10:00:00Z', ...extra };
}
const ARTIKEL = [
  artikel({ id: 1, body: 'Wo kann ich hochladen?', message_id: 'm1' }),
  artikel({ id: 2, sender: 'Agent', body: 'Hier der Link', created_at: '2026-11-02T10:00:00Z' }),
  artikel({ id: 3, sender: 'Agent', internal: true, body: 'Entwurf ... ID-IT-xi8klGKdh8', created_at: '2026-11-02T11:00:00Z' }),
];

test('Nur relevante Tickets: ohne Formular gilt der normale Filter', () => {
  const input = [
    { number: '1', owner_id: 5, state_id: 1, group_id: 9 },
    { number: '2', owner_id: 9, state_id: 4, group_id: 9 },
  ];
  assert.deepEqual(run('Nur relevante Tickets', { input }).map((i) => i.json.number), ['1']);
});

test('Nur relevante Tickets: Formular holt genau die genannten Tickets, auch geschlossene', () => {
  const input = [
    { number: '1', owner_id: 5, state_id: 1, group_id: 9 },
    { number: '2', owner_id: 9, state_id: 4, group_id: 9 },
  ];
  assert.deepEqual(run('Nur relevante Tickets', { input, tickets: '2,77' }).map((i) => i.json.number), ['2']);
  assert.throws(() => run('Nur relevante Tickets', { input, tickets: '77' }), /Keines der angeforderten Tickets gefunden: 77/);
});

test('LLM-Eingabe: ohne Formular wird ein beantwortetes Ticket übersprungen, mit Formular neu bearbeitet', () => {
  const input = [{ ...ticket, articles: ARTIKEL }];
  assert.equal(run('LLM-Eingabe bauen', { input }).length, 0);
  const neu = run('LLM-Eingabe bauen', { input, tickets: '10042' });
  assert.equal(neu.length, 1);
  assert.equal(neu[0].json.erzwungen, true);
  const nutzlast = JSON.parse(Buffer.from(neu[0].json.payloadB64, 'base64').toString('utf8'));
  assert.equal(nutzlast.mail.text, 'Wo kann ich hochladen?');
});

test('LLM-Eingabe: andere Tickets bleiben beim Formular-Lauf unberührt', () => {
  const input = [{ ...ticket, articles: ARTIKEL }];
  assert.equal(run('LLM-Eingabe bauen', { input, tickets: '99999' }).length, 0);
});

test('Shared Draft: ein vorhandener Entwurf stoppt nur normale, nicht erzwungene Läufe', () => {
  const bedingung = nodes['Kein Shared Draft vorhanden?'].parameters.conditions.conditions[0].leftValue;
  assert.match(bedingung, /erzwungen === true/);
  assert.match(bedingung, /!\$json\.shared_draft_id/);
});

test('Formular: Ticketnummern werden bereinigt, Dubletten und Unsinn fallen weg', () => {
  const pruefen = (text) => new Function('$json', formNodes['Ticketnummern prüfen'].parameters.jsCode)({ Ticketnummern: text })[0].json;
  assert.deepEqual(pruefen('#10042, 10043\n10042 abc 7'), { tickets: '10042,10043', anzahl: 2 });
  assert.deepEqual(pruefen('keine nummer'), { tickets: '', anzahl: 0 });
});

test('Formular: ohne gültige Nummer startet nichts, mit Nummer läuft der Sub-Workflow ohne Warten', () => {
  const ziele = (name, ausgang) => formular.connections[name].main[ausgang].map((c) => c.node);
  assert.deepEqual(ziele('Tickets angegeben?', 0), ['Zammad Tickets verarbeiten']);
  assert.deepEqual(ziele('Tickets angegeben?', 1), ['Abschluss Fehler']);
  assert.equal(formNodes['Zammad Tickets verarbeiten'].parameters.options.waitForSubWorkflow, false);
  assert.equal(formNodes['Zammad Tickets verarbeiten'].parameters.workflowId.value, workflow.id);
  assert.equal(formNodes['Formular KI neu'].parameters.authentication, 'basicAuth');
  assert.equal(formular.active, false);
});

test('Benachrichtigungsmail: Ticket, Link und Antwort ohne Signatur, letzte Zeile ist die ID', () => {
  const basis = extrahieren();
  const fertig = einfuegen(basis, [{ status: 'link', entry: { kursart: 'CrashKurs', code: '2027-CK03', url: 'https://upload.example/ck03' }, grund: 'Kurscode genannt' }]);
  const mail = run('KI-Mail bauen', { refs: { 'Kurslinks in Entwurf einfügen': fertig } }).json;
  assert.equal(mail.mailAn, 'peter.kretzer@dlrg.org');
  assert.equal(mail.betreff, 'KI-Antwort zu Ticket #10042: Upload');
  assert.match(mail.text, /Link: https:\/\/ticket\.emue365\.de\/#ticket\/zoom\/7\n/);
  assert.match(mail.text, /Ablage: Mail-Entwurf zur Freigabe in Zammad/);
  assert.ok(mail.text.includes('https://upload.example/ck03'));
  assert.ok(!mail.text.includes('Mit freundlichen Grüßen'));
  assert.ok(!mail.text.includes('Balthasar-Neumann'));
  assert.match(mail.text, /Interne Hinweise:\n- Upload-Status prüfen/);
  assert.equal(mail.text.split('\n').pop(), 'ID-IT-xi8klGKdh8');
  assert.equal(mail.text.split('ID-IT-xi8klGKdh8').length, 2);
});

test('Benachrichtigungsmail: Tickets anderer Besitzer werden als interne Notiz gemeldet', () => {
  const fertig = einfuegen(extrahieren(), []);
  const mail = run('KI-Mail bauen', { refs: { 'Kurslinks in Entwurf einfügen': { ...fertig, modus: 'notiz' } } }).json;
  assert.match(mail.text, /Ablage: Interne Notiz in Zammad/);
});

test('Benachrichtigungsmail: sitzt vor dem Push, fängt Fehler ab und lässt Abschluss unverändert', () => {
  const ziele = (name) => workflow.connections[name].main.flatMap((gruppe) => gruppe.map((c) => c.node));
  assert.deepEqual(ziele('Interne Hinweise vorhanden?'), ['Interne Hinweise als Notiz speichern', 'KI-Mail bauen']);
  assert.ok(ziele('Interne Hinweise als Notiz speichern').includes('KI-Mail bauen'));
  assert.deepEqual(ziele('KI-Mail bauen'), ['KI-Mail senden']);
  assert.deepEqual(ziele('KI-Mail senden'), ['Freigabe-Push senden']);
  assert.equal(nodes['KI-Mail senden'].onError, 'continueRegularOutput');
  assert.equal(nodes['KI-Mail senden'].parameters.emailFormat, 'text');
  const zuPush = Object.entries(workflow.connections).filter(([, c]) => c.main.some((g) => g.some((v) => v.node === 'Freigabe-Push senden'))).map(([name]) => name);
  assert.deepEqual(zuPush, ['KI-Mail senden']);
});
