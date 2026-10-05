import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBerlinLocal, toIscLocal } from "../../src/datetime.js";
import { overallTimeoutMs } from "../../src/timeout.js";
import { resolveCategories } from "../../src/categories.js";
import { ValidationError } from "../../src/errors.js";
import { RunLock } from "../../src/mutex.js";
import { isAuthorized } from "../../src/auth.js";
import { Logger } from "../../src/logger.js";
import { normalizeHtml } from "../../src/isc/news-form.js";
import { normalizeTitle } from "../../src/isc/duplicates.js";
import { parseEdv } from "../../src/isc/session.js";
import { MOCK_CATEGORIES } from "../fixtures/mock-isc.js";

test("Datum: Sommerzeit und Winterzeit für Europe/Berlin", () => {
  assert.equal(formatBerlinLocal(new Date("2026-07-01T12:00:00Z")), "2026-07-01T14:00");
  assert.equal(formatBerlinLocal(new Date("2026-01-15T12:00:00Z")), "2026-01-15T13:00");
});

test("Datum: lokales Format wird geprüft, nicht geraten", () => {
  assert.equal(toIscLocal("2026-03-29T12:00"), "2026-03-29T12:00");
  assert.equal(toIscLocal("2026-13-01T12:00"), undefined);
  assert.equal(toIscLocal("2026-10-05T25:00"), undefined);
  assert.equal(toIscLocal("2026-10-05 10:00"), undefined);
  assert.equal(toIscLocal("2026-10-05T10:00:00+02:00"), "2026-10-05T10:00");
});

test("Gesamt-Timeout: 120 s + Bilder × (Settle + 60 s)", () => {
  assert.equal(overallTimeoutMs(0, 60_000), 120_000);
  assert.equal(overallTimeoutMs(1, 60_000), 240_000);
  assert.equal(overallTimeoutMs(3, 60_000), 480_000);
  assert.equal(overallTimeoutMs(2, 5_000), 250_000);
});

test("Kategorien: IDs und Namen (case-insensitive) werden auf die Optionen abgebildet", () => {
  assert.deepEqual(resolveCategories(["4", "einsatzgruppe", "EDV"], MOCK_CATEGORIES), ["4", "5", "22607"]);
  assert.deepEqual(resolveCategories(["22607", "EDV", "22607"], MOCK_CATEGORIES), ["22607"]);
  assert.deepEqual(resolveCategories(["Lehrgänge/Kurse"], MOCK_CATEGORIES), ["3"]);
});

test("Kategorien: unbekannte Werte werden abgelehnt, nichts wird geraten", () => {
  assert.throws(
    () => resolveCategories(["Nicht vorhanden", "99999"], MOCK_CATEGORIES),
    (error: unknown) => error instanceof ValidationError && error.details.length === 2,
  );
  assert.throws(() => resolveCategories(["eDv "], []), ValidationError);
});

test("Titel-Abgleich für Duplikate: getrimmt und ohne Groß-/Kleinschreibung", () => {
  assert.equal(normalizeTitle("  Sommer  Fest "), normalizeTitle("sommer fest"));
  assert.notEqual(normalizeTitle("Sommerfest"), normalizeTitle("Sommer fest 2"));
});

test("HTML-Vergleich ignoriert Leerraum und geschützte Leerzeichen", () => {
  assert.equal(normalizeHtml("<p>test</p>\n"), normalizeHtml("<p>test</p>"));
  assert.equal(normalizeHtml("<p>a&nbsp;b</p>"), normalizeHtml("<p>a b</p>"));
  assert.notEqual(normalizeHtml("<p>a</p>"), normalizeHtml("<p>b</p>"));
});

test("Gliederung wird aus dem Titel-Attribut gelesen", () => {
  assert.equal(parseEdv("Ortsgruppe Andernach e.V. (1002011)"), "1002011");
  assert.equal(parseEdv("ohne Nummer"), undefined);
});

test("Auth: Bearer-Token, konstante Vergleichszeit über Hashes", () => {
  assert.equal(isAuthorized("Bearer geheim-123", "geheim-123"), true);
  assert.equal(isAuthorized("Bearer geheim-124", "geheim-123"), false);
  assert.equal(isAuthorized("Bearer ", "geheim-123"), false);
  assert.equal(isAuthorized("Basic geheim-123", "geheim-123"), false);
  assert.equal(isAuthorized(undefined, "geheim-123"), false);
});

test("Mutex: ein Lauf gleichzeitig, Wartende kommen dran", async () => {
  const lock = new RunLock(2000);
  const first = await lock.acquire();
  let secondGranted = false;
  const second = lock.acquire().then((release) => {
    secondGranted = true;
    return release;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(secondGranted, false);
  first();
  const releaseSecond = await second;
  assert.equal(secondGranted, true);
  releaseSecond();
  const third = await lock.acquire();
  third();
});

test("Mutex: Wartezeit überschritten ergibt BUSY", async () => {
  const lock = new RunLock(30);
  const release = await lock.acquire();
  await assert.rejects(lock.acquire(), (error: unknown) => error instanceof Error && (error as { code?: string }).code === "BUSY");
  release();
});

test("Logger: Geheimnisse und sensible Felder werden entfernt", () => {
  const log = new Logger();
  log.registerSecret("super-geheim-123");
  assert.equal(log.redact("Login mit super-geheim-123 fehlgeschlagen"), "Login mit *** fehlgeschlagen");
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    lines.push(chunk);
    return true;
  };
  try {
    log.info("test", {
      newsId: 7,
      password: "x",
      csrf: "y",
      cookie: "z",
      dataBase64: "AAAA",
      lastChangeAznzeige: "Name",
      note: "enthält super-geheim-123",
    });
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  const entry = JSON.parse(lines.join("")) as Record<string, unknown>;
  assert.equal(entry.newsId, 7);
  assert.equal(entry.note, "enthält ***");
  for (const forbidden of ["password", "csrf", "cookie", "dataBase64", "lastChangeAznzeige"]) {
    assert.equal(forbidden in entry, false, `${forbidden} darf nicht geloggt werden`);
  }
});
