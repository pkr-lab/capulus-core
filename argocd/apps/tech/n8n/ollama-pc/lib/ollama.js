'use strict';

const { request, HttpError } = require('./http');
const { wake } = require('./wake');
const { OllamaPcError } = require('./errors');

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isUp(config) {
  try {
    await request(`${config.url}/api/tags`, { timeoutMs: config.healthTimeoutMs });
    return true;
  } catch (err) {
    return false;
  }
}

async function ensureReady(config, { log = () => {}, sleep = defaultSleep, now = Date.now } = {}) {
  if (await isUp(config)) return { woke: false, waitedMs: 0 };

  log(`Ollama unter ${config.url} nicht erreichbar, Wake-Modus: ${config.wake.mode}`);
  try {
    await wake(config.wake);
  } catch (err) {
    throw new OllamaPcError('WAKE_FAILED', `Wake-Signal konnte nicht gesendet werden: ${err.message}`);
  }

  const start = now();
  let delay = config.pollInitialMs;
  while (now() - start < config.wakeTimeoutMs) {
    const remaining = config.wakeTimeoutMs - (now() - start);
    await sleep(Math.min(delay, remaining));
    if (await isUp(config)) {
      const waitedMs = now() - start;
      log(`Ollama nach ${Math.round(waitedMs / 1000)} s erreichbar`);
      return { woke: true, waitedMs };
    }
    delay = Math.min(delay * 1.5, config.pollMaxMs);
  }

  throw new OllamaPcError(
    'PC_NOT_WAKING',
    `Ollama unter ${config.url} antwortet ${Math.round(config.wakeTimeoutMs / 1000)} s nach dem Wake-Signal (${config.wake.mode}) nicht. ` +
      'PC aus, Wake-on-LAN im BIOS/NIC aus oder GPU/Ollama nach dem Resume nicht gestartet?',
    { url: config.url, wakeMode: config.wake.mode },
  );
}

function mapModelError(err, config, phase) {
  if (err instanceof HttpError && err.status === 404) {
    return new OllamaPcError('MODEL_MISSING', `Modell ${config.model} ist auf dem PC nicht vorhanden. Auf dem PC: ollama pull ${config.model}`);
  }
  if (err instanceof HttpError && err.code === 'TIMEOUT') {
    const code = phase === 'preload' ? 'MODEL_LOAD_TIMEOUT' : 'REQUEST_TIMEOUT';
    return new OllamaPcError(code, `${phase === 'preload' ? 'Modell laden' : 'Antwort erzeugen'} hat das Zeitlimit überschritten (${err.message})`);
  }
  const detail = err.body && err.body.error ? `: ${err.body.error}` : '';
  const code = phase === 'preload' ? 'MODEL_LOAD_FAILED' : 'CHAT_FAILED';
  return new OllamaPcError(code, `${err.message}${detail}`);
}

function modelOptions(config) {
  return { num_ctx: config.numCtx };
}

async function preload(config, model = config.model) {
  try {
    await request(`${config.url}/api/chat`, {
      method: 'POST',
      body: { model, messages: [], stream: false, keep_alive: config.keepAlive, options: modelOptions(config) },
      timeoutMs: config.preloadTimeoutMs,
    });
  } catch (err) {
    throw mapModelError(err, { ...config, model }, 'preload');
  }
}

async function chat(config, messages, model = config.model) {
  try {
    const { body } = await request(`${config.url}/api/chat`, {
      method: 'POST',
      body: {
        model,
        messages,
        stream: false,
        keep_alive: config.keepAlive,
        options: { ...modelOptions(config), temperature: config.temperature },
      },
      timeoutMs: config.requestTimeoutMs,
    });
    return body;
  } catch (err) {
    throw mapModelError(err, { ...config, model }, 'chat');
  }
}

async function unload(config, model) {
  try {
    await request(`${config.url}/api/generate`, {
      method: 'POST',
      body: { model, keep_alive: 0 },
      timeoutMs: config.healthTimeoutMs * 10,
    });
  } catch (err) {
    return false;
  }
  return true;
}

async function ps(config) {
  const { body } = await request(`${config.url}/api/ps`, { timeoutMs: config.healthTimeoutMs * 3 });
  return ((body && body.models) || []).map((m) => ({
    name: m.name,
    size: m.size,
    size_vram: m.size_vram,
    gpu_percent: m.size > 0 ? Math.round((100 * m.size_vram) / m.size) : 0,
    context_length: m.context_length,
    expires_at: m.expires_at,
  }));
}

const NS_PER_MS = 1e6;

function stats(body) {
  const evalSeconds = (body.eval_duration || 0) / 1e9;
  return {
    total_duration_ms: Math.round((body.total_duration || 0) / NS_PER_MS),
    load_duration_ms: Math.round((body.load_duration || 0) / NS_PER_MS),
    prompt_eval_count: body.prompt_eval_count || 0,
    prompt_eval_duration_ms: Math.round((body.prompt_eval_duration || 0) / NS_PER_MS),
    eval_count: body.eval_count || 0,
    eval_duration_ms: Math.round((body.eval_duration || 0) / NS_PER_MS),
    tokens_per_second: evalSeconds > 0 ? Number((body.eval_count / evalSeconds).toFixed(2)) : 0,
    done_reason: body.done_reason || null,
  };
}

module.exports = { isUp, ensureReady, preload, chat, unload, ps, stats };
