import { test } from "node:test";
import assert from "node:assert/strict";
import { BotError } from "../../src/errors.js";
import { mapGender, toTarget } from "../../src/sync/mapping.js";
import type { SewobePerson } from "../../src/sync/types.js";

function sewobe(overrides: Partial<SewobePerson> = {}): SewobePerson {
  return {
    vorname: "Erika",
    nachname: "Musterfrau",
    geburtstag: "17.05.1990",
    anrede: "Frau",
    mitgliedsnummer: "1002011000001",
    strasse: "Hauptstraße 1",
    plz: "56626",
    ort: "Andernach",
    land: "Deutschland",
    ...overrides,
  };
}

test("Anrede: Herr, Frau und Divers werden abgebildet", () => {
  assert.equal(mapGender("Herr"), "0");
  assert.equal(mapGender("Frau"), "1");
  assert.equal(mapGender("Divers"), "2");
  assert.equal(mapGender(" herr "), "0");
});

test("Anrede: Keine Anrede und leer setzen kein Geschlecht", () => {
  assert.equal(mapGender("Keine Anrede"), undefined);
  assert.equal(mapGender(""), undefined);
  assert.equal(mapGender("Dr."), undefined);
});

test("Mapping: alle Felder aus SEWOBE landen im Ziel, Datum als ISO", () => {
  assert.deepEqual(toTarget(sewobe()), {
    vorname: "Erika",
    nachname: "Musterfrau",
    gebdate: "1990-05-17",
    gender: "1",
    dlrgManagerId: "1002011000001",
    strasse: "Hauptstraße 1",
    plz: "56626",
    ort: "Andernach",
    land: "Deutschland",
  });
});

test("Mapping: leere Adressfelder bleiben undefined und überschreiben nichts", () => {
  const target = toTarget(sewobe({ strasse: "  ", plz: "", ort: "", land: "" }));
  assert.equal(target.strasse, undefined);
  assert.equal(target.plz, undefined);
  assert.equal(target.ort, undefined);
  assert.equal(target.land, undefined);
});

test("Mapping: mehrzeilige Straße wird auf eine Zeile gebracht", () => {
  assert.equal(toTarget(sewobe({ strasse: "Hauptstraße 1\r\n  Hinterhaus" })).strasse, "Hauptstraße 1 Hinterhaus");
});

test("Mapping: fehlende Pflichtdaten ergeben SEWOBE_DATA_INVALID mit allen Gründen", () => {
  assert.throws(
    () => toTarget(sewobe({ vorname: "", geburtstag: "31.02.2020", mitgliedsnummer: "12" })),
    (error: unknown) => error instanceof BotError && error.code === "SEWOBE_DATA_INVALID" && error.details.length === 3,
  );
  assert.throws(() => toTarget(sewobe({ geburtstag: "" })), BotError);
});
