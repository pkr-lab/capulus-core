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

// Automatisch eingefügt werden nur Links für Kurse ab diesem Jahr. Ältere Kurse (2026) werden bewusst ignoriert.
const MIN_JAHR = 2027;
const CODE_TOKEN = /\b(?:20)?\d{2}-[A-Za-z]{1,4}\d{1,3}\b/g;
const KURS_BEZUG_ALT = /\b(20\d{2})-[A-Za-z0-9]{2,6}\b/g;

function normalizeCode(code) {
  const s = String(code || '').trim().toUpperCase();
  const short = /^(\d{2})-(.+)$/.exec(s);
  return short ? `20${short[1]}-${short[2]}` : s;
}

function entryYear(entry) {
  const fromCode = /^(\d{4}|\d{2})-/.exec(String(entry.code || '').trim());
  if (fromCode) return fromCode[1].length === 2 ? 2000 + Number(fromCode[1]) : Number(fromCode[1]);
  const datum = parseMeldeschluss(entry.meldeschluss);
  return datum ? datum.getFullYear() : null;
}

function codesIn(text, entries) {
  const gefunden = new Set((String(text || '').match(CODE_TOKEN) || []).map(normalizeCode));
  return entries.filter((entry) => gefunden.has(normalizeCode(entry.code)));
}

function altBezug(text) {
  return [...String(text || '').matchAll(KURS_BEZUG_ALT)].filter((m) => Number(m[1]) < MIN_JAHR).map((m) => m[0]);
}

/**
 * Entscheidet, ob für einen [KURSLINK: …]-Hinweis automatisch ein Link eingesetzt werden darf.
 * status 'link'      : Kurs eindeutig, Link in entry.
 * status 'ignoriert' : Kurs aus der Zeit vor MIN_JAHR, nichts einsetzen.
 * status 'unklar'    : Kurs nicht eindeutig, nichts einsetzen (Mensch prüft).
 * context ist der Mailtext samt Verlauf; Kurscodes darin helfen bei der Zuordnung.
 */
function decide(hint, entries, { context = '' } = {}) {
  const eligible = entries.filter((entry) => (entryYear(entry) || 0) >= MIN_JAHR);
  const kursart = detectKursart(hint);

  const perHintCode = codesIn(hint, eligible);
  if (perHintCode.length === 1) return { status: 'link', entry: perHintCode[0], kursart: perHintCode[0].kursart, grund: 'Kurscode im Hinweis' };

  const perDatum = findByKursartUndDatum(hint, eligible, kursart);
  if (perDatum) return { status: 'link', entry: perDatum, kursart: perDatum.kursart, grund: 'Kursart und Meldeschluss im Hinweis' };

  let perMailCode = codesIn(context, eligible);
  if (kursart) perMailCode = perMailCode.filter((entry) => entry.kursart.toLowerCase() === kursart.label.toLowerCase());
  if (perMailCode.length === 1) return { status: 'link', entry: perMailCode[0], kursart: perMailCode[0].kursart, grund: 'Kurscode in der Mail' };
  if (perMailCode.length > 1) {
    return { status: 'unklar', kursart: kursart ? kursart.label : null, grund: `mehrere Kurscodes in der Mail (${perMailCode.map((e) => e.code).join(', ')})` };
  }

  const alt = altBezug(`${hint}\n${context}`);
  if (alt.length) return { status: 'ignoriert', kursart: kursart ? kursart.label : null, grund: `Kurs vor ${MIN_JAHR} (${[...new Set(alt)].join(', ')})` };

  if (!kursart) return { status: 'unklar', kursart: null, grund: 'Kursart nicht erkannt' };
  const gleicheArt = eligible.filter((entry) => entry.kursart.toLowerCase() === kursart.label.toLowerCase());
  if (gleicheArt.length === 1) return { status: 'link', entry: gleicheArt[0], kursart: kursart.label, grund: 'einziger Kurs dieser Art' };
  return { status: 'unklar', kursart: kursart.label, grund: gleicheArt.length ? `${gleicheArt.length} Kurse dieser Art, Kurs nicht genannt` : 'kein Kurs dieser Art ab ' + MIN_JAHR };
}

// Zeilenformat der Pflegeliste knowledge-refs/14_links_kurse:
// "<Kursart> Meldeschluss <TT.MM.JJ> <Kurscode>: <Link>"
function parseLinkList(text) {
  const entries = [];
  const bad = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^(.+?)\s+Meldeschluss\s+(\d{2}\.\d{2}\.(?:\d{2}|\d{4}))\s+(\S+):\s*(https:\/\/\S+)$/.exec(trimmed);
    if (!m) {
      bad.push(trimmed);
      continue;
    }
    entries.push({ code: normalizeCode(m[3]), kursart: m[1].trim(), meldeschluss: m[2], url: m[4] });
  }
  if (bad.length) throw new OllamaPcError('KURSLINKS_INVALID', `Zeile(n) in der Kurslink-Liste nicht lesbar: ${bad.join(' | ')}`);
  return entries;
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

module.exports = { resolve, decide, detectKursart, loadEntries, parseLinkList, normalizeCode, MIN_JAHR, KURSARTEN };
