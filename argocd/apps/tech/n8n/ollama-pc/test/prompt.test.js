'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadPromptFiles, buildMessages, cleanReply, appendSignature } = require('../lib/prompt');
const { loadConfig } = require('../lib/config');
const { OllamaPcError } = require('../lib/errors');
const { testConfig } = require('./helpers');

const budget = { numCtx: 4096, responseReserveTokens: 512, charsPerToken: 3 };
const prompts = { system: 'SYSTEM', warnings: [] };

function knowledgeDir(profiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-'));
  for (const [profile, files] of Object.entries(profiles)) {
    fs.mkdirSync(path.join(dir, profile));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, profile, name), text);
  }
  return dir;
}

function history(count, size) {
  return Array.from({ length: count }, (_, i) => ({ from: `a${i}`, date: `2026-01-${String(i + 1).padStart(2, '0')}`, text: `Mail ${i} ${'x'.repeat(size)}` }));
}

test('Verlauf bleibt chronologisch und die zu beantwortende Mail steht zuletzt', () => {
  const built = buildMessages(prompts, { context: 'Notiz', history: history(3, 10), mail: { text: 'Frage?' } }, budget);
  const user = built.messages[1].content;
  assert.equal(built.omitted, 0);
  assert.ok(user.indexOf('Zusatzkontext') < user.indexOf('E-Mail-Verlauf'));
  assert.ok(user.indexOf('E-Mail-Verlauf') < user.indexOf('Zu beantwortende E-Mail'));
  assert.ok(user.indexOf('Mail 0') < user.indexOf('Mail 2'));
  assert.ok(user.trim().endsWith('ohne Betreffzeile und ohne Erklärungen.'));
});

test('zu langer Verlauf wird von den ältesten Mails her gekürzt und gemeldet', () => {
  const built = buildMessages(prompts, { history: history(20, 600), mail: { text: 'Frage?' } }, budget);
  const user = built.messages[1].content;
  assert.ok(built.omitted > 0);
  assert.ok(built.keptHistory > 0);
  assert.ok(user.includes('Mail 19'));
  assert.ok(!user.includes('Mail 0 '));
  assert.ok(user.includes(`${built.omitted} ältere E-Mail(s) wurden aus Platzgründen weggelassen`));
  assert.ok(built.warnings.some((w) => w.includes('gekürzt')));
  assert.ok(built.estimatedTokens <= budget.numCtx - budget.responseReserveTokens);
});

test('zu große Pflichtteile führen zu einem Fehler statt stillem Abschneiden', () => {
  const huge = { text: 'y'.repeat(20000) };
  assert.throws(
    () => buildMessages(prompts, { history: [], mail: huge }, budget),
    (err) => err instanceof OllamaPcError && err.code === 'PROMPT_TOO_LARGE',
  );
});

test('ungültige Eingaben werden abgelehnt', () => {
  assert.throws(() => buildMessages(prompts, { mail: { text: '  ' } }, budget), { code: 'INVALID_INPUT' });
  assert.throws(() => buildMessages(prompts, { history: 'x', mail: { text: 'a' } }, budget), { code: 'INVALID_INPUT' });
});

