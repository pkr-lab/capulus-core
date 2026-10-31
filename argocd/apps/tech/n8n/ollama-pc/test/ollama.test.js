'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureReady, ps, stats } = require('../lib/ollama');
const { generateReply } = require('../lib/run');
const { startServer, json, testConfig } = require('./helpers');

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

const chatBody = (overrides = {}) => ({
  message: { role: 'assistant', content: 'Hallo!\n\nViele Grüße' },
  done: true,
  done_reason: 'stop',
  total_duration: 5e9,
  load_duration: 1e9,
  prompt_eval_count: 300,
  prompt_eval_duration: 1e9,
  eval_count: 40,
  eval_duration: 2e9,
  ...overrides,
});

test('ensureReady: PC bereits erreichbar, kein Wake', async () => {
  const server = await startServer((call, res) => json(res, 200, { models: [] }));
  const config = testConfig({ url: server.url });
  const result = await ensureReady(config, { log: () => {} });
  await server.close();
  assert.equal(result.woke, false);
  assert.equal(server.calls[0].url, '/api/tags');
});

test('ensureReady: sendet Wake, pollt mit Backoff und gibt erst bei Antwort frei', async () => {
  let up = 0;
  const server = await startServer((call, res) => {
    up += 1;
    if (up < 5) {
      res.socket.destroy();
      return;
    }
    json(res, 200, { models: [] });
  });
  const relay = await startServer((call, res) => json(res, 200, { status: 'ok' }));
  const clock = fakeClock();
  const sleeps = [];
  const config = testConfig({
    url: server.url,
    wake: { mode: 'http', url: `${relay.url}/wake`, target: 'ollama-pc', token: '', timeoutMs: 2000 },
  });
  const result = await ensureReady(config, { log: () => {}, now: clock.now, sleep: async (ms) => { sleeps.push(ms); await clock.sleep(ms); } });
  await server.close();
  await relay.close();
  assert.equal(result.woke, true);
  assert.equal(relay.calls.length, 1);
  assert.deepEqual(sleeps, [2000, 3000, 4500, 6750]);
});

test('ensureReady: klare Fehlermeldung, wenn der PC nicht aufwacht', async () => {
  const clock = fakeClock();
  const config = testConfig({
    url: 'http://127.0.0.1:1',
    wakeTimeoutMs: 20000,
    wake: { mode: 'none' },
  });
  await assert.rejects(
    ensureReady(config, { log: () => {}, now: clock.now, sleep: clock.sleep }),
    (err) => err.code === 'PC_NOT_WAKING' && /20 s nach dem Wake-Signal/.test(err.message),
  );
  assert.ok(clock.now() >= 20000);
});

test('ensureReady: fehlgeschlagenes Wake-Signal wird als WAKE_FAILED gemeldet', async () => {
  const config = testConfig({ url: 'http://127.0.0.1:1', wake: { mode: 'http', url: '' } });
  await assert.rejects(ensureReady(config, { log: () => {} }), { code: 'WAKE_FAILED' });
});

test('generateReply: lädt das Modell vor dem Chat und nutzt stream=false, num_ctx und Temperatur', async () => {
  const server = await startServer((call, res) => {
    if (call.url === '/api/tags') return json(res, 200, { models: [] });
    if (call.body.messages.length === 0) return json(res, 200, { done: true });
    return json(res, 200, chatBody());
  });
  const config = testConfig({ url: server.url, model: 'gemma3:27b-it-q8_0' });
  const result = await generateReply(config, { history: [], mail: { text: 'Hallo?' } }, { log: () => {} });
  await server.close();

  const chatCalls = server.calls.filter((c) => c.url === '/api/chat');
  assert.equal(chatCalls.length, 2);
  assert.deepEqual(chatCalls[0].body.messages, []);
  assert.equal(chatCalls[0].body.keep_alive, '30m');
  assert.equal(chatCalls[0].body.options.num_ctx, 16384);
  assert.equal(chatCalls[1].body.stream, false);
  assert.equal(chatCalls[1].body.model, 'gemma3:27b-it-q8_0');
  assert.deepEqual(chatCalls[1].body.options, { num_ctx: 16384, temperature: 0.6 });
  assert.equal(chatCalls[1].body.messages[0].role, 'system');
  assert.equal(result.reply, 'Hallo!\n\nViele Grüße');
  assert.equal(result.stats.tokens_per_second, 20);
  assert.equal(result.stats.prompt_eval_duration_ms, 1000);
});

