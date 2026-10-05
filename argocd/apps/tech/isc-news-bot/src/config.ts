import { ConfigError } from "./errors.js";

export type Mode = "draft" | "publish";

export type Config = {
  port: number;
  apiToken: string;
  iscBaseUrl: string;
  iscUsername: string;
  iscPassword: string;
  gliederungEdv: string;
  defaultAuthor: string;
  defaultAuthorEmail: string;
  defaultMode: Mode;
  uploadSettleMs: number;
  defaultImageKeywords: string[];
  maxImageBytes: number;
  maxBodyBytes: number;
  stepTimeoutMs: number;
  lockWaitMs: number;
};

export const DEFAULTS = {
  port: 8080,
  iscBaseUrl: "https://dlrg.net",
  gliederungEdv: "1002011",
  defaultAuthor: "DLRG Andernach e.V./cdi",
  defaultAuthorEmail: "kommunikation@andernach.dlrg.de",
  defaultMode: "draft" as Mode,
  uploadSettleMs: 60_000,
  defaultImageKeywords: ["News"],
  maxImageBytes: 15 * 1024 * 1024,
  maxBodyBytes: 50 * 1024 * 1024,
  stepTimeoutMs: 30_000,
  lockWaitMs: 60_000,
};

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${name} muss eine ganze Zahl >= ${min} sein: ${raw}`);
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

export function parseMode(raw: string | undefined, fallback: Mode): Mode {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "draft" || raw === "publish") return raw;
  throw new ConfigError(`DEFAULT_MODE muss "draft" oder "publish" sein: ${raw}`);
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const keywords = (env.DEFAULT_IMAGE_KEYWORDS ?? DEFAULTS.defaultImageKeywords.join(","))
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  const baseUrl = (env.ISC_BASE_URL ?? DEFAULTS.iscBaseUrl).replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl) && env.ALLOW_HTTP_ISC !== "true") {
    throw new ConfigError("ISC_BASE_URL muss mit https:// beginnen");
  }
  return {
    port: intFromEnv(env, "PORT", DEFAULTS.port, 1),
    apiToken: requiredFromEnv(env, "API_TOKEN"),
    iscBaseUrl: baseUrl,
    iscUsername: requiredFromEnv(env, "ISC_USERNAME"),
    iscPassword: requiredFromEnv(env, "ISC_PASSWORD"),
    gliederungEdv: env.GLIEDERUNG_EDV?.trim() || DEFAULTS.gliederungEdv,
    defaultAuthor: env.DEFAULT_AUTHOR?.trim() || DEFAULTS.defaultAuthor,
    defaultAuthorEmail: env.DEFAULT_AUTHOR_EMAIL?.trim() || DEFAULTS.defaultAuthorEmail,
    defaultMode: parseMode(env.DEFAULT_MODE, DEFAULTS.defaultMode),
    uploadSettleMs: intFromEnv(env, "UPLOAD_SETTLE_MS", DEFAULTS.uploadSettleMs, 0),
    defaultImageKeywords: keywords,
    maxImageBytes: intFromEnv(env, "MAX_IMAGE_BYTES", DEFAULTS.maxImageBytes, 1),
    maxBodyBytes: intFromEnv(env, "MAX_BODY_BYTES", DEFAULTS.maxBodyBytes, 1),
    stepTimeoutMs: intFromEnv(env, "STEP_TIMEOUT_MS", DEFAULTS.stepTimeoutMs, 1000),
    lockWaitMs: intFromEnv(env, "LOCK_WAIT_MS", DEFAULTS.lockWaitMs, 0),
  };
}
