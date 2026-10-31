'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../lib/config');

test('Standardwerte', () => {
  const c = loadConfig({ OLLAMA_URL: 'http://pc:11434/' });
  assert.equal(c.url, 'http://pc:11434');
  assert.equal(c.model, 'gemma3:27b-it-q8_0');
  assert.equal(c.numCtx, 16384);
  assert.equal(c.temperature, 0.6);
  assert.equal(c.requestTimeoutMs, 1200 * 1000);
  assert.equal(c.wakeTimeoutMs, 120 * 1000);
  assert.equal(c.healthTimeoutMs, 3000);
  assert.equal(c.wake.mode, 'udp');
  assert.equal(c.wake.port, 9);
});

test('Env-Variablen überschreiben die Standardwerte', () => {
  const c = loadConfig({
    OLLAMA_URL: 'http://pc:11434',
    OLLAMA_MODEL: 'llama3.3:70b',
    OLLAMA_NUM_CTX: '8192',
    OLLAMA_REQUEST_TIMEOUT_SECONDS: '60',
    OLLAMA_WAKE_MODE: 'http',
  });
  assert.equal(c.model, 'llama3.3:70b');
  assert.equal(c.numCtx, 8192);
  assert.equal(c.requestTimeoutMs, 60000);
  assert.equal(c.wake.mode, 'http');
});

test('fehlende URL, ungültiger Wake-Modus und ungültige Zahlen sind Fehler', () => {
  assert.throws(() => loadConfig({}), /OLLAMA_URL/);
  assert.throws(() => loadConfig({ OLLAMA_URL: 'http://x', OLLAMA_WAKE_MODE: 'smoke' }), /OLLAMA_WAKE_MODE/);
  assert.throws(() => loadConfig({ OLLAMA_URL: 'http://x', OLLAMA_NUM_CTX: 'abc' }), /OLLAMA_NUM_CTX/);
});
