export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "LOGIN_FAILED",
  "LOGIN_UNEXPECTED",
  "WRONG_GLIEDERUNG",
  "FORM_CHANGED",
  "SAVE_UNCONFIRMED",
  "UPLOAD_FAILED",
  "PUBLISH_FAILED",
  "TIMEOUT",
  "BUSY",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  LOGIN_FAILED: 502,
  LOGIN_UNEXPECTED: 502,
  WRONG_GLIEDERUNG: 502,
  FORM_CHANGED: 502,
  SAVE_UNCONFIRMED: 502,
  UPLOAD_FAILED: 502,
  PUBLISH_FAILED: 502,
  TIMEOUT: 504,
  BUSY: 429,
  INTERNAL: 500,
};

export class IscBotError extends Error {
  readonly code: ErrorCode;
  readonly step: string | undefined;
  readonly details: string[];
  newsId: number | undefined;

  constructor(code: ErrorCode, message: string, options: { step?: string; details?: string[]; newsId?: number } = {}) {
    super(message);
    this.name = "IscBotError";
    this.code = code;
    this.step = options.step;
    this.details = options.details ?? [];
    this.newsId = options.newsId;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ValidationError extends IscBotError {
  constructor(message: string, details: string[] = []) {
    super("VALIDATION_FAILED", message, { details });
    this.name = "ValidationError";
  }
}
