const SENSITIVE_KEY = /pass|cookie|csrf|token|secret|base64|lastchange|authoriz|user|screenshot|html|buffer/i;

export type LogFields = Record<string, unknown>;

export class Logger {
  private readonly secrets = new Set<string>();

  constructor(private readonly silent = false) {}

  registerSecret(value: string): void {
    if (value.length >= 4) this.secrets.add(value);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      out = out.split(secret).join("***");
    }
    return out;
  }

  info(msg: string, fields: LogFields = {}): void {
    this.write("info", msg, fields);
  }

  warn(msg: string, fields: LogFields = {}): void {
    this.write("warn", msg, fields);
  }

  error(msg: string, fields: LogFields = {}): void {
    this.write("error", msg, fields);
  }

  private write(level: string, msg: string, fields: LogFields): void {
    if (this.silent) return;
    const safe: LogFields = {};
    for (const [key, value] of Object.entries(fields)) {
      if (SENSITIVE_KEY.test(key)) continue;
      safe[key] = typeof value === "string" ? this.redact(value) : value;
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: this.redact(msg), ...safe });
    if (level === "error") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}

export const logger = new Logger();
