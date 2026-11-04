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

const { decide, parseLinkList, normalizeCode } = require('../lib/kurslinks');
const fs = require('node:fs');

const KURSE = [
  { code: '2027-CK01', kursart: 'CrashKurs', meldeschluss: '31.12.26', url: 'https://example.org/ck01' },
  { code: '2027-CK02', kursart: 'CrashKurs', meldeschluss: '31.01.27', url: 'https://example.org/ck02' },
  { code: '2027-KK01', kursart: 'Kraulkurs', meldeschluss: '31.12.26', url: 'https://example.org/kk01' },
  { code: '2027-PK01', kursart: 'Prüfungskurs', meldeschluss: '31.12.26', url: 'https://example.org/pk01' },
  { code: '2027-PK02', kursart: 'Prüfungskurs', meldeschluss: '31.08.27', url: 'https://example.org/pk02' },
  { code: '2026-CK09', kursart: 'CrashKurs', meldeschluss: '30.11.26', url: 'https://example.org/alt' },
];

test('decide: Kurscode im Hinweis ist eindeutig, auch in Kurzschreibweise', () => {
  assert.equal(decide('2027-CK02', KURSE).entry.code, '2027-CK02');
  assert.equal(decide('CrashKurs 27-ck02', KURSE).entry.code, '2027-CK02');
});

test('decide: Kursart und Meldeschluss im Hinweis sind eindeutig', () => {
  assert.equal(decide('CrashKurs 31.01.27', KURSE).entry.code, '2027-CK02');
});

test('decide: Kurscode aus dem Mailtext hilft, wenn der Hinweis nur die Kursart nennt', () => {
  const result = decide('CrashKurs', KURSE, { context: 'Betreff: Anmeldung 2027-CK01\nWo kann ich hochladen?' });
  assert.equal(result.status, 'link');
  assert.equal(result.entry.code, '2027-CK01');
});

test('decide: Code einer anderen Kursart im Mailtext wird nicht verwendet', () => {
  const result = decide('Kraulkurs', KURSE, { context: 'Kurs 2027-CK01' });
  assert.equal(result.entry.code, '2027-KK01');
});

test('decide: mehrere Kurscodes im Mailtext sind nicht eindeutig', () => {
  const result = decide('CrashKurs', KURSE, { context: '2027-CK01 oder 2027-CK02?' });
  assert.equal(result.status, 'unklar');
  assert.match(result.grund, /mehrere Kurscodes/);
});

test('decide: mehrere Kurse der Art ohne Kursbezug sind unklar', () => {
  assert.equal(decide('CrashKurs', KURSE).status, 'unklar');
  assert.equal(decide('Prüfungskurs', KURSE).status, 'unklar');
});

test('decide: einziger Kurs der Art darf eingesetzt werden', () => {
  assert.equal(decide('Kraulkurs', KURSE).entry.code, '2027-KK01');
});

test('decide: Kurs aus 2026 wird ignoriert, auch wenn die Kursart nur einen 2027er Kurs hat', () => {
  const result = decide('Kraulkurs', KURSE, { context: 'Prüfungskurs DRSA Bronze/Silber 2 (2026-0022)' });
  assert.equal(result.status, 'ignoriert');
});

test('decide: 2026er Eintrag der Liste wird nie eingesetzt', () => {
  const result = decide('2026-CK09', KURSE);
  assert.notEqual(result.status, 'link');
});

test('decide: Kursart nicht erkannt ist unklar', () => {
  assert.equal(decide('irgendwas', KURSE).status, 'unklar');
});

test('parseLinkList liest die Pflegeliste und normalisiert Kurscodes', () => {
  const entries = parseLinkList('#Titel\n\nCrashKurs Meldeschluss 31.01.27 27-CK02: https://example.org/x \nESK Meldeschluss 31.08.2027 2027-ESK02: https://example.org/y\n');
  assert.deepEqual(entries, [
    { code: '2027-CK02', kursart: 'CrashKurs', meldeschluss: '31.01.27', url: 'https://example.org/x' },
    { code: '2027-ESK02', kursart: 'ESK', meldeschluss: '31.08.2027', url: 'https://example.org/y' },
  ]);
  assert.equal(normalizeCode('27-ck02'), '2027-CK02');
});

test('parseLinkList meldet unlesbare Zeilen statt sie still zu verwerfen', () => {
  assert.throws(() => parseLinkList('CrashKurs 31.01.27 2027-CK02 https://example.org'), { code: 'KURSLINKS_INVALID' });
});

test('kurslinks.json entspricht der Pflegeliste 14_links_kurse', () => {
  const refs = path.join(__dirname, '..', 'knowledge-refs');
  const aus = parseLinkList(fs.readFileSync(path.join(refs, '14_links_kurse'), 'utf8'));
  const json = JSON.parse(fs.readFileSync(path.join(refs, 'kurslinks.json'), 'utf8'));
  assert.deepEqual(json, aus, 'node scripts/sync-kurslinks.js ausführen');
});
