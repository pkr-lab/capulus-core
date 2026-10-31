#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./lib/config');
const { isUp, ps, ensureReady } = require('./lib/ollama');
const { generateReply } = require('./lib/run');
const { OllamaPcError } = require('./lib/errors');

function log(message) {
  process.stderr.write(`[ollama-pc] ${message}\n`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(argv) {
  const command = argv[2];
  const config = loadConfig();

  if (command === 'probe') {
    print({ ok: true, up: await isUp(config) });
    return;
  }
  if (command === 'ps') {
    print({ ok: true, models: await ps(config) });
    return;
  }
  if (command === 'wake') {
    print({ ok: true, ...(await ensureReady(config, { log })) });
    return;
  }
  if (command === 'chat') {
    const raw = await readStdin();
    let input;
    try {
      input = JSON.parse(raw);
    } catch (err) {
      throw new OllamaPcError('INVALID_INPUT', `stdin ist kein gültiges JSON: ${err.message}`);
    }
    print({ ok: true, ...(await generateReply(config, input, { log })) });
    return;
  }
  throw new OllamaPcError('USAGE', 'Aufruf: cli.js probe | ps | wake | chat (JSON auf stdin)');
}

main(process.argv).catch((err) => {
  const code = err instanceof OllamaPcError ? err.code : 'UNEXPECTED';
  log(`${code}: ${err.message}`);
  print({ ok: false, error: { code, message: err.message } });
  process.exitCode = 1;
});
