'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadPromptFiles, buildMessages, channelOf } = require('../lib/prompt');
const { loadConfig } = require('../lib/config');
const { loadKnowledge } = require('../lib/knowledge');
const { OllamaPcError } = require('../lib/errors');

const budget = { numCtx: 8192, responseReserveTokens: 512, charsPerToken: 3 };
const REAL_PROMPTS = path.join(__dirname, '..', 'prompts');
const REAL_KNOWLEDGE = path.join(__dirname, '..', 'knowledge', 'dlrg');

function realConfig() {
  return loadConfig({ OLLAMA_URL: 'http://x:1', OLLAMA_PROMPTS_DIR: REAL_PROMPTS, OLLAMA_KNOWLEDGE_DIR: REAL_KNOWLEDGE });
}

test('channel: ohne Angabe E-Mail, unbekannte Kanäle werden abgelehnt', () => {
  assert.equal(channelOf({}), 'email');
  assert.equal(channelOf({ channel: 'instagram' }), 'instagram');
  assert.throws(() => channelOf({ channel: 'sms' }), (err) => err instanceof OllamaPcError && err.code === 'INVALID_INPUT');
});

test('Instagram: eigener Systemprompt, keine E-Mail-Beispiele, keine E-Mail-Verhaltensregeln', () => {
  const email = loadPromptFiles(realConfig(), { profile: 'ausbildung' });
  const insta = loadPromptFiles(realConfig(), { profile: 'ausbildung', channel: 'instagram' });
  assert.match(insta.system, /Instagram-Direktnachrichten/);
  assert.match(insta.system, /\[ÜBERGABE:/);
  assert.ok(!insta.system.includes('## Beispiel-Antworten'));
  assert.ok(!insta.knowledge.files.includes('alle/00_hinweise_fuer_die_ki.md'));
  assert.ok(insta.knowledge.files.includes('alle/08_kontakt_und_links.md'));
  assert.ok(email.knowledge.files.includes('alle/00_hinweise_fuer_die_ki.md'), 'E-Mail-Kanal lädt die Regeln weiterhin');
  assert.ok(!email.system.includes('Instagram-Direktnachrichten'));
});

test('Instagram: Nutzer-Nachricht spricht von Chat statt E-Mail und endet mit der Ausgabe-Anweisung', () => {
  const built = buildMessages(
    { system: 'SYSTEM', warnings: [] },
    {
      channel: 'instagram',
      history: [{ from: 'DLRG Andernach', date: '2026-11-05 10:00', text: 'Hallo!' }],
      mail: { from: 'Anfragende Person', date: '2026-11-06 09:00', subject: 'ignoriert', text: 'Wann ist Schwimmtraining?' },
    },
    budget,
  );
  const user = built.messages[1].content;
  assert.ok(user.includes('## Bisheriger Chat'));
  assert.ok(user.includes('## Zu beantwortende Instagram-Nachricht\n\nWann ist Schwimmtraining?'));
  assert.ok(!user.includes('E-Mail'));
  assert.ok(!user.includes('Betreff'));
  assert.ok(user.trim().endsWith('ohne Erklärungen.'));
});

test('Wissensdateien lassen sich per exclude ausschließen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-'));
  fs.mkdirSync(path.join(dir, 'alle'));
  fs.writeFileSync(path.join(dir, 'alle', 'a.md'), 'A');
  fs.writeFileSync(path.join(dir, 'alle', 'b.md'), 'B');
  assert.deepEqual(loadKnowledge(dir).map((f) => f.name), ['alle/a.md', 'alle/b.md']);
  assert.deepEqual(loadKnowledge(dir, undefined, { exclude: ['a.md'] }).map((f) => f.name), ['alle/b.md']);
});

test('Instagram: Systemprompt fehlt → SYSTEM_PROMPT_MISSING', () => {
  const config = { ...realConfig(), instagramSystemPromptFile: '/nonexistent/instagram.md' };
  assert.throws(() => loadPromptFiles(config, { channel: 'instagram' }), { code: 'SYSTEM_PROMPT_MISSING' });
});
