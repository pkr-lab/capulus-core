import { test } from "node:test";
import assert from "node:assert/strict";
import { isoPrefix, parseGermanDate } from "../../src/datetime.js";
import { BotError, ValidationError } from "../../src/errors.js";
import { isAuthorized } from "../../src/auth.js";
import { Logger } from "../../src/logger.js";
import { RunLock } from "../../src/mutex.js";
import { collapse, normalizeName, scrubMessage } from "../../src/text.js";
import { loadConfig, normalizeTotpSecret } from "../../src/config.js";
import { validateNewMembersRequest, validateSyncRequest } from "../../src/validation.js";
import { parseEdv } from "../../src/isc/session.js";
import { resolveCountry } from "../../src/isc/personen.js";
import { selectHit, type Hit } from "../../src/sewobe/search.js";

test("Datum: TT.MM.JJJJ wird korrekt nach ISO umgewandelt", () => {
  assert.equal(parseGermanDate("17.05.1990"), "1990-05-17");
  assert.equal(parseGermanDate("1.2.2000"), "2000-02-01");
  assert.equal(parseGermanDate(" 29.02.2024 "), "2024-02-29");
});

test("Datum: ungültige Daten werden nicht geraten", () => {
  assert.equal(parseGermanDate("31.02.2024"), undefined);
  assert.equal(parseGermanDate("29.02.2023"), undefined);
  assert.equal(parseGermanDate("1990-05-17"), undefined);
  assert.equal(parseGermanDate("17.05.90"), undefined);
  assert.equal(parseGermanDate(""), undefined);
  assert.equal(parseGermanDate("17.05.1800"), undefined);
});

test("Datum: ISO-Präfix aus Datum mit Uhrzeit", () => {
  assert.equal(isoPrefix("1990-05-17"), "1990-05-17");
  assert.equal(isoPrefix("1990-05-17T00:00:00"), "1990-05-17");
  assert.equal(isoPrefix("kaputt"), "");
});

test("Text: Namen werden getrimmt, zusammengefasst und ohne Groß-/Kleinschreibung verglichen", () => {
  assert.equal(collapse("  Anna   Lena "), "Anna Lena");
  assert.equal(normalizeName(" MÜLLER  "), normalizeName("müller"));
  assert.notEqual(normalizeName("Meier"), normalizeName("Meyer"));
});

test("Text: Fehlermeldungen verlieren URLs und lange Zahlen", () => {
  const cleaned = scrubMessage("Fehler bei https://dlrg.net/apps/personen?uid=2264006 und 1002011000001");
  assert.equal(cleaned.includes("https"), false);
  assert.equal(/\d{6,}/.test(cleaned), false);
});

test("Validierung: gültige Anfrage und Standardwerte", () => {
  assert.deepEqual(validateSyncRequest({ vorname: " Erika ", nachname: "Muster  frau" }), {
    vorname: "Erika",
    nachname: "Muster frau",
    mitgliedsnummer: undefined,
    dryRun: false,
  });
  const full = validateSyncRequest({ vorname: "A", nachname: "B", mitgliedsnummer: "1002011000001", dryRun: true });
  assert.equal(full.mitgliedsnummer, "1002011000001");
  assert.equal(full.dryRun, true);
});

test("Validierung: fehlende, leere und falsche Werte werden gesammelt abgelehnt", () => {
  assert.throws(
    () => validateSyncRequest({ vorname: "", nachname: 5, mitgliedsnummer: "123", dryRun: "ja" }),
    (error: unknown) => error instanceof ValidationError && error.details.length === 4,
  );
  assert.throws(() => validateSyncRequest(null), ValidationError);
  assert.throws(() => validateSyncRequest([]), ValidationError);
  assert.throws(() => validateSyncRequest({ vorname: "A\u0000B", nachname: "C" }), ValidationError);
});

