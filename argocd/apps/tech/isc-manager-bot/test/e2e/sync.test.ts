import { test, before } from "node:test";
import assert from "node:assert/strict";
import { browserAvailable } from "../fixtures/browser.js";
import { withMocks } from "../fixtures/harness.js";
import { MOCK_GLIEDERUNG, MOCK_PASS, OTHER_EDV, person, type MockPerson } from "../fixtures/mock-isc.js";
import { SEWOBE_PASS, SEWOBE_TOTP_SECRET, sewobePerson } from "../fixtures/mock-sewobe.js";
import { Logger } from "../../src/logger.js";
import { totpCode } from "../../src/totp.js";
import type { ParsedSync } from "../../src/validation.js";

const RUN_TIMEOUT = 180_000;
const NR = "1002011000001";

let chromiumReady = true;
before(async () => {
  chromiumReady = await browserAvailable();
});

function request(overrides: Partial<ParsedSync> = {}): ParsedSync {
  return { vorname: "Erika", nachname: "Musterfrau", mitgliedsnummer: undefined, dryRun: false, ...overrides };
}

function withAddress(overrides: Partial<MockPerson> = {}): MockPerson {
  return person({
    dlrgManagerId: NR,
    addresses: [{ id: 7, typ: "Private Anschrift", strasse: "Hauptstraße 1", plz: "56626", ort: "Andernach", country: "DE" }],
    ...overrides,
  });
}

const sync = (name: string, fn: () => Promise<void>): void => {
  test(name, { timeout: RUN_TIMEOUT }, async (t) => {
    if (!chromiumReady) return t.skip("Chromium nicht verfügbar");
    await fn();
  });
};

sync("Neue Person: wird mit Id, Adresse und Mitgliedschaft angelegt, beide Systeme abgemeldet", async () => {
  await withMocks({}, { persons: [sewobePerson()] }, {}, async ({ isc, sewobe, runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result, "created");
    assert.deepEqual(result.changedFields, [
      "vorname",
      "nachname",
      "geburtsdatum",
      "geschlecht",
      "dlrgManagerId",
      "strasse",
      "plz",
      "ort",
      "land",
      "mitgliedschaft",
    ]);
    assert.equal("diff" in result, false);
    assert.equal(isc.persons.length, 1);
    const stored = isc.persons[0];
    assert.ok(stored);
    assert.equal(stored.vorname, "Erika");
    assert.equal(stored.name, "Musterfrau");
    assert.equal(stored.gebDate, "1990-05-17");
    assert.equal(stored.gender, "1");
    assert.equal(stored.dlrgManagerId, NR);
    assert.deepEqual(stored.memberships, [MOCK_GLIEDERUNG]);
    assert.equal(stored.addresses.length, 1);
    assert.equal(stored.addresses[0]?.strasse, "Hauptstraße 1");
    assert.equal(stored.addresses[0]?.country, "DE");
    assert.equal(isc.logouts(), 1);
    assert.equal(sewobe.logouts(), 1);
  });
});

sync("Idempotenz: derselbe Abgleich zweimal ergibt keine zweite Person, der zweite Lauf ist unchanged", async () => {
  await withMocks({}, { persons: [sewobePerson()] }, {}, async ({ isc, runner }) => {
    assert.equal((await runner.sync(request())).result, "created");
    const writesAfterFirst = isc.writes.length;
    const second = await runner.sync(request());
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.result, "unchanged");
    assert.equal("changedFields" in second, false);
    assert.equal(isc.persons.length, 1);
    assert.equal(isc.writes.length, writesAfterFirst);
  });
});

sync("Gleichzeitige Anfragen: serialisiert, genau eine Person", async () => {
  await withMocks({}, { persons: [sewobePerson()] }, {}, async ({ isc, runner }) => {
    const [a, b] = await Promise.all([runner.sync(request()), runner.sync(request())]);
    assert.deepEqual([a.result, b.result].sort(), ["created", "unchanged"]);
    assert.equal(isc.persons.length, 1);
  });
});

