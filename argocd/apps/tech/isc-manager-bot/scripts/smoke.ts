import { loadConfig } from "../src/config.js";
import { logger } from "../src/logger.js";
import { RunLock } from "../src/mutex.js";
import { SyncRunner, launchChromium } from "../src/runner.js";
import { TotpSource } from "../src/totp.js";
import { validateSyncRequest } from "../src/validation.js";

const cfg = loadConfig({ API_TOKEN: "smoke", ...process.env });
for (const secret of [cfg.iscPassword, cfg.sewobePassword, cfg.sewobeTotpSecret]) logger.registerSecret(secret);
const runner = new SyncRunner(cfg, launchChromium, new RunLock(cfg.lockWaitMs), logger, new TotpSource(cfg.sewobeTotpSecret));
const request = validateSyncRequest({
  vorname: process.env.SMOKE_VORNAME,
  nachname: process.env.SMOKE_NACHNAME,
  mitgliedsnummer: process.env.SMOKE_MITGLIEDSNUMMER || undefined,
  dryRun: true,
});
const result = await runner.sync(request);
const { diff: _omitted, ...printable } = result;
process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
