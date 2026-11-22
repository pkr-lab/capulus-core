import { loadConfig } from "../src/config.js";
import { logger } from "../src/logger.js";
import { RunLock } from "../src/mutex.js";
import { SyncRunner, launchChromium } from "../src/runner.js";
import { TotpSource } from "../src/totp.js";
import { validateNewMembersRequest } from "../src/validation.js";

const cfg = loadConfig({ API_TOKEN: "smoke", ISC_USERNAME: "unbenutzt", ISC_PASSWORD: "unbenutzt", ...process.env });
for (const secret of [cfg.sewobePassword, cfg.sewobeTotpSecret]) logger.registerSecret(secret);
const runner = new SyncRunner(cfg, launchChromium, new RunLock(cfg.lockWaitMs), logger, new TotpSource(cfg.sewobeTotpSecret));
const request = validateNewMembersRequest({
  after: process.env.SMOKE_AFTER,
  window: process.env.SMOKE_WINDOW ? Number(process.env.SMOKE_WINDOW) : undefined,
});
const result = await runner.newMembers(request);
const { members, ...rest } = result;
const printable = { ...rest, members: members.map((member) => ({ number: member.number, active: member.active })) };
process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
