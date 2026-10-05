import { test } from "node:test";
import assert from "node:assert/strict";
import { validateNewsRequest } from "../../src/validation.js";
import { ValidationError } from "../../src/errors.js";
import { testConfig } from "../fixtures/config.js";
import { JPEG_BASE64, PNG_BASE64, WEBP_BASE64 } from "../fixtures/images.js";

const cfg = testConfig("https://example.invalid");
const NOW = new Date("2026-10-05T08:30:00Z");

function expectInvalid(body: unknown, fragment: string): ValidationError {
  try {
    validateNewsRequest(body, cfg, NOW);
  } catch (error) {
    assert.ok(error instanceof ValidationError, `erwartet ValidationError, war ${String(error)}`);
    assert.ok(
      error.details.some((d) => d.includes(fragment)) || error.message.includes(fragment),
      `Fragment "${fragment}" fehlt in ${JSON.stringify(error.details)} / ${error.message}`,
    );
    return error;
  }
  assert.fail(`erwartet Fehler mit "${fragment}"`);
}

test("minimale Eingabe bekommt Defaults", () => {
  const news = validateNewsRequest({ title: "  Sommerfest  ", html: "<p>Hallo</p>" }, cfg, NOW);
  assert.equal(news.title, "Sommerfest");
  assert.equal(news.type, "text");
  assert.equal(news.mode, "draft");
  assert.equal(news.author, cfg.defaultAuthor);
  assert.equal(news.authorEmail, cfg.defaultAuthorEmail);
  assert.equal(news.startDate, "2026-10-05T10:30");
  assert.equal(news.archiveDate, undefined);
  assert.equal(news.force, false);
  assert.equal(news.dryRun, false);
  assert.deepEqual(news.images, []);
});

test("Titel ist Pflicht", () => {
  expectInvalid({ html: "<p>x</p>" }, "title fehlt");
});

test("Text ist bei type=text Pflicht", () => {
  expectInvalid({ title: "Abc", type: "text" }, "html (Text) fehlt");
});

test("type=link braucht eine http(s)-URL", () => {
  expectInvalid({ title: "Abc", type: "link", link: "ftp://x" }, "link muss eine http(s)-URL sein");
  const news = validateNewsRequest({ title: "Abc", type: "link", link: "https://dlrg.net/x" }, cfg, NOW);
  assert.equal(news.link, "https://dlrg.net/x");
});

test("type=typo3 braucht eine positive Seiten-ID", () => {
  expectInvalid({ title: "Abc", type: "typo3", typo3Id: 0 }, "typo3Id");
  assert.equal(validateNewsRequest({ title: "Abc", type: "typo3", typo3Id: 42 }, cfg, NOW).typo3Id, 42);
});

test("unbekannter type und mode werden abgelehnt", () => {
  expectInvalid({ title: "Abc", html: "x", type: "video" }, "type muss");
  expectInvalid({ title: "Abc", html: "x", mode: "live" }, "mode muss");
});

test("Kategorien: Zahlen und Strings, leere Strings verboten", () => {
  const news = validateNewsRequest({ title: "Abc", html: "x", categories: [4, " EDV "] }, cfg, NOW);
  assert.deepEqual(news.categories, ["4", "EDV"]);
  expectInvalid({ title: "Abc", html: "x", categories: [""] }, "ungültiger Kategorie-Eintrag");
  expectInvalid({ title: "Abc", html: "x", categories: "EDV" }, "categories muss eine Liste sein");
});

test("Datum: lokales Format bleibt, Zeitzonenangaben werden nach Europe/Berlin gewandelt", () => {
  const news = validateNewsRequest(
    { title: "Abc", html: "x", startDate: "2026-07-01T12:00:00Z", archiveDate: "2026-12-01T10:00" },
    cfg,
    NOW,
  );
  assert.equal(news.startDate, "2026-07-01T14:00");
  assert.equal(news.archiveDate, "2026-12-01T10:00");
});

test("ungültige Kalenderdaten werden abgelehnt", () => {
  expectInvalid({ title: "Abc", html: "x", startDate: "2026-02-30T10:00" }, "startDate ist kein gültiges Datum");
  expectInvalid({ title: "Abc", html: "x", startDate: "gestern" }, "startDate ist kein gültiges Datum");
});

