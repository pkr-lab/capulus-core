import { Secret, TOTP } from "otpauth";

export const TOTP_PERIOD_MS = 30_000;
export const MIN_REMAINING_MS = 5_000;
const SAFETY_MS = 400;

export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function totpCode(secretBase32: string, nowMs: number): string {
  const totp = new TOTP({
    secret: Secret.fromBase32(secretBase32),
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_MS / 1000,
  });
  return totp.generate({ timestamp: nowMs });
}

export function remainingMs(nowMs: number): number {
  return TOTP_PERIOD_MS - (nowMs % TOTP_PERIOD_MS);
}

export class TotpSource {
  private last: string | undefined;

  constructor(
    private readonly secretBase32: string,
    private readonly clock: Clock = systemClock,
  ) {}

  async next(): Promise<string> {
    let now = this.clock.now();
    if (remainingMs(now) < MIN_REMAINING_MS) {
      await this.clock.sleep(remainingMs(now) + SAFETY_MS);
      now = this.clock.now();
    }
    let code = totpCode(this.secretBase32, now);
    if (code === this.last) {
      await this.clock.sleep(remainingMs(now) + SAFETY_MS);
      now = this.clock.now();
      code = totpCode(this.secretBase32, now);
    }
    this.last = code;
    return code;
  }
}
