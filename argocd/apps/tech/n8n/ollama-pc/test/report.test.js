'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resultsTable, comparison, psTable } = require('../lib/report');

const row = (model, mail, extra = {}) => ({
  model,
  mail,
  gpu_percent: 55,
  wall_ms: 61500,
  stats: { prompt_eval_duration_ms: 4200, prompt_eval_count: 900, eval_count: 120, tokens_per_second: 3.4 },
  warnings: [],
  reply: 'Zeile 1\nZeile | 2',
  ...extra,
});

test('Ergebnistabelle enthält alle geforderten Kennzahlen', () => {
  const table = resultsTable([row('a', 'm1'), row('b', 'm1', { error: 'REQUEST_TIMEOUT: x', stats: undefined })]);
  assert.match(table, /\| a \| m1 \| 55% \| 61.5 \| 4.2 \| 900 \| 120 \| 3.4 \|/);
  assert.match(table, /Fehler: REQUEST_TIMEOUT: x/);
});

test('Vergleichsdatei stellt die Antworten je Mail nebeneinander', () => {
  const md = comparison(['a', 'b'], [{ name: 'm1' }], [row('a', 'm1'), row('b', 'm1', { reply: 'andere' })]);
  assert.match(md, /^## m1/);
  assert.match(md, /\| a \| b \|/);
  assert.match(md, /Zeile 1<br>Zeile \\\| 2 \| andere/);
});

test('ps-Tabelle', () => {
  assert.match(psTable([{ model: 'a', size: 2 * 1024 ** 3, size_vram: 1024 ** 3, gpu_percent: 50, context_length: 16384 }]), /\| a \| 2.0 \| 1.0 \| 50% \| 16384 \|/);
});
