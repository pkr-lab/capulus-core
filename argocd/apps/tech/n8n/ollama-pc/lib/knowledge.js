'use strict';

const fs = require('fs');
const path = require('path');

const PLACEHOLDER_MARKER = '[PLATZHALTER';

function loadKnowledge(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
  return names
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort()
    .map((name) => {
      const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n');
      const kept = lines.filter((line) => !line.includes(PLACEHOLDER_MARKER));
      return { name, text: kept.join('\n').trim(), ignoredLines: lines.length - kept.length };
    })
    .filter((file) => file.text);
}

function formatKnowledge(files) {
  if (!files.length) return '';
  const body = files.map((file) => `### Datei: ${file.name}\n\n${file.text}`).join('\n\n');
  return `<firmenwissen>\n${body}\n</firmenwissen>`;
}

module.exports = { loadKnowledge, formatKnowledge, PLACEHOLDER_MARKER };