test('Prompt-Dateien: Beispiele fließen in den Systemprompt, Platzhalter nicht', () => {
  const ok = loadPromptFiles(testConfig());
  assert.ok(ok.system.includes('## Beispiel-Antworten'));
  assert.deepEqual(ok.warnings, []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-'));
  fs.mkdirSync(path.join(dir, 'dlrg'));
  fs.writeFileSync(path.join(dir, 'dlrg', 'email_system.md'), 'Du schreibst für [PLATZHALTER: Name].');
  fs.writeFileSync(path.join(dir, 'dlrg', 'email_examples.md'), '### Beispiel 1\n\n[PLATZHALTER: Mail]');
  fs.writeFileSync(path.join(dir, 'dlrg', 'email_signatur.md'), 'Gruß');
  const placeholders = loadPromptFiles(loadConfig({ OLLAMA_URL: 'http://x:1', OLLAMA_PROMPTS_DIR: dir, OLLAMA_KNOWLEDGE_DIR: '/nonexistent' }));
  fs.rmSync(dir, { recursive: true });
  assert.ok(!placeholders.system.includes('## Beispiel-Antworten'));
  assert.equal(placeholders.warnings.length, 2);
});

test('fehlender Systemprompt ist ein Fehler', () => {
  assert.throws(() => loadPromptFiles(testConfig({ systemPromptFile: '/nonexistent/system.md' })), { code: 'SYSTEM_PROMPT_MISSING' });
});

test('cleanReply entfernt eine führende Betreffzeile', () => {
  assert.equal(cleanReply('Betreff: Re: Test\n\nHallo Welt'), 'Hallo Welt');
  assert.equal(cleanReply('  Hallo Welt \n'), 'Hallo Welt');
  assert.equal(cleanReply('Betreff: nur eine Zeile'), 'Betreff: nur eine Zeile');
});

test('Firmenwissen steht als <firmenwissen> zwischen Systemprompt und Beispielen im System-Teil, nicht im Verlauf', () => {
  const prompts = loadPromptFiles(testConfig());
  const system = prompts.system;
  assert.ok(system.includes('<firmenwissen>'));
  assert.ok(system.includes('### Datei: alle/testwissen.md'));
  assert.ok(system.includes('montags bis freitags'));
  assert.ok(system.indexOf('Du schreibst Antworten.') < system.indexOf('<firmenwissen>'));
  assert.ok(system.trim().endsWith('</firmenwissen>'));
  assert.deepEqual(prompts.knowledge.files, ['alle/testwissen.md']);
  const built = buildMessages(prompts, { history: history(2, 10), mail: { text: 'Frage?' } }, budget);
  assert.ok(!built.messages[1].content.includes('firmenwissen'));
});

test('Firmenwissen: alle .md-Dateien sortiert, Platzhalterzeilen entfallen mit Warnung', () => {
  const dir = knowledgeDir({ alle: {} });
  fs.writeFileSync(path.join(dir, 'alle', 'b.md'), '## B\n\nPreis: 10 Euro\nLink: [PLATZHALTER: URL]\n');
  fs.writeFileSync(path.join(dir, 'alle', 'a.md'), '## A\n\nKontakt: info@example.org\n');
  fs.writeFileSync(path.join(dir, 'alle', 'notiz.txt'), 'wird ignoriert');
  fs.writeFileSync(path.join(dir, 'alle', 'leer.md'), '[PLATZHALTER: alles]\n');
  const prompts = loadPromptFiles(testConfig({ knowledgeDir: dir }));
  assert.deepEqual(prompts.knowledge.files, ['alle/a.md', 'alle/b.md']);
  assert.ok(prompts.system.indexOf('### Datei: alle/a.md') < prompts.system.indexOf('### Datei: alle/b.md'));
  assert.ok(prompts.system.includes('Preis: 10 Euro'));
  assert.ok(!prompts.system.includes('PLATZHALTER'));
  assert.ok(!prompts.system.includes('wird ignoriert'));
  assert.ok(prompts.warnings.some((w) => w.includes('alle/b.md') && w.includes('1 Zeile')));
});

test('Firmenwissen wird bei jedem Aufruf neu gelesen', () => {
  const dir = knowledgeDir({ alle: {} });
  const file = path.join(dir, 'alle', 'firma.md');
  fs.writeFileSync(file, 'Preis: 10 Euro\n');
  const config = testConfig({ knowledgeDir: dir });
  assert.ok(loadPromptFiles(config).system.includes('Preis: 10 Euro'));
  fs.writeFileSync(file, 'Preis: 12 Euro\n');
  const second = loadPromptFiles(config).system;
  assert.ok(second.includes('Preis: 12 Euro'));
  assert.ok(!second.includes('Preis: 10 Euro'));
});

test('Firmenwissen: Größe wird gemeldet und ab 40 Prozent von num_ctx gewarnt', () => {
  const dir = knowledgeDir({ alle: {} });
  fs.writeFileSync(path.join(dir, 'alle', 'gross.md'), 'x'.repeat(21000));
  const warn = loadPromptFiles(testConfig({ knowledgeDir: dir }));
  assert.ok(warn.knowledge.ratio > 0.4);
  assert.ok(warn.warnings.some((w) => w.includes('Firmenwissen belegt') && w.includes('RAG')));

  fs.writeFileSync(path.join(dir, 'alle', 'gross.md'), 'x'.repeat(3000));
  const ok = loadPromptFiles(testConfig({ knowledgeDir: dir }));
  assert.ok(ok.knowledge.ratio < 0.4);
  assert.ok(!ok.warnings.some((w) => w.includes('Firmenwissen belegt')));
});

test('fehlender Wissensordner ist kein Fehler', () => {
  const prompts = loadPromptFiles(testConfig({ knowledgeDir: '/nonexistent/knowledge' }));
  assert.deepEqual(prompts.knowledge.files, []);
  assert.ok(!prompts.system.includes('firmenwissen'));
});

test('appendSignature hängt die Signatur an und ersetzt eine vom Modell geschriebene Grußformel', () => {
  const signature = 'Mit freundlichen Grüßen\n\nVerein';
  assert.equal(appendSignature('Hallo!\n\nText.', signature), `Hallo!\n\nText.\n\n${signature}`);
  assert.equal(appendSignature('Hallo!\n\nText.\n\nViele Grüße\nMax', signature), `Hallo!\n\nText.\n\n${signature}`);
  assert.equal(appendSignature('Hallo!\n\nMit freundlichen Grüßen,\n\nDLRG OG', signature), `Hallo!\n\n${signature}`);
  assert.equal(appendSignature('Viele Grüße an alle Kinder sind schön.', signature), `Viele Grüße an alle Kinder sind schön.\n\n${signature}`);
});

test('fehlende Signatur-Datei ist ein Fehler', () => {
  assert.throws(() => loadPromptFiles(testConfig({ signatureFile: '/nonexistent/signatur.md' })), { code: 'SIGNATURE_MISSING' });
});

test('Wissensprofil: Gruppe "alle" plus gewähltes Profil, andere Profile bleiben draußen', () => {
  const dir = knowledgeDir({
    alle: { '00_regeln.md': 'Gemeinsame Regeln' },
    ausbildung: { '02_kurse.md': 'Kurszeiten Dienstag' },
    psg: { '10_hilfe.md': 'Hilfe bei Gewalt' },
  });
  const config = testConfig({ knowledgeDir: dir });

  const ausbildung = loadPromptFiles(config, { profile: 'ausbildung' });
  assert.deepEqual(ausbildung.knowledge.files, ['alle/00_regeln.md', 'ausbildung/02_kurse.md']);
  assert.ok(ausbildung.system.includes('Kurszeiten Dienstag'));
  assert.ok(!ausbildung.system.includes('Hilfe bei Gewalt'));

  const psg = loadPromptFiles(config, { profile: 'psg' });
  assert.deepEqual(psg.knowledge.files, ['alle/00_regeln.md', 'psg/10_hilfe.md']);
  assert.ok(!psg.system.includes('Kurszeiten Dienstag'));
});

test('Wissensprofil: ohne Profil oder mit "alle" gilt nur das gemeinsame Wissen', () => {
  const dir = knowledgeDir({ alle: { 'a.md': 'Gemeinsam' }, ausbildung: { 'b.md': 'Nur Ausbildung' } });
  const config = testConfig({ knowledgeDir: dir });
  assert.deepEqual(loadPromptFiles(config).knowledge.files, ['alle/a.md']);
  assert.deepEqual(loadPromptFiles(config, { profile: '' }).knowledge.files, ['alle/a.md']);
  assert.deepEqual(loadPromptFiles(config, { profile: 'alle' }).knowledge.files, ['alle/a.md']);
});

test('Wissensprofil: unbekanntes oder ungültiges Profil ist ein Fehler', () => {
  const dir = knowledgeDir({ alle: { 'a.md': 'Gemeinsam' }, ausbildung: { 'b.md': 'Nur Ausbildung' } });
  const config = testConfig({ knowledgeDir: dir });
  assert.throws(() => loadPromptFiles(config, { profile: 'persoenlich' }), { code: 'UNKNOWN_PROFILE', message: /ausbildung/ });
  assert.throws(() => loadPromptFiles(config, { profile: '../etc' }), { code: 'INVALID_INPUT' });
  assert.throws(() => loadPromptFiles(config, { profile: 42 }), { code: 'INVALID_INPUT' });
});

test('Wissensprofil: Größenwarnung zählt nur das gewählte Profil', () => {
  const dir = knowledgeDir({ alle: { 'a.md': 'klein' }, ausbildung: { 'gross.md': 'x'.repeat(21000) }, psg: { 'p.md': 'klein' } });
  const config = testConfig({ knowledgeDir: dir });
  assert.ok(loadPromptFiles(config, { profile: 'ausbildung' }).knowledge.ratio > 0.4);
  assert.ok(loadPromptFiles(config, { profile: 'psg' }).knowledge.ratio < 0.4);
});
