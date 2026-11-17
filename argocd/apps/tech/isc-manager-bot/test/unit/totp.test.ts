import { test } from "node:test";
import assert from "node:assert/strict";
import { TotpSource, remainingMs, totpCode, type Clock } from "../../src/totp.js";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("TOTP: RFC-6238-Testvektor (6 Stellen, SHA-1)", () => {
  assert.equal(totpCode(SECRET, 59_000), "287082");
  assert.equal(totpCode(SECRET, 1_111_111_109_000), "081804");
  assert.equal(totpCode(SECRET, 1_234_567_890_000), "005924");
});

test("TOTP: Restzeit im 30-Sekunden-Fenster", () => {
  assert.equal(remainingMs(0), 30_000);
  assert.equal(remainingMs(29_000), 1000);
  assert.equal(remainingMs(45_000), 15_000);
});

function fakeClock(start: number): { clock: Clock; slept: number[]; now: () => number } {
  let current = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => current,
    clock: {
      now: () => current,
      sleep: async (ms) => {
        slept.push(ms);
        current += ms;
      },
    },
  };
}

test("TOTP: bei genug Restzeit wird sofort der Code des laufenden Fensters geliefert", async () => {
  const fake = fakeClock(59_000 - 20_000);
  const source = new TotpSource(SECRET, fake.clock);
  assert.equal(await source.next(), totpCode(SECRET, 39_000));
  assert.deepEqual(fake.slept, []);
});

test("TOTP: kurz vor Ablauf wird auf das nächste Fenster gewartet", async () => {
  const fake = fakeClock(58_000);
  const source = new TotpSource(SECRET, fake.clock);
  const code = await source.next();
  assert.equal(fake.slept.length, 1);
  assert.equal(code, totpCode(SECRET, fake.now()));
  assert.notEqual(code, totpCode(SECRET, 58_000));
  assert.ok(fake.now() >= 60_000);
});

test("TOTP: ein bereits genutzter Code wird nie zweimal geliefert, es wird auf das nächste Fenster gewartet", async () => {
  const fake = fakeClock(65_000);
  const source = new TotpSource(SECRET, fake.clock);
  const first = await source.next();
  const second = await source.next();
  assert.notEqual(first, second);
  assert.equal(second, totpCode(SECRET, fake.now()));
  assert.equal(fake.slept.length, 1);
});
