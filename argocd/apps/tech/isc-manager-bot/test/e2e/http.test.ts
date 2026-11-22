import { test, before } from "node:test";
import assert from "node:assert/strict";
import { browserAvailable } from "../fixtures/browser.js";
import { startApi, withMocks } from "../fixtures/harness.js";
import { person } from "../fixtures/mock-isc.js";
import { sewobePerson } from "../fixtures/mock-sewobe.js";

const RUN_TIMEOUT = 180_000;
const AUTH = { Authorization: "Bearer test-token-platzhalter", "Content-Type": "application/json" };

let chromiumReady = true;
before(async () => {
  chromiumReady = await browserAvailable();
});

test("Health und Readiness ohne Token", async () => {
  await withMocks({}, {}, {}, async (h) => {
    const api = await startApi(h);
    try {
      assert.equal((await fetch(`${api.base}/healthz`)).status, 200);
      assert.equal((await fetch(`${api.base}/readyz`)).status, 200);
    } finally {
      await api.close();
    }
  });
});

test("Ohne oder mit falschem Token: 401, die Systeme werden nicht angefragt", async () => {
  await withMocks({}, {}, {}, async (h) => {
    const api = await startApi(h);
    try {
      const none = await fetch(`${api.base}/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(none.status, 401);
      const wrong = await fetch(`${api.base}/sync`, { method: "POST", headers: { Authorization: "Bearer falsch", "Content-Type": "application/json" }, body: "{}" });
      assert.equal(wrong.status, 401);
      assert.equal(h.isc.requests.length, 0);
      assert.equal(h.sewobe.logins(), 0);
    } finally {
      await api.close();
    }
  });
});

test("Ungültige Anfragen: 400, 415, 404", async () => {
  await withMocks({}, {}, {}, async (h) => {
    const api = await startApi(h);
    try {
      const invalid = await fetch(`${api.base}/sync`, { method: "POST", headers: AUTH, body: JSON.stringify({ vorname: "", nachname: "X", mitgliedsnummer: "1" }) });
      assert.equal(invalid.status, 400);
      const json = (await invalid.json()) as { errorCode: string; details: string[] };
      assert.equal(json.errorCode, "VALIDATION_FAILED");
      assert.equal(json.details.length, 2);
      const notJson = await fetch(`${api.base}/sync`, { method: "POST", headers: AUTH, body: "{kaputt" });
      assert.equal(notJson.status, 400);
      const wrongType = await fetch(`${api.base}/sync`, { method: "POST", headers: { ...AUTH, "Content-Type": "text/plain" }, body: "x" });
      assert.equal(wrongType.status, 415);
      assert.equal((await fetch(`${api.base}/unbekannt`, { headers: AUTH })).status, 404);
      assert.equal(h.isc.requests.length, 0);
    } finally {
      await api.close();
    }
  });
});

test("Zu großer Body: 413", async () => {
  await withMocks({}, {}, { maxBodyBytes: 50 }, async (h) => {
    const api = await startApi(h);
    try {
      const response = await fetch(`${api.base}/sync`, { method: "POST", headers: AUTH, body: JSON.stringify({ vorname: "A".repeat(200), nachname: "B" }) });
      assert.equal(response.status, 413);
    } finally {
      await api.close();
    }
  });
});

test("Abgleich über HTTP: created, 422 bei fachlichem Fehler, Dry-Run mit Diff", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!chromiumReady) return t.skip("Chromium nicht verfügbar");
  await withMocks({}, { persons: [sewobePerson()] }, {}, async (h) => {
    const api = await startApi(h);
    try {
      const dry = await fetch(`${api.base}/sync`, { method: "POST", headers: AUTH, body: JSON.stringify({ vorname: "Erika", nachname: "Musterfrau", dryRun: true }) });
      assert.equal(dry.status, 200);
      const dryBody = (await dry.json()) as { result: string; dryRun: boolean; diff: unknown[] };
      assert.equal(dryBody.result, "created");
      assert.equal(dryBody.dryRun, true);
      assert.ok(dryBody.diff.length > 0);
      assert.equal(h.isc.persons.length, 0);

      const created = await fetch(`${api.base}/sync`, { method: "POST", headers: AUTH, body: JSON.stringify({ vorname: "Erika", nachname: "Musterfrau", mitgliedsnummer: "1002011000001" }) });
      assert.equal(created.status, 200);
      assert.equal(((await created.json()) as { result: string }).result, "created");

      const unknown = await fetch(`${api.base}/sync`, { method: "POST", headers: AUTH, body: JSON.stringify({ vorname: "Nobody", nachname: "Nowhere" }) });
      assert.equal(unknown.status, 422);
      const body = (await unknown.json()) as { ok: boolean; result: string; errorCode: string };
      assert.equal(body.ok, false);
      assert.equal(body.result, "error");
      assert.equal(body.errorCode, "SEWOBE_NO_MATCH");
    } finally {
      await api.close();
    }
  });
});

test("Technischer Fehler: Login im ISC abgelehnt ergibt 502", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!chromiumReady) return t.skip("Chromium nicht verfügbar");
  await withMocks({ failLogin: true, persons: [person()] }, { persons: [sewobePerson()] }, {}, async (h) => {
    const api = await startApi(h);
    try {
      const response = await fetch(`${api.base}/sync`, { method: "POST", headers: AUTH, body: JSON.stringify({ vorname: "Erika", nachname: "Musterfrau" }) });
      assert.equal(response.status, 502);
    } finally {
      await api.close();
    }
  });
});

test("POST /members/new: Token Pflicht, ungültige Nummer 400, Treffer 200", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!chromiumReady) return t.skip("Chromium nicht verfügbar");
  await withMocks({}, { persons: [sewobePerson({ nr: "1002011000011" })] }, {}, async (h) => {
    const api = await startApi(h);
    try {
      const none = await fetch(`${api.base}/members/new`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(none.status, 401);
      const bad = await fetch(`${api.base}/members/new`, { method: "POST", headers: AUTH, body: JSON.stringify({ after: "42" }) });
      assert.equal(bad.status, 400);
      const ok = await fetch(`${api.base}/members/new`, { method: "POST", headers: AUTH, body: JSON.stringify({ after: "1002011000010", window: 2 }) });
      assert.equal(ok.status, 200);
      const body = (await ok.json()) as { found: boolean; highest: string };
      assert.equal(body.found, true);
      assert.equal(body.highest, "1002011000011");
    } finally {
      await api.close();
    }
  });
});