sync("Id-Treffer: nur geänderte Felder werden gespeichert, vorhandene Adresse wird nicht verdoppelt", async () => {
  const existing = withAddress({ gender: "0", addresses: [{ id: 7, typ: "Private Anschrift", strasse: "Hauptstraße 1", plz: "56626", ort: "Koblenz", country: "DE" }] });
  await withMocks({ persons: [existing] }, { persons: [sewobePerson()] }, {}, async ({ isc, runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result, "updated");
    assert.deepEqual(result.changedFields, ["geschlecht", "ort"]);
    assert.deepEqual(isc.writes, ["grunddaten", "address"]);
    assert.equal(isc.persons.length, 1);
    const stored = isc.persons[0];
    assert.equal(stored?.gender, "1");
    assert.equal(stored?.addresses.length, 1);
    assert.equal(stored?.addresses[0]?.ort, "Andernach");
    assert.equal(stored?.addresses[0]?.id, 7);
    assert.equal(stored?.addresses[0]?.strasse, "Hauptstraße 1");
  });
});

sync("Leere SEWOBE-Felder überschreiben nichts im ISC", async () => {
  const existing = withAddress({ gender: "0", addresses: [{ id: 7, typ: "Private Anschrift", strasse: "Alte Str. 9", plz: "11111", ort: "Altstadt", country: "AT" }] });
  const sparse = sewobePerson({ anrede: "Keine Anrede", strasse: "", plz: "", ort: "", land: "" });
  await withMocks({ persons: [existing] }, { persons: [sparse] }, {}, async ({ isc, runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.result, "unchanged", JSON.stringify(result));
    assert.deepEqual(result.warnings, ["GESCHLECHT_NICHT_GESETZT"]);
    assert.deepEqual(isc.writes, []);
    assert.equal(isc.persons[0]?.gender, "0");
    assert.equal(isc.persons[0]?.addresses[0]?.strasse, "Alte Str. 9");
  });
});

sync("Fallback: Treffer über Vorname, Name, Geburtsdatum ohne Id setzt die Id und legt niemanden neu an", async () => {
  await withMocks({ persons: [withAddress({ dlrgManagerId: "" })] }, { persons: [sewobePerson()] }, {}, async ({ isc, runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.result, "updated", JSON.stringify(result));
    assert.deepEqual(result.changedFields, ["dlrgManagerId"]);
    assert.equal(isc.persons.length, 1);
    assert.equal(isc.persons[0]?.dlrgManagerId, NR);
  });
});

sync("Konflikt: gleicher Name und Geburtsdatum, aber andere Id: Fehler, nichts geändert", async () => {
  await withMocks({ persons: [withAddress({ dlrgManagerId: "1002011000099" })] }, { persons: [sewobePerson()] }, {}, async ({ isc, sewobe, runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.ok, false);
    assert.equal(result.result, "error");
    assert.equal(result.errorCode, "ISC_CONFLICT");
    assert.deepEqual(isc.writes, []);
    assert.equal(isc.persons.length, 1);
    assert.equal(isc.logouts(), 1);
    assert.equal(sewobe.logouts(), 1);
  });
});

sync("Mehrere ISC-Treffer ohne Id: Fehler, nichts geändert", async () => {
  const persons = [person({ uid: 1 }), person({ uid: 2 })];
  await withMocks({ persons }, { persons: [sewobePerson()] }, {}, async ({ isc, runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.errorCode, "ISC_AMBIGUOUS");
    assert.deepEqual(isc.writes, []);
  });
});

