import { test, before } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { IscNewsRunner, launchChromium } from "../../src/runner.js";
import { RunLock } from "../../src/mutex.js";
import { Logger } from "../../src/logger.js";
import { validateNewsRequest } from "../../src/validation.js";
import { startMockIsc, OTHER_EDV, type MockIsc, type MockOptions } from "../fixtures/mock-isc.js";
import { testConfig } from "../fixtures/config.js";
import { JPEG_BASE64, PNG_BASE64, WEBP_BASE64 } from "../fixtures/images.js";

const silent = new Logger(true);
const RUN_TIMEOUT = 180_000;

let browserAvailable = true;
before(async () => {
  try {
    const browser = await chromium.launch();
    await browser.close();
  } catch {
    browserAvailable = false;
  }
});

async function withMock(options: MockOptions, configOverrides: Parameters<typeof testConfig>[1], run: (mock: MockIsc, runner: IscNewsRunner, cfg: ReturnType<typeof testConfig>) => Promise<void>) {
  const mock = await startMockIsc(options);
  try {
    const cfg = testConfig(mock.baseUrl, configOverrides);
    const runner = new IscNewsRunner(cfg, launchChromium, new RunLock(cfg.lockWaitMs), silent);
    await run(mock, runner, cfg);
  } finally {
    await mock.close();
  }
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Sommerfest am See",
    subtitle: "Alle sind eingeladen",
    html: "<p>Am Samstag ab 14 Uhr.</p>",
    categories: ["DLRG Andernach", "22607"],
    images: [
      { fileName: "eins.png", mimeType: "image/png", dataBase64: PNG_BASE64 },
      { fileName: "zwei.jpg", mimeType: "image/jpeg", dataBase64: JPEG_BASE64 },
    ],
    ...overrides,
  };
}

test("Entwurf mit zwei Bildern: angelegt, gesperrt, Reihenfolge und Keywords stimmen", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({}, {}, async (mock, runner, cfg) => {
    const news = validateNewsRequest(body(), cfg);
    const result = await runner.createNews(news);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "gesperrt");
    assert.equal(result.mode, "draft");
    assert.equal(result.dryRun, false);
    assert.ok(result.newsId && result.newsId > 0);
    assert.equal(result.editUrl, `${cfg.iscBaseUrl}/apps/news?page=uebersicht&action=edit&ID=${result.newsId}`);
    assert.deepEqual(
      result.uploaded?.map((u) => u.fileName),
      ["eins.png", "zwei.jpg"],
    );

    assert.equal(mock.news.length, 1);
    const stored = mock.news[0];
    assert.ok(stored);
    assert.equal(stored.title, "Sommerfest am See");
    assert.equal(stored.subtitle, "Alle sind eingeladen");
    assert.equal(stored.html, "<p>Am Samstag ab 14 Uhr.</p>");
    assert.deepEqual(stored.categories.sort(), ["22607", "4"]);
    assert.equal(stored.status, "gesperrt");
    assert.deepEqual(
      stored.assets.map((a) => a.name),
      ["eins.png", "zwei.jpg"],
    );
    assert.deepEqual(
      stored.assets.map((a) => a.keywords),
      ["News", "News"],
    );
  });
});

test("Schlagworte pro Bild werden gesetzt und nicht vermischt", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({}, {}, async (mock, runner, cfg) => {
    const news = validateNewsRequest(
      body({
        images: [
          { fileName: "a.png", mimeType: "image/png", dataBase64: PNG_BASE64, keywords: ["Sommer", "See"] },
          { fileName: "b.webp", mimeType: "image/webp", dataBase64: WEBP_BASE64, keywords: ["Team"] },
        ],
      }),
      cfg,
    );
    const result = await runner.createNews(news);
    assert.equal(result.ok, true, JSON.stringify(result));
    const assets = mock.news[0]?.assets ?? [];
    assert.equal(assets[0]?.keywords, "Sommer,See");
    assert.equal(assets[1]?.keywords, "Team");
  });
});

test("Veröffentlichen: Status wechselt, Social-Text kommt zurück", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({ socialText: "Neu auf der Website: Sommerfest" }, {}, async (mock, runner, cfg) => {
    const result = await runner.createNews(validateNewsRequest(body({ mode: "publish" }), cfg));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "veroeffentlicht");
    assert.equal(result.socialText, "Neu auf der Website: Sommerfest");
    assert.equal(mock.news[0]?.status, "veroeffentlicht");
  });
});

test("Dry-Run: Formular geprüft, Screenshot da, nichts gespeichert", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({}, {}, async (mock, runner, cfg) => {
    const result = await runner.createNews(validateNewsRequest(body({ dryRun: true, mode: "publish" }), cfg));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.dryRun, true);
    assert.equal(result.newsId, undefined);
    assert.ok(result.screenshotBase64 && result.screenshotBase64.length > 1000);
    assert.equal(mock.news.length, 0);
    assert.equal(
      mock.requests.some((r) => r.startsWith("POST /apps/news?uebersicht") || r.includes("mediaService")),
      false,
    );
  });
});

test("Duplikat: gleicher Titel wird nicht erneut angelegt", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({}, {}, async (mock, runner, cfg) => {
    const first = await runner.createNews(validateNewsRequest(body({ images: [] }), cfg));
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await runner.createNews(validateNewsRequest(body({ images: [], title: "  sommerfest AM see " }), cfg));
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.duplicate, true);
    assert.equal(second.newsId, first.newsId);
    assert.equal(mock.news.length, 1);
  });
});

