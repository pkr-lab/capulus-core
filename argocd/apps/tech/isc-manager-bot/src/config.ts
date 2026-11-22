import { ConfigError } from "./errors.js";

export type Config = {
  port: number;
  apiToken: string;
  iscBaseUrl: string;
  iscUsername: string;
  iscPassword: string;
  sewobeBaseUrl: string;
  sewobeUsername: string;
  sewobePassword: string;
  sewobeTotpSecret: string;
  gliederungEdv: string;
  mitgliedschaftGliederung: string;
  mitgliedschaftSuchbegriff: string;
  stepTimeoutMs: number;
  searchTimeoutMs: number;
  searchSettleMs: number;
  numberSearchSettleMs: number;
  saveTimeoutMs: number;
  syncTimeoutMs: number;
  lockWaitMs: number;
  maxBodyBytes: number;
};

const DEFAULTS = {
  port: 8080,
  iscBaseUrl: "https://dlrg.net",
  sewobeBaseUrl: "https://mv.dlrg.net",
  gliederungEdv: "1002011",
  mitgliedschaftGliederung: "Ortsgruppe Andernach e.V.",
  mitgliedschaftSuchbegriff: "Andernach",
  stepTimeoutMs: 30_000,
  searchTimeoutMs: 90_000,
  searchSettleMs: 20_000,
  numberSearchSettleMs: 3000,
  saveTimeoutMs: 45_000,
  syncTimeoutMs: 360_000,
  lockWaitMs: 60_000,
  maxBodyBytes: 64 * 1024,
};

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${name} muss eine ganze Zahl >= ${min} sein`);
  }
  return value;
}

function requiredFromEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim() === "") {
    throw new ConfigError(`Pflicht-Umgebungsvariable fehlt: ${name}`);
  }
  return value;
}

function baseUrl(env: NodeJS.ProcessEnv, name: string, fallback: string, allowHttpFlag: string): string {
  const url = (env[name] ?? fallback).replace(/\/+$/, "");
  if (!/^https:\/\//.test(url) && env[allowHttpFlag] !== "true") {
    throw new ConfigError(`${name} muss mit https:// beginnen`);
  }
  return url;
}

export function normalizeTotpSecret(raw: string): string {
  const cleaned = raw.replace(/[\s-]/g, "").toUpperCase().replace(/=+$/, "");
  if (!/^[A-Z2-7]{16,}$/.test(cleaned)) {
    throw new ConfigError("SEWOBE_TOTP_SECRET ist kein gültiges Base32-Secret (mindestens 16 Zeichen A-Z, 2-7)");
  }
  return cleaned;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: intFromEnv(env, "PORT", DEFAULTS.port, 1),
    apiToken: requiredFromEnv(env, "API_TOKEN"),
    iscBaseUrl: baseUrl(env, "ISC_BASE_URL", DEFAULTS.iscBaseUrl, "ALLOW_HTTP_ISC"),
    iscUsername: requiredFromEnv(env, "ISC_USERNAME"),
    iscPassword: requiredFromEnv(env, "ISC_PASSWORD"),
    sewobeBaseUrl: baseUrl(env, "SEWOBE_BASE_URL", DEFAULTS.sewobeBaseUrl, "ALLOW_HTTP_SEWOBE"),
    sewobeUsername: requiredFromEnv(env, "SEWOBE_USERNAME"),
    sewobePassword: requiredFromEnv(env, "SEWOBE_PASSWORD"),
    sewobeTotpSecret: normalizeTotpSecret(requiredFromEnv(env, "SEWOBE_TOTP_SECRET")),
    gliederungEdv: env.GLIEDERUNG_EDV?.trim() || DEFAULTS.gliederungEdv,
    mitgliedschaftGliederung: env.MITGLIEDSCHAFT_GLIEDERUNG?.trim() || DEFAULTS.mitgliedschaftGliederung,
    mitgliedschaftSuchbegriff: env.MITGLIEDSCHAFT_SUCHBEGRIFF?.trim() || DEFAULTS.mitgliedschaftSuchbegriff,
    stepTimeoutMs: intFromEnv(env, "STEP_TIMEOUT_MS", DEFAULTS.stepTimeoutMs, 1000),
    searchTimeoutMs: intFromEnv(env, "SEARCH_TIMEOUT_MS", DEFAULTS.searchTimeoutMs, 1000),
    searchSettleMs: intFromEnv(env, "SEARCH_SETTLE_MS", DEFAULTS.searchSettleMs, 0),
    numberSearchSettleMs: intFromEnv(env, "NUMBER_SEARCH_SETTLE_MS", DEFAULTS.numberSearchSettleMs, 0),
    saveTimeoutMs: intFromEnv(env, "SAVE_TIMEOUT_MS", DEFAULTS.saveTimeoutMs, 1000),
    syncTimeoutMs: intFromEnv(env, "SYNC_TIMEOUT_MS", DEFAULTS.syncTimeoutMs, 10_000),
    lockWaitMs: intFromEnv(env, "LOCK_WAIT_MS", DEFAULTS.lockWaitMs, 0),
    maxBodyBytes: intFromEnv(env, "MAX_BODY_BYTES", DEFAULTS.maxBodyBytes, 1),
  };
}
