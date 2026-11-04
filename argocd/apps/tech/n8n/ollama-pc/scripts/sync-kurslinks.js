#!/usr/bin/env node
'use strict';

// Erzeugt knowledge-refs/kurslinks.json aus der Pflegeliste knowledge-refs/14_links_kurse.
// Aufruf: node scripts/sync-kurslinks.js          (schreibt die JSON-Datei)
//         node scripts/sync-kurslinks.js --check  (Exit 1, wenn die JSON-Datei nicht zur Liste passt)

const fs = require('fs');
const path = require('path');
const { parseLinkList } = require('../lib/kurslinks');

const refs = path.join(__dirname, '..', 'knowledge-refs');
const source = path.join(refs, '14_links_kurse');
const target = path.join(refs, 'kurslinks.json');

const json = `${JSON.stringify(parseLinkList(fs.readFileSync(source, 'utf8')), null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== json) {
    process.stderr.write('kurslinks.json passt nicht zu 14_links_kurse: node scripts/sync-kurslinks.js ausführen\n');
    process.exit(1);
  }
  process.stdout.write('kurslinks.json ist aktuell\n');
} else {
  fs.writeFileSync(target, json);
  process.stdout.write(`${JSON.parse(json).length} Einträge nach kurslinks.json geschrieben\n`);
}
