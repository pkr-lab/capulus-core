import type { Config } from "../../src/config.js";
import { MOCK_EDV, MOCK_PASS, MOCK_USER } from "./mock-isc.js";

export function testConfig(baseUrl: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    apiToken: "test-token-platzhalter",
    iscBaseUrl: baseUrl,
    iscUsername: MOCK_USER,
    iscPassword: MOCK_PASS,
    gliederungEdv: MOCK_EDV,
    defaultAuthor: "DLRG Andernach e.V./cdi",
    defaultAuthorEmail: "kommunikation@andernach.dlrg.de",
    defaultMode: "draft",
    uploadSettleMs: 10,
    defaultImageKeywords: ["News"],
    maxImageBytes: 15 * 1024 * 1024,
    maxBodyBytes: 50 * 1024 * 1024,
    stepTimeoutMs: 15_000,
    lockWaitMs: 60_000,
    ...overrides,
  };
}
