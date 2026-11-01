'use strict';

const fs = require('fs');
const path = require('path');
const { OllamaPcError } = require('./errors');

const PLACEHOLDER_MARKER = '[PLATZHALTER';
const SHARED_PROFILE = 'alle';
const PROFILE_PATTERN = /^[a-z0-9_-]+$/;

function isMissing(err) {
  return err.code === 'ENOENT' || err.code === 'ENOTDIR';
}

function listProfiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

function resolveProfiles(dir, profile) {
  if (profile === undefined || profile === null || profile === '' || profile === SHARED_PROFILE) return [SHARED_PROFILE];
  if (typeof profile !== 'string' || !PROFILE_PATTERN.test(profile)) {
    throw new OllamaPcError('INVALID_INPUT', `profile muss aus a-z, 0-9, _ und - bestehen, ist aber ${JSON.stringify(profile)}`);
  }
  const available = listProfiles(dir);
  if (available.length && !available.includes(profile)) {
    throw new OllamaPcError(
      'UNKNOWN_PROFILE',
      `Wissensprofil "${profile}" existiert nicht in ${dir} (vorhanden: ${available.join(', ')})`,
      { profile, available },
    );
  }
  return [SHARED_PROFILE, profile];
}

function loadProfileDir(dir, profile) {
  const profileDir = path.join(dir, profile);
  let names;
  try {
    names = fs.readdirSync(profileDir);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  return names
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort()
    .map((name) => {
      const lines = fs.readFileSync(path.join(profileDir, name), 'utf8').split('\n');
      const kept = lines.filter((line) => !line.includes(PLACEHOLDER_MARKER));
      return { name: `${profile}/${name}`, text: kept.join('\n').trim(), ignoredLines: lines.length - kept.length };
    })
    .filter((file) => file.text);
}

function loadKnowledge(dir, profile) {
  return resolveProfiles(dir, profile).flatMap((name) => loadProfileDir(dir, name));
}

function formatKnowledge(files) {
  if (!files.length) return '';
  const body = files.map((file) => `### Datei: ${file.name}\n\n${file.text}`).join('\n\n');
  return `<firmenwissen>\n${body}\n</firmenwissen>`;
}

module.exports = { loadKnowledge, formatKnowledge, listProfiles, PLACEHOLDER_MARKER, SHARED_PROFILE };
