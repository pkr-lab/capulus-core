import { test, before } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { IscNewsRunner, launchChromium } from "../../src/runner.js";
import { RunLock } from "../../src/mutex.js";
import { Logger } from "../../src/logger.js";
import { createServer } from "../../src/server.js";
import { STANDARD_PO_NUMMERN } from "../../src/urkunden.js";
import { startMockIsc, OTHER_EDV, type MockIsc, type MockOptions } from "../fixtures/mock-isc.js";
import { testConfig } from "../fixtures/config.js";
import { MOCK_URKUNDEN } from "../fixtures/urkunden.js";

const silent = new Logger(true);
const RUN_TIMEOUT = 180_000;
const AUTH = { Authorization: "Bearer test-token-platzhalter" };

let browserAvailable = true;
before(async () => {
  try {
    const browser = await chromium.launch();
    await browser.close();
  } catch {
    browserAvailable = false;
  }
});

async function withMock(options: MockOptions, run: (mock: MockIsc, runner: IscNewsRunner) => Promise<void>): Promise<void> {
  const mock = await startMockIsc(options);
  try {
    const cfg = testConfig(mock.baseUrl, { stepTimeoutMs: 5_000 });
    await run(mock, new IscNewsRunner(cfg, launchChromium, new RunLock(cfg.lockWaitMs), silent));
  } finally {
    await mock.close();
  }
}

test("Urkunden lesen: Login, Gliederung, ladeUrkundenListe und Filter", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({ urkunden: MOCK_URKUNDEN, initialEdv: OTHER_EDV }, async (mock, runner) => {
    const result = await runner.listUrkunden({ jahr: "2026", poNummern: [...STANDARD_PO_NUMMERN] });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.gelesen, 5);
    assert.deepEqual(
      result.urkunden.map((u) => u.registriernummer),
      ["1002011/111/041/26", "1002011/122/017/26", "1002011/141/002/26"],
    );
    assert.deepEqual(mock.urkundenAnfragen, [
      { aktion: "ladeUrkundenListe", data: { jahr: "2026", ausbildungId: "", inaktiveAnzeigen: false, mitVerlaengerungen: false } },
    ]);
  });
});

test("Urkunden lesen: fehlt dlrg_DoPost, kommt FORM_CHANGED", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({ urkundenOhneService: true }, async (_mock, runner) => {
    const result = await runner.listUrkunden({ jahr: "2026", poNummern: ["111"] });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "FORM_CHANGED");
    assert.equal(result.step, "urkunden");
  });
});

test("GET /urkunden: Token, Query-Prüfung und Antwort", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  const mock = await startMockIsc({ urkunden: MOCK_URKUNDEN });
  const cfg = testConfig(mock.baseUrl);
  const runner = new IscNewsRunner(cfg, launchChromium, new RunLock(cfg.lockWaitMs), silent);
  const server: http.Server = createServer({ cfg, runner, logger: silent });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/urkunden`)).status, 401);
    assert.equal((await fetch(`${base}/urkunden?jahr=26`, { headers: AUTH })).status, 400);
    const response = await fetch(`${base}/urkunden?jahr=2026&ausbildungen=111,122`, { headers: AUTH });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { ok: boolean; urkunden: Array<{ uid: string; name: string }> };
    assert.equal(payload.ok, true);
    assert.deepEqual(
      payload.urkunden.map((u) => u.name),
      ["Erika Beispiel", "Max Mustermann"],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mock.close();
  }
});