test("Duplikat mit force=true wird trotzdem angelegt", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({}, {}, async (mock, runner, cfg) => {
    await runner.createNews(validateNewsRequest(body({ images: [] }), cfg));
    const forced = await runner.createNews(validateNewsRequest(body({ images: [], force: true }), cfg));
    assert.equal(forced.ok, true, JSON.stringify(forced));
    assert.equal(forced.duplicate, undefined);
    assert.equal(mock.news.length, 2);
  });
});

test("Login abgelehnt: LOGIN_FAILED, nichts angelegt", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({ failLogin: true }, {}, async (mock, runner, cfg) => {
    const result = await runner.createNews(validateNewsRequest(body({ images: [] }), cfg));
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "LOGIN_FAILED");
    assert.equal(result.step, "login");
    assert.equal(result.newsId, undefined);
    assert.ok(result.screenshotBase64);
    assert.equal(mock.news.length, 0);
  });
});

test("Gliederungswechsel klappt: News landet in der Zielgliederung", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({}, { gliederungEdv: OTHER_EDV }, async (mock, runner, cfg) => {
    const result = await runner.createNews(validateNewsRequest(body({ images: [] }), cfg));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(mock.news[0]?.db, OTHER_EDV);
  });
});

test("Gliederungswechsel scheitert: WRONG_GLIEDERUNG, nie in falscher Gliederung speichern", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({ failSwitch: true }, { gliederungEdv: OTHER_EDV }, async (mock, runner, cfg) => {
    const result = await runner.createNews(validateNewsRequest(body({ images: [] }), cfg));
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "WRONG_GLIEDERUNG");
    assert.equal(result.step, "gliederung");
    assert.equal(mock.news.length, 0);
  });
});

test("Unbekannte Kategorie: VALIDATION_FAILED, nichts angelegt", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({}, {}, async (mock, runner, cfg) => {
    const result = await runner.createNews(validateNewsRequest(body({ categories: ["Gibt es nicht"], images: [] }), cfg));
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "VALIDATION_FAILED");
    assert.equal(mock.news.length, 0);
  });
});

test("Parsley-Fehler im ISC: VALIDATION_FAILED mit den Texten des Formulars", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({}, {}, async (mock, runner, cfg) => {
    const result = await runner.createNews(validateNewsRequest(body({ images: [], author: "FORMFEHLER Test" }), cfg));
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "VALIDATION_FAILED");
    assert.deepEqual(result.details, ["Autor enthält ungültige Zeichen"]);
    assert.equal(mock.news.length, 0);
  });
});

test("Formular ohne erkennbaren Editor: FORM_CHANGED", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({ noEditor: true }, {}, async (mock, runner, cfg) => {
    const result = await runner.createNews(validateNewsRequest(body({ images: [] }), cfg));
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "FORM_CHANGED");
    assert.equal(result.step, "form");
    assert.equal(mock.news.length, 0);
  });
});

test("Speichern nicht bestätigt: SAVE_UNCONFIRMED mit newsId", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({ saveUnconfirmedFor: "SPEICHERFEHLER" }, {}, async (mock, runner, cfg) => {
    const result = await runner.createNews(validateNewsRequest(body({ title: "SPEICHERFEHLER Test", images: [] }), cfg));
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "SAVE_UNCONFIRMED");
    assert.equal(result.newsId, mock.news[0]?.id);
    assert.ok(result.screenshotBase64);
  });
});

test("Upload-Fehler: UPLOAD_FAILED, News bleibt als Entwurf mit newsId", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({ failUploadFor: "kaputt" }, {}, async (mock, runner, cfg) => {
    const result = await runner.createNews(
      validateNewsRequest(
        body({ images: [{ fileName: "kaputt.png", mimeType: "image/png", dataBase64: PNG_BASE64 }] }),
        cfg,
      ),
    );
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "UPLOAD_FAILED");
    assert.equal(result.step, "upload");
    assert.equal(result.newsId, mock.news[0]?.id);
    assert.equal(mock.news[0]?.status, "gesperrt");
    assert.equal(mock.news[0]?.assets.length, 0);
  });
});

test("ISC nicht erreichbar: LOGIN_UNEXPECTED, Browser wird trotzdem beendet", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({}, { stepTimeoutMs: 1000 }, async (_mock, _runner, cfg) => {
    const slow = new IscNewsRunner(
      { ...cfg, iscBaseUrl: "http://127.0.0.1:9" },
      launchChromium,
      new RunLock(cfg.lockWaitMs),
      silent,
    );
    const result = await slow.createNews(validateNewsRequest(body({ images: [] }), cfg));
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "LOGIN_UNEXPECTED", JSON.stringify(result));
    assert.equal(result.step, "login");
  });
});

test("Kategorien lesen liefert die Optionen der Gliederung", { timeout: RUN_TIMEOUT }, async (t) => {
  if (!browserAvailable) return t.skip("Chromium nicht verfügbar");
  await withMock({}, {}, async (_mock, runner) => {
    const result = await runner.listCategories();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.categories.length, 12);
    assert.ok(result.categories.some((c) => c.value === "22607" && c.name === "EDV"));
  });
});
