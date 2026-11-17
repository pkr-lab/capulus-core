import { chromium } from "playwright";
import { loadConfig } from "./config.js";
import { ConfigError } from "./errors.js";
import { logger } from "./logger.js";
import { RunLock } from "./mutex.js";
import { createServer, chromiumInstalled } from "./server.js";
import { SyncRunner, launchChromium } from "./runner.js";
import { TotpSource } from "./totp.js";

function startup(): void {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`Konfigurationsfehler: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  for (const secret of [cfg.iscPassword, cfg.apiToken, cfg.sewobePassword, cfg.sewobeTotpSecret]) {
    logger.registerSecret(secret);
  }

  const runner = new SyncRunner(cfg, launchChromium, new RunLock(cfg.lockWaitMs), logger, new TotpSource(cfg.sewobeTotpSecret));
  const server = createServer({
    cfg,
    runner,
    logger,
    browserReady: () => chromiumInstalled(chromium.executablePath()),
  });

  server.listen(cfg.port, "0.0.0.0", () => {
    logger.info("isc-manager-bot gestartet", { port: cfg.port, gliederungEdv: cfg.gliederungEdv });
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

startup();
