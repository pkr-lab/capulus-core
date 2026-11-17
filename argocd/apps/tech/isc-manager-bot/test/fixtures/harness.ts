import type http from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "../../src/config.js";
import { Logger } from "../../src/logger.js";
import { RunLock } from "../../src/mutex.js";
import { SyncRunner, launchChromium } from "../../src/runner.js";
import { createServer } from "../../src/server.js";
import { TotpSource } from "../../src/totp.js";
import { testConfig } from "./config.js";
import { startMockIsc, type MockIsc, type MockOptions } from "./mock-isc.js";
import { startMockSewobe, type MockSewobe, type SewobeMockOptions } from "./mock-sewobe.js";

export const silent = new Logger(true);

export type Harness = {
  isc: MockIsc;
  sewobe: MockSewobe;
  cfg: Config;
  runner: SyncRunner;
};

export async function withMocks(
  iscOptions: MockOptions,
  sewobeOptions: SewobeMockOptions,
  overrides: Partial<Config>,
  run: (h: Harness) => Promise<void>,
  logger: Logger = silent,
): Promise<void> {
  const isc = await startMockIsc(iscOptions);
  const sewobe = await startMockSewobe(sewobeOptions);
  try {
    const cfg = testConfig(isc.baseUrl, sewobe.baseUrl, overrides);
    const totp = new TotpSource(cfg.sewobeTotpSecret, { now: () => Date.now(), sleep: async () => undefined });
    const runner = new SyncRunner(cfg, launchChromium, new RunLock(cfg.lockWaitMs), logger, totp);
    await run({ isc, sewobe, cfg, runner });
  } finally {
    await isc.close();
    await sewobe.close();
  }
}

export async function startApi(h: Harness): Promise<{ base: string; close: () => Promise<void> }> {
  const server: http.Server = createServer({ cfg: h.cfg, runner: h.runner, logger: silent });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
