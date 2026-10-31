'use strict';

const path = require('path');

const WAKE_MODES = ['none', 'udp', 'http', 'command'];

function text(env, name, fallback) {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
}

function number(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} muss eine nicht-negative Zahl sein, ist aber "${raw}"`);
  }
  return value;
}

function loadConfig(env = process.env) {
  const url = text(env, 'OLLAMA_URL', '');
  if (!url) throw new Error('OLLAMA_URL ist nicht gesetzt (z. B. http://192.168.178.50:11434)');

  const wakeMode = text(env, 'OLLAMA_WAKE_MODE', 'udp');
  if (!WAKE_MODES.includes(wakeMode)) {
    throw new Error(`OLLAMA_WAKE_MODE muss einer von ${WAKE_MODES.join(', ')} sein, ist aber "${wakeMode}"`);
  }

  const promptsDir = text(env, 'OLLAMA_PROMPTS_DIR', path.join(__dirname, '..', 'prompts'));

  return {
    url: url.replace(/\/+$/, ''),
    model: text(env, 'OLLAMA_MODEL', 'gemma3:27b-it-q8_0'),
    numCtx: number(env, 'OLLAMA_NUM_CTX', 16384),
    temperature: number(env, 'OLLAMA_TEMPERATURE', 0.6),
    keepAlive: text(env, 'OLLAMA_KEEP_ALIVE', '30m'),
    responseReserveTokens: number(env, 'OLLAMA_RESPONSE_RESERVE_TOKENS', 2048),
    charsPerToken: number(env, 'OLLAMA_CHARS_PER_TOKEN', 3),
    healthTimeoutMs: number(env, 'OLLAMA_HEALTH_TIMEOUT_SECONDS', 3) * 1000,
    wakeTimeoutMs: number(env, 'OLLAMA_WAKE_TIMEOUT_SECONDS', 120) * 1000,
    pollInitialMs: number(env, 'OLLAMA_WAKE_POLL_INITIAL_SECONDS', 2) * 1000,
    pollMaxMs: number(env, 'OLLAMA_WAKE_POLL_MAX_SECONDS', 15) * 1000,
    preloadTimeoutMs: number(env, 'OLLAMA_PRELOAD_TIMEOUT_SECONDS', 900) * 1000,
    requestTimeoutMs: number(env, 'OLLAMA_REQUEST_TIMEOUT_SECONDS', 1200) * 1000,
    wake: {
      mode: wakeMode,
      mac: text(env, 'OLLAMA_WAKE_MAC', ''),
      broadcast: text(env, 'OLLAMA_WAKE_BROADCAST', '255.255.255.255'),
      port: number(env, 'OLLAMA_WAKE_PORT', 9),
      url: text(env, 'OLLAMA_WAKE_URL', ''),
      target: text(env, 'OLLAMA_WAKE_TARGET', 'ollama-pc'),
      token: text(env, 'OLLAMA_WAKE_TOKEN', ''),
      command: text(env, 'OLLAMA_WAKE_COMMAND', ''),
      timeoutMs: number(env, 'OLLAMA_WAKE_REQUEST_TIMEOUT_SECONDS', 10) * 1000,
    },
    knowledgeDir: text(env, 'OLLAMA_KNOWLEDGE_DIR', path.join(__dirname, '..', 'knowledge')),
    knowledgeWarnRatio: number(env, 'OLLAMA_KNOWLEDGE_WARN_RATIO', 0.4),
    systemPromptFile: text(env, 'OLLAMA_SYSTEM_PROMPT_FILE', path.join(promptsDir, 'email_system.md')),
    examplesFile: text(env, 'OLLAMA_EXAMPLES_FILE', path.join(promptsDir, 'email_examples.md')),
  };
}

module.exports = { loadConfig, WAKE_MODES };
