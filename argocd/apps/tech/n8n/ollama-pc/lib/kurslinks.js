'use strict';

const fs = require('fs');
const { OllamaPcError } = require('./errors');

const KURSARTEN = [
  { label: 'Prüfungskurs', aliases: ['prüfungskurs', 'pruefungskurs', 'drs b', 'bronze', 'silber'] },
  { label: 'Kraulkurs', aliases: ['kraulkurs', 'kraul'] },
  { label: 'ESK', aliases: ['esk', 'erwachsenenschwimmkurs', 'erwachsenen-schwimmkurs', 'erwachsenenschwimmer'] },
  { label: 'CrashKurs', aliases: ['crashkurs', 'crash kurs', 'crash'] },
];

function detectKursart(text) {
  const lower = String(text || '').toLowerCase();
  return KURSARTEN.find((kursart) => kursart.aliases.some((alias) => lower.includes(alias))) || null;
}

function parseMeldeschluss(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [, day, month, yearRaw] = match;
  const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
  const date = new Date(year, Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function findByCode(hint, entries) {
  const lower = String(hint || '').toLowerCase();
  return entries.find((entry) => entry.code && lower.includes(String(entry.code).toLowerCase())) || null;
}

function findByKursartUndDatum(hint, entries, kursart) {
  const dateMatch = /\d{2}\.\d{2}\.(?:\d{2}|\d{4})/.exec(String(hint || ''));
  if (!kursart || !dateMatch) return null;
  const gesucht = parseMeldeschluss(dateMatch[0]);
  if (!gesucht) return null;
  return (
    entries.find((entry) => {
      if (String(entry.kursart || '').toLowerCase() !== kursart.label.toLowerCase()) return false;
      const datum = parseMeldeschluss(entry.meldeschluss);
      return datum && datum.getTime() === gesucht.getTime();
    }) || null
  );
}

function resolve(hint, entries, { now = new Date() } = {}) {
  const perCode = findByCode(hint, entries);
  if (perCode) return { kursart: perCode.kursart, matches: [perCode] };

  const kursart = detectKursart(hint);

  const perDatum = findByKursartUndDatum(hint, entries, kursart);
  if (perDatum) return { kursart: kursart.label, matches: [perDatum] };

  if (!kursart) return { kursart: null, matches: [] };

  const matches = entries
    .filter((entry) => String(entry.kursart || '').toLowerCase() === kursart.label.toLowerCase())
    .map((entry) => ({ ...entry, meldeschlussDatum: parseMeldeschluss(entry.meldeschluss) }))
    .sort((a, b) => {
      const aUpcoming = Boolean(a.meldeschlussDatum && a.meldeschlussDatum >= now);
      const bUpcoming = Boolean(b.meldeschlussDatum && b.meldeschlussDatum >= now);
      if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
      if (!a.meldeschlussDatum || !b.meldeschlussDatum) return 0;
      return a.meldeschlussDatum - b.meldeschlussDatum;
    })
    .map(({ meldeschlussDatum, ...entry }) => entry);

  return { kursart: kursart.label, matches };
}

function loadEntries(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new OllamaPcError('KURSLINKS_MISSING', `Kurslink-Datei fehlt: ${file}`);
    throw err;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new OllamaPcError('KURSLINKS_INVALID', `Kurslink-Datei ${file} ist kein gültiges JSON: ${err.message}`);
  }
  if (!Array.isArray(data)) {
    throw new OllamaPcError('KURSLINKS_INVALID', `Kurslink-Datei ${file} muss ein JSON-Array sein`);
  }
  return data;
}

module.exports = { resolve, detectKursart, loadEntries, KURSARTEN };