test("Archiv- und Verbergen-Datum dürfen nicht vor dem Start liegen", () => {
  expectInvalid({ title: "Abc", html: "x", startDate: "2026-10-10T10:00", archiveDate: "2026-10-09T10:00" }, "archiveDate liegt vor startDate");
  expectInvalid({ title: "Abc", html: "x", startDate: "2026-10-10T10:00", endDate: "2026-10-09T10:00" }, "endDate liegt vor startDate");
});

test("authorEmail ohne Umlaute und ß", () => {
  expectInvalid({ title: "Abc", html: "x", authorEmail: "müller@example.de" }, "authorEmail ist keine gültige Adresse");
  expectInvalid({ title: "Abc", html: "x", authorEmail: "kein-at" }, "authorEmail ist keine gültige Adresse");
});

test("Bilder: Reihenfolge bleibt, Keywords-Default kommt aus der Konfiguration", () => {
  const news = validateNewsRequest(
    {
      title: "Abc",
      html: "x",
      images: [
        { fileName: "eins.png", mimeType: "image/png", dataBase64: PNG_BASE64 },
        { fileName: "zwei.jpg", mimeType: "image/jpeg", dataBase64: JPEG_BASE64, keywords: ["Sommer"] },
        { fileName: "drei.webp", mimeType: "image/webp", dataBase64: WEBP_BASE64 },
      ],
    },
    cfg,
    NOW,
  );
  assert.deepEqual(
    news.images.map((i) => i.fileName),
    ["eins.png", "zwei.jpg", "drei.webp"],
  );
  assert.deepEqual(news.images[0]?.keywords, ["News"]);
  assert.deepEqual(news.images[1]?.keywords, ["Sommer"]);
});

test("Bild: Dateiinhalt muss zum MIME-Typ passen", () => {
  expectInvalid(
    { title: "Abc", html: "x", images: [{ fileName: "fake.png", mimeType: "image/png", dataBase64: JPEG_BASE64 }] },
    "Dateiinhalt passt nicht zu image/png",
  );
});

test("Bild: MIME-Typ und Dateiname sind eingeschränkt", () => {
  expectInvalid(
    { title: "Abc", html: "x", images: [{ fileName: "x.png", mimeType: "image/gif", dataBase64: PNG_BASE64 }] },
    "mimeType muss",
  );
  expectInvalid(
    { title: "Abc", html: "x", images: [{ fileName: "../../etc/passwd.png", mimeType: "image/png", dataBase64: PNG_BASE64 }] },
    "fileName muss",
  );
});

test("Bild: kaputtes Base64 und Größenlimit", () => {
  expectInvalid(
    { title: "Abc", html: "x", images: [{ fileName: "a.png", mimeType: "image/png", dataBase64: "@@@" }] },
    "ungültiges Base64",
  );
  const small = testConfig("https://example.invalid", { maxImageBytes: 10 });
  assert.throws(
    () => validateNewsRequest({ title: "Abc", html: "x", images: [{ fileName: "a.png", mimeType: "image/png", dataBase64: PNG_BASE64 }] }, small, NOW),
    (error: unknown) => error instanceof ValidationError && error.details.some((d) => d.includes("zu groß")),
  );
});

test("Data-URI-Präfix wird akzeptiert", () => {
  const news = validateNewsRequest(
    { title: "Abc", html: "x", images: [{ fileName: "a.png", mimeType: "image/png", dataBase64: `data:image/png;base64,${PNG_BASE64}` }] },
    cfg,
    NOW,
  );
  assert.equal(news.images.length, 1);
});

test("Alle Fehler werden gesammelt zurückgegeben", () => {
  try {
    validateNewsRequest({ html: "", type: "link", mode: "x", authorEmail: "nein" }, cfg, NOW);
    assert.fail("erwartet Fehler");
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    assert.ok(error.details.length >= 4, JSON.stringify(error.details));
  }
});

test("Body muss ein Objekt sein", () => {
  expectInvalid([1, 2], "Request-Body muss ein JSON-Objekt sein");
});