test('generateReply: kürzt den Verlauf erneut, wenn der Prompt das Token-Budget überschritten hat', async () => {
  let chats = 0;
  const server = await startServer((call, res) => {
    if (call.url === '/api/tags') return json(res, 200, { models: [] });
    if (call.body.messages.length === 0) return json(res, 200, { done: true });
    chats += 1;
    return json(res, 200, chatBody({ prompt_eval_count: chats === 1 ? 15000 : 8000 }));
  });
  const config = testConfig({ url: server.url });
  const history = Array.from({ length: 30 }, (_, i) => ({ from: 'a', text: `Mail ${i} ${'x'.repeat(1500)}` }));
  const result = await generateReply(config, { history, mail: { text: 'Hallo?' } }, { log: () => {} });
  await server.close();
  assert.equal(chats, 2);
  const [first, second] = server.calls.filter((c) => c.url === '/api/chat' && c.body.messages.length);
  assert.ok(second.body.messages[1].content.length < first.body.messages[1].content.length);
  assert.ok(result.history_omitted > 0);
});

test('generateReply: Warnung bei abgeschnittener Antwort und Fehler bei leerer Antwort', async () => {
  const server = await startServer((call, res) => {
    if (call.url === '/api/tags') return json(res, 200, { models: [] });
    if (call.body.messages.length === 0) return json(res, 200, { done: true });
    return json(res, 200, call.body.messages[1].content.includes('LEER') ? chatBody({ message: { content: '  ' } }) : chatBody({ done_reason: 'length' }));
  });
  const config = testConfig({ url: server.url });
  const cut = await generateReply(config, { mail: { text: 'Hallo?' } }, { log: () => {} });
  assert.ok(cut.warnings.some((w) => w.includes('abgeschnitten')));
  await assert.rejects(generateReply(config, { mail: { text: 'LEER' } }, { log: () => {} }), { code: 'EMPTY_REPLY' });
  await server.close();
});

test('Fehlerabbildung: fehlendes Modell und Timeout beim Antworten', async () => {
  const missing = await startServer((call, res) => {
    if (call.url === '/api/tags') return json(res, 200, { models: [] });
    return json(res, 404, { error: 'model "nope" not found, try pulling it first' });
  });
  await assert.rejects(generateReply(testConfig({ url: missing.url, model: 'nope' }), { mail: { text: 'x' } }, { log: () => {} }), { code: 'MODEL_MISSING' });
  await missing.close();

  const slow = await startServer((call, res) => {
    if (call.url === '/api/tags') return json(res, 200, { models: [] });
    if (call.body.messages.length === 0) return json(res, 200, { done: true });
    setTimeout(() => json(res, 200, chatBody()), 1500);
  });
  await assert.rejects(
    generateReply(testConfig({ url: slow.url, requestTimeoutMs: 200 }), { mail: { text: 'x' } }, { log: () => {} }),
    { code: 'REQUEST_TIMEOUT' },
  );
  await slow.close();
});

test('ps und stats: GPU-Anteil und Token pro Sekunde', async () => {
  const server = await startServer((call, res) =>
    json(res, 200, { models: [{ name: 'm', size: 100, size_vram: 62, context_length: 16384 }, { name: 'x', size: 0, size_vram: 0 }] }),
  );
  const list = await ps(testConfig({ url: server.url }));
  await server.close();
  assert.equal(list[0].gpu_percent, 62);
  assert.equal(list[1].gpu_percent, 0);
  assert.equal(stats({ eval_count: 100, eval_duration: 4e9 }).tokens_per_second, 25);
  assert.equal(stats({}).tokens_per_second, 0);
});

test('generateReply: ungültige Eingabe wird abgelehnt, bevor der PC angesprochen wird', async () => {
  const server = await startServer((call, res) => json(res, 200, { models: [] }));
  await assert.rejects(generateReply(testConfig({ url: server.url }), { mail: {} }, { log: () => {} }), { code: 'INVALID_INPUT' });
  await server.close();
  assert.equal(server.calls.length, 0);
});
