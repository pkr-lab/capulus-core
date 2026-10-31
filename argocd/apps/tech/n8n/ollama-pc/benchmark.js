#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./lib/config');
const { ensureReady, preload, unload, ps } = require('./lib/ollama');
const { generateReply } = require('./lib/run');
const { loadPromptFiles } = require('./lib/prompt');
const { resultsTable, psTable, comparison } = require('./lib/report');

const DEFAULT_MODELS = 'gemma3:27b-it-q8_0,llama3.3:70b';

function log(message) {
  process.stderr.write(`[benchmark] ${message}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--') || argv[i + 1] === undefined) {
      throw new Error('Aufruf: benchmark.js [--models a,b] [--emails <Ordner>] [--out <Ordner>]');
    }
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

function loadMails(dir) {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ name: path.basename(file, '.json'), input: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) }));
}

async function unloadOthers(config, keep) {
  for (const running of await ps(config)) {
    if (running.name !== keep) {
      log(`Entlade ${running.name}`);
      await unload(config, running.name);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const models = (args.models || process.env.OLLAMA_BENCH_MODELS || DEFAULT_MODELS).split(',').map((m) => m.trim()).filter(Boolean);
  const emailsDir = args.emails || path.join(__dirname, 'testdata', 'emails');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.out || path.join(process.cwd(), 'benchmark-results', stamp);
  const mails = loadMails(emailsDir);
  if (!mails.length) throw new Error(`Keine *.json-Testmails in ${emailsDir}`);
  fs.mkdirSync(outDir, { recursive: true });

  const promptWarnings = loadPromptFiles(config).warnings;
  promptWarnings.forEach((w) => log(`Hinweis: ${w}`));
  const readiness = await ensureReady(config, { log });
  const rows = [];
  const psEntries = [];

  for (const model of models) {
    const modelConfig = { ...config, model };
    await unloadOthers(config, model);
    log(`Lade ${model}`);
    const loadStart = Date.now();
    await preload(modelConfig);
    log(`${model} geladen in ${((Date.now() - loadStart) / 1000).toFixed(1)} s`);

    const running = (await ps(config)).find((m) => m.name === model);
    const gpuPercent = running ? running.gpu_percent : 0;
    if (running) psEntries.push({ model, ...running });
    log(`ollama ps: ${model} liegt zu ${gpuPercent}% auf der GPU`);

    for (const mail of mails) {
      log(`${model} <- ${mail.name}`);
      const start = Date.now();
      try {
        const result = await generateReply(modelConfig, mail.input, { log, ready: readiness });
        rows.push({
          model,
          mail: mail.name,
          gpu_percent: gpuPercent,
          wall_ms: Date.now() - start,
          stats: result.stats,
          warnings: result.warnings.filter((w) => !promptWarnings.includes(w)),
          reply: result.reply,
        });
      } catch (err) {
        log(`Fehler: ${err.message}`);
        rows.push({ model, mail: mail.name, gpu_percent: gpuPercent, error: `${err.code || 'ERROR'}: ${err.message}` });
      }
    }
  }

  const resultsMd = [
    `# Benchmark ${stamp}`,
    '',
    `num_ctx ${config.numCtx}, temperature ${config.temperature}, ${mails.length} Testmail(s)`,
    '',
    ...(promptWarnings.length ? ['## Hinweise zu den Prompt-Dateien', '', ...promptWarnings.map((w) => `- ${w}`), ''] : []),
    '## ollama ps (nach dem Laden)',
    '',
    psTable(psEntries),
    '',
    '## Ergebnisse',
    '',
    resultsTable(rows),
    '',
  ].join('\n');

  fs.writeFileSync(path.join(outDir, 'results.md'), resultsMd);
  fs.writeFileSync(path.join(outDir, 'comparison.md'), `# Antworten im Vergleich\n\n${comparison(models, mails, rows)}\n`);
  fs.writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify({ stamp, models, ps: psEntries, rows }, null, 2)}\n`);

  process.stdout.write(`${resultsMd}\nErgebnisse: ${outDir}\n`);
}

main().catch((err) => {
  log(`${err.code || 'ERROR'}: ${err.message}`);
  process.exitCode = 1;
});