sync("Dry-Run: Diff nur in der Antwort, im ISC wird nichts gespeichert (Neuanlage)", async () => {
  await withMocks({}, { persons: [sewobePerson()] }, {}, async ({ isc, runner }) => {
    const result = await runner.sync(request({ dryRun: true }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result, "created");
    assert.equal(result.dryRun, true);
    assert.ok(result.diff?.some((c) => c.field === "vorname" && c.old === "" && c.new === "Erika"));
    assert.ok(result.diff?.some((c) => c.field === "geschlecht" && c.new === "weiblich"));
    assert.deepEqual(isc.writes, []);
    assert.equal(isc.persons.length, 0);
  });
});

sync("Dry-Run: Diff mit Alt- und Neuwert bei bestehender Person, nichts gespeichert", async () => {
  const existing = withAddress({ vorname: "Erik", addresses: [{ id: 7, typ: "Private Anschrift", strasse: "Hauptstraße 1", plz: "56626", ort: "Koblenz", country: "DE" }] });
  await withMocks({ persons: [existing] }, { persons: [sewobePerson()] }, {}, async ({ isc, runner }) => {
    const result = await runner.sync(request({ dryRun: true }));
    assert.equal(result.result, "updated");
    assert.deepEqual(result.diff, [
      { field: "vorname", old: "Erik", new: "Erika" },
      { field: "ort", old: "Koblenz", new: "Andernach" },
    ]);
    assert.deepEqual(result.changedFields, ["vorname", "ort"]);
    assert.deepEqual(isc.writes, []);
    assert.equal(isc.persons[0]?.vorname, "Erik");
  });
});

sync("Ausgetretene oder nicht aktive Person wird übersprungen", async () => {
  await withMocks({}, { persons: [sewobePerson({ active: false })] }, {}, async ({ isc, sewobe, runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.ok, true);
    assert.equal(result.result, "skipped");
    assert.ok(result.reason);
    assert.equal(isc.persons.length, 0);
    assert.equal(isc.logouts(), 1);
    assert.equal(sewobe.logouts(), 1);
  });
});

sync("SEWOBE: kein Treffer und mehrere Treffer sind Fehler, die Mitgliedsnummer löst Mehrdeutigkeit", async () => {
  const twins = [sewobePerson({ id: 1, nr: NR }), sewobePerson({ id: 2, nr: "1002011000002", geburtstag: "01.01.1980" })];
  await withMocks({}, { persons: twins }, {}, async ({ isc, runner }) => {
    assert.equal((await runner.sync(request({ vorname: "Nobody", nachname: "Nowhere" }))).errorCode, "SEWOBE_NO_MATCH");
    assert.equal((await runner.sync(request())).errorCode, "SEWOBE_AMBIGUOUS");
    assert.equal(isc.persons.length, 0);
    const resolved = await runner.sync(request({ mitgliedsnummer: "1002011000002" }));
    assert.equal(resolved.result, "created", JSON.stringify(resolved));
    assert.equal(isc.persons[0]?.gebDate, "1980-01-01");
  });
});

sync("SEWOBE-Daten unvollständig: SEWOBE_DATA_INVALID ohne ISC-Änderung", async () => {
  await withMocks({}, { persons: [sewobePerson({ geburtstag: "" })] }, {}, async ({ isc, runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.errorCode, "SEWOBE_DATA_INVALID");
    assert.deepEqual(isc.writes, []);
  });
});

sync("Anrede: Divers setzt divers, Keine Anrede bricht die Neuanlage ab", async () => {
  await withMocks({}, { persons: [sewobePerson({ anrede: "Divers" })] }, {}, async ({ isc, runner }) => {
    assert.equal((await runner.sync(request())).result, "created");
    assert.equal(isc.persons[0]?.gender, "2");
  });
  await withMocks({}, { persons: [sewobePerson({ anrede: "Keine Anrede" })] }, {}, async ({ isc, runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.errorCode, "GESCHLECHT_FEHLT");
    assert.equal(isc.persons.length, 0);
    assert.deepEqual(isc.writes, []);
  });
});

sync("Land aus SEWOBE ohne Entsprechung im ISC: LAND_UNBEKANNT, auch im Dry-Run", async () => {
  await withMocks({}, { persons: [sewobePerson({ land: "Atlantis" })] }, {}, async ({ isc, runner }) => {
    assert.equal((await runner.sync(request({ dryRun: true }))).errorCode, "LAND_UNBEKANNT");
    assert.equal((await runner.sync(request())).errorCode, "LAND_UNBEKANNT");
    assert.equal(isc.persons.length, 0);
  });
});

sync("Fehlende Mitgliedschaft wird ergänzt und nur einmal angelegt", async () => {
  await withMocks({ persons: [withAddress({ memberships: [] })] }, { persons: [sewobePerson()] }, {}, async ({ isc, runner }) => {
    const first = await runner.sync(request());
    assert.equal(first.result, "updated", JSON.stringify(first));
    assert.deepEqual(first.changedFields, ["mitgliedschaft"]);
    assert.deepEqual(isc.persons[0]?.memberships, [MOCK_GLIEDERUNG]);
    assert.equal((await runner.sync(request())).result, "unchanged");
    assert.deepEqual(isc.persons[0]?.memberships, [MOCK_GLIEDERUNG]);
  });
});

sync("Neuanlage ohne automatische Mitgliedschaft: Bot ergänzt sie", async () => {
  await withMocks({ noAutoMembership: true }, { persons: [sewobePerson()] }, {}, async ({ isc, runner }) => {
    assert.equal((await runner.sync(request())).result, "created");
    assert.deepEqual(isc.persons[0]?.memberships, [MOCK_GLIEDERUNG]);
  });
});

sync("2FA: abgelehnter Code wird einmal wiederholt, danach TOTP_FAILED", async () => {
  await withMocks({}, { persons: [sewobePerson()], rejectCodes: 1 }, {}, async ({ sewobe, runner }) => {
    const result = await runner.sync(request({ dryRun: true }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(sewobe.submittedCodes.length, 2);
    assert.match(sewobe.submittedCodes[0] ?? "", /^\d{6}$/);
  });
  await withMocks({}, { persons: [sewobePerson()], rejectCodes: 2 }, {}, async ({ isc, sewobe, runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.errorCode, "TOTP_FAILED");
    assert.equal(sewobe.submittedCodes.length, 2);
    assert.equal(isc.persons.length, 0);
    assert.equal(isc.logouts(), 1);
  });
});

sync("Login-Fehler in ISC und SEWOBE werden gemeldet", async () => {
  await withMocks({ failLogin: true }, { persons: [sewobePerson()] }, {}, async ({ runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.errorCode, "LOGIN_FAILED");
    assert.equal(result.step, "isc-login");
  });
  await withMocks({}, { persons: [sewobePerson()], failLogin: true }, {}, async ({ isc, runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.errorCode, "LOGIN_FAILED");
    assert.equal(result.step, "sewobe-login");
    assert.equal(isc.logouts(), 1);
  });
});

sync("Gliederung: falsche aktive Gliederung wird umgeschaltet, sonst WRONG_GLIEDERUNG", async () => {
  await withMocks({ activeEdv: OTHER_EDV }, { persons: [sewobePerson()] }, {}, async ({ runner }) => {
    assert.equal((await runner.sync(request({ dryRun: true }))).ok, true);
  });
  await withMocks({ activeEdv: OTHER_EDV, failSwitch: true }, { persons: [sewobePerson()] }, {}, async ({ runner }) => {
    assert.equal((await runner.sync(request())).errorCode, "WRONG_GLIEDERUNG");
  });
});

sync("Speicherfehler: nicht bestätigt, vom ISC abgelehnt, ungültiges Feld", async () => {
  const existing = (): MockPerson => withAddress({ vorname: "Erik" });
  await withMocks({ persons: [existing()], saveUnconfirmed: true }, { persons: [sewobePerson()] }, {}, async ({ runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.errorCode, "SAVE_UNCONFIRMED");
    assert.deepEqual(result.details, ["vorname"]);
  });
  await withMocks({ persons: [existing()], saveFails: true }, { persons: [sewobePerson()] }, {}, async ({ runner }) => {
    assert.equal((await runner.sync(request())).errorCode, "SAVE_FAILED");
  });
  await withMocks({ persons: [existing()], rejectManagerId: true }, { persons: [sewobePerson()] }, {}, async ({ runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.errorCode, "FORM_INVALID");
    assert.deepEqual(result.details, ["dlrgmanager_id"]);
  });
});

sync("Grunddaten ohne Meldung des ISC: gespeicherte Werte werden beim Nachlesen bestätigt", async () => {
  await withMocks({ persons: [withAddress({ vorname: "Erik" })], silentSave: true }, { persons: [sewobePerson()] }, { saveTimeoutMs: 1000 }, async ({ runner }) => {
    assert.equal((await runner.sync(request())).ok, true);
  });
  await withMocks({ persons: [withAddress({ vorname: "Erik" })], silentSave: true, saveUnconfirmed: true }, { persons: [sewobePerson()] }, { saveTimeoutMs: 1000 }, async ({ runner }) => {
    assert.equal((await runner.sync(request())).errorCode, "SAVE_UNCONFIRMED");
  });
});

sync("Neuanlage vom ISC nicht übernommen: SAVE_UNCONFIRMED", async () => {
  await withMocks({ noPersonCreate: true }, { persons: [sewobePerson()] }, {}, async ({ runner }) => {
    assert.equal((await runner.sync(request())).errorCode, "SAVE_UNCONFIRMED");
  });
});

sync("SEWOBE-Suche zu langsam: TIMEOUT und beide Systeme abgemeldet", async () => {
  await withMocks({}, { persons: [sewobePerson()], searchDelayMs: 3000 }, { searchTimeoutMs: 1000 }, async ({ isc, sewobe, runner }) => {
    const result = await runner.sync(request());
    assert.equal(result.errorCode, "TIMEOUT");
    assert.equal(isc.logouts(), 1);
    assert.equal(sewobe.logouts(), 1);
  });
});

sync("Logs und Fehlerantworten enthalten keine Personendaten, Passwörter oder TOTP-Codes", async () => {
  const captured: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const grab = (chunk: string | Uint8Array): boolean => {
    captured.push(String(chunk));
    return true;
  };
  const logger = new Logger();
  logger.registerSecret(MOCK_PASS);
  logger.registerSecret(SEWOBE_PASS);
  logger.registerSecret(SEWOBE_TOTP_SECRET);
  const responses: string[] = [];
  const nowCode = totpCode(SEWOBE_TOTP_SECRET, Date.now());
  (process.stdout as unknown as { write: typeof grab }).write = grab;
  (process.stderr as unknown as { write: typeof grab }).write = grab;
  try {
    await withMocks({ persons: [withAddress({ dlrgManagerId: "1002011000099" })] }, { persons: [sewobePerson()] }, {}, async ({ runner }) => {
      responses.push(JSON.stringify(await runner.sync(request())));
      responses.push(JSON.stringify(await runner.sync(request({ vorname: "Nobody", nachname: "Nowhere" }))));
      responses.push(JSON.stringify(await runner.sync(request({ dryRun: true, mitgliedsnummer: "1002011000002" }))));
    }, logger);
  } finally {
    (process.stdout as unknown as { write: typeof out }).write = out;
    (process.stderr as unknown as { write: typeof err }).write = err;
  }
  const logs = captured.join("");
  assert.ok(logs.includes("Abgleich fehlgeschlagen"), "es muss geloggt worden sein");
  for (const text of [logs, ...responses]) {
    for (const forbidden of ["Erika", "Musterfrau", "Nobody", "Nowhere", NR, "1002011000099", "17.05.1990", "1990-05-17", "Hauptstraße", MOCK_PASS, SEWOBE_PASS, SEWOBE_TOTP_SECRET, nowCode]) {
      assert.equal(text.includes(forbidden), false, `${forbidden} darf nicht auftauchen`);
    }
  }
});

sync("Neue Mitglieder: findet höhere Nummern über Lücken hinweg und meldet die höchste", async () => {
  const persons = [
    sewobePerson({ id: 1, nr: "1002011000010" }),
    sewobePerson({ id: 2, vorname: "Hans", nachname: "Beispiel", nr: "1002011000011" }),
    sewobePerson({ id: 3, vorname: "Lena", nachname: "Probe", nr: "1002011000013" }),
    sewobePerson({ id: 4, vorname: "Fern", nachname: "Weit", nr: "1002011000040" }),
  ];
  await withMocks({}, { persons }, {}, async ({ sewobe, runner }) => {
    const result = await runner.newMembers({ after: "1002011000010", window: 5 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.found, true);
    assert.deepEqual(
      result.members.map((m) => m.number),
      ["1002011000011", "1002011000013"],
    );
    assert.equal(result.members[0]?.name, "Beispiel, Hans");
    assert.equal(result.highest, "1002011000013");
    assert.equal(result.checked, 8);
    assert.equal(result.probes.length, 8);
    assert.deepEqual(result.probes[0], { number: "1002011000011", hits: 1, seen: ["1002011000011"] });
    assert.deepEqual(result.probes[1], { number: "1002011000012", hits: 0, seen: [] });
    assert.equal(sewobe.logouts(), 1);
  });
});

sync("Neue Mitglieder: ohne höhere Nummer bleibt highest unverändert", async () => {
  await withMocks({}, { persons: [sewobePerson({ nr: "1002011000010" })] }, {}, async ({ runner }) => {
    const result = await runner.newMembers({ after: "1002011000010", window: 3 });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.found, false);
    assert.deepEqual(result.members, []);
    assert.equal(result.highest, "1002011000010");
    assert.equal(result.checked, 3);
  });
});

sync("Neue Mitglieder: Anmeldefehler liefert error mit Code", async () => {
  await withMocks({}, { failLogin: true }, {}, async ({ runner }) => {
    const result = await runner.newMembers({ after: "1002011000010", window: 3 });
    assert.equal(result.ok, false);
    assert.ok(result.errorCode);
    assert.equal(result.highest, "1002011000010");
  });
});