test("Konfiguration: Pflichtwerte, https-Zwang und Base32-Secret", () => {
  const base = {
    API_TOKEN: "t",
    ISC_USERNAME: "u",
    ISC_PASSWORD: "p",
    SEWOBE_USERNAME: "su",
    SEWOBE_PASSWORD: "sp",
    SEWOBE_TOTP_SECRET: "gezd gnbv-gy3t qojq gezd gnbv gy3t qojq",
  };
  const cfg = loadConfig(base);
  assert.equal(cfg.sewobeTotpSecret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(cfg.iscBaseUrl, "https://dlrg.net");
  assert.equal(cfg.sewobeBaseUrl, "https://mv.dlrg.net");
  assert.equal(cfg.gliederungEdv, "1002011");
  assert.throws(() => loadConfig({ ...base, SEWOBE_PASSWORD: "" }), /SEWOBE_PASSWORD/);
  assert.throws(() => loadConfig({ ...base, SEWOBE_TOTP_SECRET: "kein base32!" }), /Base32/);
  assert.throws(() => loadConfig({ ...base, SEWOBE_BASE_URL: "http://mv.dlrg.net" }), /https/);
  assert.equal(loadConfig({ ...base, SEWOBE_BASE_URL: "http://127.0.0.1:1", ALLOW_HTTP_SEWOBE: "true" }).sewobeBaseUrl, "http://127.0.0.1:1");
  assert.throws(() => normalizeTotpSecret("ABC"), /Base32/);
});

test("Gliederung wird aus dem Titel-Attribut gelesen", () => {
  assert.equal(parseEdv("Ortsgruppe Andernach e.V. (1002011)"), "1002011");
  assert.equal(parseEdv("ohne Nummer"), undefined);
});

test("Land: Auswahl über den Anzeigenamen, unbekannte Länder werden abgelehnt", () => {
  const options = [
    { value: "", text: "" },
    { value: "DE", text: "Deutschland" },
    { value: "AT", text: "Österreich" },
  ];
  assert.equal(resolveCountry(options, "deutschland"), "DE");
  assert.equal(resolveCountry(options, "Österreich"), "AT");
  assert.throws(
    () => resolveCountry(options, "Atlantis"),
    (error: unknown) => error instanceof BotError && error.code === "LAND_UNBEKANNT",
  );
});

function hit(overrides: Partial<Hit> = {}): Hit {
  return { active: true, company: "Musterfrau, Erika", number: "1002011000001", href: "/x", ...overrides };
}

test("SEWOBE-Treffer: genau ein aktiver exakter Treffer wird gewählt", () => {
  const selection = selectHit([hit(), hit({ company: "Musterfrau, Erika Maria", number: "1002011000002" })], "Erika", "Musterfrau", undefined);
  assert.equal(selection.kind, "found");
});

test("SEWOBE-Treffer: kein exakter Treffer ist ein Fehler", () => {
  assert.throws(
    () => selectHit([hit({ company: "Musterfrau, Erika Maria" })], "Erika", "Musterfrau", undefined),
    (error: unknown) => error instanceof BotError && error.code === "SEWOBE_NO_MATCH",
  );
  assert.throws(() => selectHit([], "Erika", "Musterfrau", undefined), BotError);
});

test("SEWOBE-Treffer: mehrere aktive Treffer sind uneindeutig, die Mitgliedsnummer löst auf", () => {
  const hits = [hit(), hit({ number: "1002011000002" })];
  assert.throws(
    () => selectHit(hits, "Erika", "Musterfrau", undefined),
    (error: unknown) => error instanceof BotError && error.code === "SEWOBE_AMBIGUOUS",
  );
  const selection = selectHit(hits, "Erika", "Musterfrau", "1002011000002");
  assert.equal(selection.kind === "found" && selection.hit.number, "1002011000002");
  assert.throws(() => selectHit(hits, "Erika", "Musterfrau", "1002011000009"), BotError);
});

test("SEWOBE-Treffer: nicht aktive Person wird übersprungen", () => {
  assert.equal(selectHit([hit({ active: false })], "Erika", "Musterfrau", undefined).kind, "inactive");
  assert.equal(selectHit([hit({ active: false }), hit()], "Erika", "Musterfrau", undefined).kind, "found");
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
  (await lock.acquire())();
});

test("Mutex: Wartezeit überschritten ergibt BUSY", async () => {
  const lock = new RunLock(30);
  const release = await lock.acquire();
  await assert.rejects(lock.acquire(), (error: unknown) => error instanceof BotError && error.code === "BUSY");
  release();
});

function captureStdout(work: () => void): string {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    lines.push(chunk);
    return true;
  };
  try {
    work();
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  return lines.join("");
}

test("Logger: Geheimnisse und personenbezogene Felder werden entfernt", () => {
  const log = new Logger();
  log.registerSecret("super-geheim-123");
  assert.equal(log.redact("Login mit super-geheim-123 fehlgeschlagen"), "Login mit *** fehlgeschlagen");
  const output = captureStdout(() =>
    log.info("test", {
      result: "updated",
      errorCode: "TIMEOUT",
      changedCount: 2,
      password: "x",
      totpCode: "123456",
      vorname: "Erika",
      nachname: "Musterfrau",
      geburtstag: "1990-05-17",
      diff: [{ field: "x" }],
      uid: 7,
      note: "enthält super-geheim-123",
    }),
  );
  const entry = JSON.parse(output) as Record<string, unknown>;
  assert.equal(entry.result, "updated");
  assert.equal(entry.errorCode, "TIMEOUT");
  assert.equal(entry.changedCount, 2);
  assert.equal(entry.note, "enthält ***");
  for (const forbidden of ["password", "totpCode", "vorname", "nachname", "geburtstag", "diff", "uid"]) {
    assert.equal(forbidden in entry, false, `${forbidden} darf nicht geloggt werden`);
  }
});

test("Validierung neue Mitglieder: Standardfenster, Zahl als Nummer und Grenzen", () => {
  assert.deepEqual(validateNewMembersRequest({ after: "1002011000042" }), { after: "1002011000042", window: 10 });
  assert.deepEqual(validateNewMembersRequest({ after: 1002011000042, window: 25 }), { after: "1002011000042", window: 25 });
  assert.throws(() => validateNewMembersRequest({}), ValidationError);
  assert.throws(() => validateNewMembersRequest({ after: "42" }), ValidationError);
  assert.throws(() => validateNewMembersRequest({ after: "1002011000042", window: 0 }), ValidationError);
  assert.throws(() => validateNewMembersRequest({ after: "1002011000042", window: 26 }), ValidationError);
  assert.throws(() => validateNewMembersRequest([]), ValidationError);
});
