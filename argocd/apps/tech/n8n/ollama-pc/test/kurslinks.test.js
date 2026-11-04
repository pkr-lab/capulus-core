'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolve, detectKursart, loadEntries } = require('../lib/kurslinks');

const ENTRIES = [
  { code: 'A-01', kursart: 'CrashKurs', meldeschluss: '31.01.26', url: 'https://example.org/a-01' },
  { code: 'A-02', kursart: 'CrashKurs', meldeschluss: '31.03.26', url: 'https://example.org/a-02' },
  { code: 'A-00', kursart: 'CrashKurs', meldeschluss: '01.01.20', url: 'https://example.org/a-00' },
  { code: 'B-01', kursart: 'Kraulkurs', meldeschluss: '15.02.26', url: 'https://example.org/b-01' },
  { code: 'C-01', kursart: 'CrashKurs', meldeschluss: 'kaputtes-datum', url: 'https://example.org/c-01' },
];
const NOW = new Date(2026, 0, 1);

test('erkennt Kursart über verschiedene Schreibweisen', () => {
  assert.equal(detectKursart('Bitte Crashkurs-Ordner prüfen')?.label, 'CrashKurs');
  assert.equal(detectKursart('Frage zum Kraulkurs')?.label, 'Kraulkurs');
  assert.equal(detectKursart('ESK Teilnehmerin meldet sich')?.label, 'ESK');
  assert.equal(detectKursart('Erwachsenenschwimmkurs Rückfrage')?.label, 'ESK');
  assert.equal(detectKursart('Prüfungskurs Bronze/Silber')?.label, 'Prüfungskurs');
  assert.equal(detectKursart('Allgemeine Frage ohne Kursbezug'), null);
});

test('liefert nur Einträge der erkannten Kursart', () => {
  const { kursart, matches } = resolve('CrashKurs-Admin-Ordner benötigt', ENTRIES, { now: NOW });
  assert.equal(kursart, 'CrashKurs');
  assert.deepEqual(matches.map((m) => m.code).sort(), ['A-00', 'A-01', 'A-02', 'C-01']);
});

test('sortiert anstehende Meldeschlüsse vor vergangenen und vor unklaren Daten', () => {
  const { matches } = resolve('CrashKurs', ENTRIES, { now: NOW });
  assert.equal(matches[0].code, 'A-01');
  assert.equal(matches[1].code, 'A-02');
  assert.ok(['A-00', 'C-01'].includes(matches[2].code));
  assert.ok(['A-00', 'C-01'].includes(matches[3].code));
});

test('kein Treffer ohne erkannte Kursart', () => {
  const result = resolve('Allgemeine Frage ohne Kursbezug', ENTRIES, { now: NOW });
  assert.equal(result.kursart, null);
  assert.deepEqual(result.matches, []);
});

test('exakter Treffer über den Kurscode, auch bei mehreren Kandidaten der Kursart', () => {
  const { kursart, matches } = resolve('Bitte Ordner für A-02 pruefen', ENTRIES, { now: NOW });
  assert.equal(kursart, 'CrashKurs');
  assert.deepEqual(matches.map((m) => m.code), ['A-02']);
});

test('exakter Treffer über Kursart + genanntes Meldeschluss-Datum', () => {
  const { kursart, matches } = resolve('CrashKurs, Meldeschluss 31.03.26', ENTRIES, { now: NOW });
  assert.equal(kursart, 'CrashKurs');
  assert.deepEqual(matches.map((m) => m.code), ['A-02']);
});

test('Datum ohne passende Kursart führt nicht zu einem Treffer', () => {
  const { matches } = resolve('Meldeschluss 31.03.26', ENTRIES, { now: NOW });
  assert.deepEqual(matches, []);
});

test('loadEntries liest die echte Kurslink-Datei des Projekts', () => {
  const entries = loadEntries(path.join(__dirname, '..', 'knowledge-refs', 'kurslinks.json'));
  assert.ok(Array.isArray(entries) && entries.length > 0);
  for (const entry of entries) {
    assert.equal(typeof entry.code, 'string');
    assert.equal(typeof entry.kursart, 'string');
    assert.equal(typeof entry.meldeschluss, 'string');
    assert.match(entry.url, /^https:\/\//);
  }
});

test('loadEntries meldet fehlende Datei als OllamaPcError', () => {
  assert.throws(() => loadEntries(path.join(__dirname, 'does-not-exist.json')), { code: 'KURSLINKS_MISSING' });
});
