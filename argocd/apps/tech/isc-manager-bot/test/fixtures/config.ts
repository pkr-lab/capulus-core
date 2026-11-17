import type { Config } from "../../src/config.js";
import { MOCK_EDV, MOCK_GLIEDERUNG, MOCK_PASS, MOCK_USER } from "./mock-isc.js";
import { SEWOBE_PASS, SEWOBE_TOTP_SECRET, SEWOBE_USER } from "./mock-sewobe.js";

export function testConfig(iscBaseUrl: string, sewobeBaseUrl: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    apiToken: "test-token-platzhalter",
    iscBaseUrl,
    iscUsername: MOCK_USER,
    iscPassword: MOCK_PASS,
    sewobeBaseUrl,
    sewobeUsername: SEWOBE_USER,
    sewobePassword: SEWOBE_PASS,
    sewobeTotpSecret: SEWOBE_TOTP_SECRET,
    gliederungEdv: MOCK_EDV,
    mitgliedschaftGliederung: MOCK_GLIEDERUNG,
    stepTimeoutMs: 15_000,
    searchTimeoutMs: 20_000,
    searchSettleMs: 0,
    saveTimeoutMs: 15_000,
    syncTimeoutMs: 120_000,
    lockWaitMs: 60_000,
    maxBodyBytes: 64 * 1024,
    ...overrides,
  };
}
