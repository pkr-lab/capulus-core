'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadPromptFiles, buildMessages, cleanReply } = require('../lib/prompt');
const { loadConfig } = require('../lib/config');
const { OllamaPcError } = require('../lib/errors');
const { testConfig } = require('./helpers');

const budget = { numCtx: 4096, responseReserveTokens: 512, charsPerToken: 3 };
const prompts = { system: 'SYSTEM', warnings: [] };

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

  const placeholders = loadPromptFiles(
    loadConfig({ OLLAMA_URL: 'http://x:1', OLLAMA_PROMPTS_DIR: path.join(__dirname, '..', 'prompts'), OLLAMA_KNOWLEDGE_DIR: '/nonexistent' }),
  );
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
  assert.ok(system.includes('### Datei: testwissen.md'));
  assert.ok(system.includes('montags bis freitags'));
  assert.ok(system.indexOf('Du schreibst Antworten.') < system.indexOf('<firmenwissen>'));
  assert.ok(system.trim().endsWith('</firmenwissen>'));
  assert.deepEqual(prompts.knowledge.files, ['testwissen.md']);
  const built = buildMessages(prompts, { history: history(2, 10), mail: { text: 'Frage?' } }, budget);
  assert.ok(!built.messages[1].content.includes('firmenwissen'));
});

test('Firmenwissen: alle .md-Dateien sortiert, Platzhalterzeilen entfallen mit Warnung', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-'));
  fs.writeFileSync(path.join(dir, 'b.md'), '## B\n\nPreis: 10 Euro\nLink: [PLATZHALTER: URL]\n');
  fs.writeFileSync(path.join(dir, 'a.md'), '## A\n\nKontakt: info@example.org\n');
  fs.writeFileSync(path.join(dir, 'notiz.txt'), 'wird ignoriert');
  fs.writeFileSync(path.join(dir, 'leer.md'), '[PLATZHALTER: alles]\n');
  const prompts = loadPromptFiles(testConfig({ knowledgeDir: dir }));
  assert.deepEqual(prompts.knowledge.files, ['a.md', 'b.md']);
  assert.ok(prompts.system.indexOf('### Datei: a.md') < prompts.system.indexOf('### Datei: b.md'));
  assert.ok(prompts.system.includes('Preis: 10 Euro'));
  assert.ok(!prompts.system.includes('PLATZHALTER'));
  assert.ok(!prompts.system.includes('wird ignoriert'));
  assert.ok(prompts.warnings.some((w) => w.includes('b.md') && w.includes('1 Zeile')));
});

test('Firmenwissen wird bei jedem Aufruf neu gelesen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-'));
  const file = path.join(dir, 'firma.md');
  fs.writeFileSync(file, 'Preis: 10 Euro\n');
  const config = testConfig({ knowledgeDir: dir });
  assert.ok(loadPromptFiles(config).system.includes('Preis: 10 Euro'));
  fs.writeFileSync(file, 'Preis: 12 Euro\n');
  const second = loadPromptFiles(config).system;
  assert.ok(second.includes('Preis: 12 Euro'));
  assert.ok(!second.includes('Preis: 10 Euro'));
});

test('Firmenwissen: Größe wird gemeldet und ab 40 Prozent von num_ctx gewarnt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-'));
  fs.writeFileSync(path.join(dir, 'gross.md'), 'x'.repeat(21000));
  const warn = loadPromptFiles(testConfig({ knowledgeDir: dir }));
  assert.ok(warn.knowledge.ratio > 0.4);
  assert.ok(warn.warnings.some((w) => w.includes('Firmenwissen belegt') && w.includes('RAG')));

  fs.writeFileSync(path.join(dir, 'gross.md'), 'x'.repeat(3000));
  const ok = loadPromptFiles(testConfig({ knowledgeDir: dir }));
  assert.ok(ok.knowledge.ratio < 0.4);
  assert.ok(!ok.warnings.some((w) => w.includes('Firmenwissen belegt')));
});

test('fehlender Wissensordner ist kein Fehler', () => {
  const prompts = loadPromptFiles(testConfig({ knowledgeDir: '/nonexistent/knowledge' }));
  assert.deepEqual(prompts.knowledge.files, []);
  assert.ok(!prompts.system.includes('firmenwissen'));
});
