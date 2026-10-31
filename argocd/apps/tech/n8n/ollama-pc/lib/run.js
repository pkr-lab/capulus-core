'use strict';

const { ensureReady, preload, chat, stats } = require('./ollama');
const { loadPromptFiles, buildMessages, cleanReply } = require('./prompt');
const { OllamaPcError } = require('./errors');

const MAX_ATTEMPTS = 2;
const SAFETY_FACTOR = 0.9;

async function generateReply(config, input, { log = () => {}, ready } = {}) {
  const prompts = loadPromptFiles(config);
  log(
    `Firmenwissen: ${prompts.knowledge.files.length} Datei(en), ca. ${prompts.knowledge.tokens} Token (${Math.round(prompts.knowledge.ratio * 100)}% von num_ctx ${config.numCtx})`,
  );
  prompts.warnings.forEach((warning) => log(`Warnung: ${warning}`));
  buildMessages(prompts, input, config);
  const readiness = ready || (await ensureReady(config, { log }));

  log(`Modell ${config.model} wird vorgeladen (num_ctx ${config.numCtx}, keep_alive ${config.keepAlive})`);
  const preloadStart = Date.now();
  await preload(config);
  const preloadMs = Date.now() - preloadStart;

  let charsPerToken = config.charsPerToken;
  let built;
  let body;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    built = buildMessages(prompts, input, { ...config, charsPerToken });
    if (built.omitted > 0) log(built.warnings[built.warnings.length - 1]);
    log(`Anfrage an ${config.model}: ca. ${built.estimatedTokens} Token geschätzt, Verlauf ${built.keptHistory}/${built.keptHistory + built.omitted}`);
    body = await chat(config, built.messages);

    const limit = config.numCtx - config.responseReserveTokens;
    const tooLarge = body.prompt_eval_count > limit;
    if (!tooLarge || attempt === MAX_ATTEMPTS || built.keptHistory === 0) break;

    charsPerToken = Math.min(charsPerToken, (built.totalChars / body.prompt_eval_count) * SAFETY_FACTOR);
    log(`Prompt belegte ${body.prompt_eval_count} Token (Limit ${limit}), Verlauf wird mit ${charsPerToken.toFixed(2)} Zeichen/Token neu gekürzt`);
  }

  const warnings = [...built.warnings];
  if (body.done_reason === 'length') {
    warnings.push(`Antwort wurde durch das Kontextlimit abgeschnitten (num_ctx ${config.numCtx})`);
  }
  if (body.prompt_eval_count > config.numCtx - config.responseReserveTokens) {
    warnings.push(`Prompt belegt ${body.prompt_eval_count} Token und lässt weniger als ${config.responseReserveTokens} Token für die Antwort`);
  }

  const reply = cleanReply(body.message && body.message.content);
  if (!reply) throw new OllamaPcError('EMPTY_REPLY', `Modell ${config.model} lieferte eine leere Antwort`);

  return {
    reply,
    model: config.model,
    woke: readiness.woke,
    waited_ms: readiness.waitedMs,
    preload_ms: preloadMs,
    history_omitted: built.omitted,
    knowledge: prompts.knowledge,
    stats: stats(body),
    warnings,
  };
}

module.exports = { generateReply };
