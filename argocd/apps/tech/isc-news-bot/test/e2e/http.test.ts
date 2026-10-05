import { test } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { createServer } from "../../src/server.js";
import { IscNewsRunner, launchChromium } from "../../src/runner.js";
import { RunLock } from "../../src/mutex.js";
import { Logger } from "../../src/logger.js";
import { startMockIsc, type MockIsc } from "../fixtures/mock-isc.js";
import { testConfig } from "../fixtures/config.js";
import { PNG_BASE64 } from "../fixtures/images.js";

const silent = new Logger(true);
const RUN_TIMEOUT = 180_000;

async function startApi(mock: MockIsc, overrides: Parameters<typeof testConfig>[1] = {}) {
  const cfg = testConfig(mock.baseUrl, { apiToken: "api-token-platzhalter", ...overrides });
  const runner = new IscNewsRunner(cfg, launchChromium, new RunLock(cfg.lockWaitMs), silent);
  const server: http.Server = createServer({ cfg, runner, logger: silent });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    cfg,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const AUTH = { Authorization: "Bearer api-token-platzhalter", "Content-Type": "application/json" };

async function browserOk(): Promise<boolean> {
  try {
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

test("Health und Readiness ohne Token", async () => {
  const mock = await startMockIsc();
  const api = await startApi(mock);
  try {
    assert.equal((await fetch(`${api.base}/healthz`)).status, 200);
    assert.equal((await fetch(`${api.base}/readyz`)).status, 200);
  } finally {
    await api.close();
    await mock.close();
  }
});

test("Ohne oder mit falschem Token: 401", async () => {
  const mock = await startMockIsc();
  const api = await startApi(mock);
  try {
    const none = await fetch(`${api.base}/news`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(none.status, 401);
    const wrong = await fetch(`${api.base}/news`, {
      method: "POST",
      headers: { Authorization: "Bearer falsch", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(wrong.status, 401);
    assert.equal((await fetch(`${api.base}/categories`)).status, 401);
    assert.equal(mock.requests.length, 0, "ohne Token darf der ISC nicht angefragt werden");
  } finally {
    await api.close();
    await mock.close();
  }
});

test("Fehlerhafte Eingaben: 400 mit Details, ohne ISC-Zugriff", async () => {
  const mock = await startMockIsc();
  const api = await startApi(mock);
  try {
    const invalidJson = await fetch(`${api.base}/news`, { method: "POST", headers: AUTH, body: "{kaputt" });
    assert.equal(invalidJson.status, 400);

    const missingTitle = await fetch(`${api.base}/news`, { method: "POST", headers: AUTH, body: JSON.stringify({ html: "x" }) });
    assert.equal(missingTitle.status, 400);
    const payload = (await missingTitle.json()) as { errorCode: string; details: string[] };
    assert.equal(payload.errorCode, "VALIDATION_FAILED");
    assert.ok(payload.details.includes("title fehlt"));

    const wrongType = await fetch(`${api.base}/news`, {
      method: "POST",
      headers: { Authorization: AUTH.Authorization, "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);

    assert.equal(mock.requests.length, 0);
  } finally {
    await api.close();
    await mock.close();
  }
});

test("Body über dem Limit: 413", async () => {
  const mock = await startMockIsc();
  const api = await startApi(mock, { maxBodyBytes: 500 });
  try {
    const big = JSON.stringify({ title: "x".repeat(1000), html: "y" });
    const response = await fetch(`${api.base}/news`, { method: "POST", headers: AUTH, body: big });
    assert.equal(response.status, 413);
  } finally {
    await api.close();
    await mock.close();
  }
});

test("Unbekannte Route: 404", async () => {
  const mock = await startMockIsc();
  const api = await startApi(mock);
  try {
    const response = await fetch(`${api.base}/gibt-es-nicht`, { headers: AUTH });
    assert.equal(response.status, 404);
  } finally {
    await api.close();
    await mock.close();
  }
});

test("GET /categories liefert die Optionen über die API", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!(await browserOk())) return t.skip("Chromium nicht verfügbar");
  const mock = await startMockIsc();
  const api = await startApi(mock);
  try {
    const response = await fetch(`${api.base}/categories`, { headers: AUTH });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { ok: boolean; categories: Array<{ value: string; name: string }> };
    assert.equal(payload.ok, true);
    assert.equal(payload.categories.length, 12);
  } finally {
    await api.close();
    await mock.close();
  }
});

test("Zweiter gleichzeitiger Lauf bekommt 429 mit Retry-After", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!(await browserOk())) return t.skip("Chromium nicht verfügbar");
  const mock = await startMockIsc();
  const api = await startApi(mock, { lockWaitMs: 50, uploadSettleMs: 1500 });
  try {
    const payload = JSON.stringify({
      title: "Parallel-Test",
      html: "<p>x</p>",
      images: [{ fileName: "a.png", mimeType: "image/png", dataBase64: PNG_BASE64 }],
    });
    const first = fetch(`${api.base}/news`, { method: "POST", headers: AUTH, body: payload });
    await new Promise((r) => setTimeout(r, 300));
    const second = await fetch(`${api.base}/news`, { method: "POST", headers: AUTH, body: payload });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after"), "60");
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
  } finally {
    await api.close();
    await mock.close();
  }
});
