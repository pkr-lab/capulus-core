import { loadConfig } from "../src/config.js";
import { logger } from "../src/logger.js";
import { RunLock } from "../src/mutex.js";
import { IscNewsRunner, launchChromium } from "../src/runner.js";
import { validateNewsRequest } from "../src/validation.js";

const cfg = loadConfig({ API_TOKEN: "smoke", ...process.env });
logger.registerSecret(cfg.iscPassword);
const runner = new IscNewsRunner(cfg, launchChromium, new RunLock(cfg.lockWaitMs), logger);
const title = process.env.SMOKE_TITLE ?? `Smoke-Test ${new Date().toISOString()}`;
const news = validateNewsRequest(
  {
    title,
    html: "<p>Smoke-Test, wird nicht gespeichert.</p>",
    categories: process.env.SMOKE_CATEGORY ? [process.env.SMOKE_CATEGORY] : [],
    dryRun: true,
  },
  cfg,
);
const result = await runner.createNews(news);
const { screenshotBase64: _omitted, ...printable } = result;
process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
