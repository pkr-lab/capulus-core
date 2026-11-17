const ERROR_CODES = [
  "VALIDATION_FAILED",
  "LOGIN_FAILED",
  "LOGIN_UNEXPECTED",
  "TOTP_FAILED",
  "WRONG_GLIEDERUNG",
  "FORM_CHANGED",
  "FORM_INVALID",
  "SEWOBE_NO_MATCH",
  "SEWOBE_AMBIGUOUS",
  "SEWOBE_DATA_INVALID",
  "ISC_CONFLICT",
  "ISC_AMBIGUOUS",
  "GESCHLECHT_FEHLT",
  "LAND_UNBEKANNT",
  "SAVE_FAILED",
  "SAVE_UNCONFIRMED",
  "TIMEOUT",
  "BUSY",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  LOGIN_FAILED: 502,
  LOGIN_UNEXPECTED: 502,
  TOTP_FAILED: 502,
  WRONG_GLIEDERUNG: 502,
  FORM_CHANGED: 502,
  FORM_INVALID: 422,
  SEWOBE_NO_MATCH: 422,
  SEWOBE_AMBIGUOUS: 422,
  SEWOBE_DATA_INVALID: 422,
  ISC_CONFLICT: 422,
  ISC_AMBIGUOUS: 422,
  GESCHLECHT_FEHLT: 422,
  LAND_UNBEKANNT: 422,
  SAVE_FAILED: 502,
  SAVE_UNCONFIRMED: 502,
  TIMEOUT: 504,
  BUSY: 429,
  INTERNAL: 500,
};

export class BotError extends Error {
  readonly code: ErrorCode;
  readonly step: string | undefined;
  readonly details: string[];

  constructor(code: ErrorCode, message: string, options: { step?: string; details?: string[] } = {}) {
    super(message);
    this.name = "BotError";
    this.code = code;
    this.step = options.step;
    this.details = options.details ?? [];
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ValidationError extends BotError {
  constructor(message: string, details: string[] = []) {
    super("VALIDATION_FAILED", message, { details });
    this.name = "ValidationError";
  }
}
