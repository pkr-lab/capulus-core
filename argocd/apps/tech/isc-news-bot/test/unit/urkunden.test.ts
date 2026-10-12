import { test } from "node:test";
import assert from "node:assert/strict";
import { datum, filtereUrkunden, normalisiereUrkunde, parseUrkundenQuery, STANDARD_PO_NUMMERN } from "../../src/urkunden.js";
import { ValidationError } from "../../src/errors.js";
import { MOCK_URKUNDEN } from "../fixtures/urkunden.js";

test("Urkunden: nur Seepferdchen, Bronze, Silber, Gold und Juniorretter", () => {
  assert.deepEqual([...STANDARD_PO_NUMMERN], ["111", "121", "122", "123", "141"]);
  const urkunden = filtereUrkunden(MOCK_URKUNDEN, STANDARD_PO_NUMMERN);
  assert.deepEqual(
    urkunden.map((u) => u.uid),
    ["5001", "5002", "5005"],
  );
});

test("Urkunden: Felder für die Mail werden normalisiert", () => {
  const [seepferdchen, silber, junior] = filtereUrkunden(MOCK_URKUNDEN, STANDARD_PO_NUMMERN);
  assert.deepEqual(seepferdchen, {
    uid: "5001",
    vorname: "Erika",
    nachname: "Beispiel",
    name: "Erika Beispiel",
    geburtsdatum: "2019-04-03",
    abzeichen: "Frühschwimmer (Seepferdchen)",
    poNr: "111",
    prueferName: "Prüferin Muster",
    prueferNummer: "10/181/99/01",
    registriernummer: "1002011/111/041/26",
    ausgestelltAm: "2026-10-08",
    pruefungAm: "2026-10-08",
  });
  assert.equal(silber?.name, "Max Mustermann");
  assert.equal(silber?.geburtsdatum, "2016-11-20");
  assert.equal(junior?.poNr, "141");
});

test("Urkunden: Verlängerungen und kaputte Einträge werden verworfen", () => {
  assert.equal(normalisiereUrkunde({ uid: 1, isVerlaengerung: true }), undefined);
  assert.equal(normalisiereUrkunde({ ausbildungName: "ohne uid" }), undefined);
  assert.equal(normalisiereUrkunde("kein Objekt"), undefined);
  assert.deepEqual(filtereUrkunden({ keine: "liste" }, STANDARD_PO_NUMMERN), []);
});

test("Urkunden: doppelte UIDs erscheinen nur einmal", () => {
  const doppelt = [MOCK_URKUNDEN[0], MOCK_URKUNDEN[0]];
  assert.equal(filtereUrkunden(doppelt, STANDARD_PO_NUMMERN).length, 1);
});

test("Urkunden: Datumsformen des ISC", () => {
  assert.equal(datum("2016-11-20"), "2016-11-20");
  assert.equal(datum({ date: "2016-11-20 00:00:00.000000" }), "2016-11-20");
  assert.equal(datum("0000-00-00"), "");
  assert.equal(datum(null), "");
  assert.equal(datum(0), "1970-01-01");
});

test("Urkunden: Query mit Standardwerten und Prüfung", () => {
  const jetzt = new Date("2026-10-15T18:00:00Z");
  assert.deepEqual(parseUrkundenQuery(new URLSearchParams(""), jetzt), { jahr: "2026", poNummern: [...STANDARD_PO_NUMMERN] });
  assert.deepEqual(parseUrkundenQuery(new URLSearchParams("jahr=2025&ausbildungen=111, 141,111"), jetzt), {
    jahr: "2025",
    poNummern: ["111", "141"],
  });
  assert.throws(() => parseUrkundenQuery(new URLSearchParams("jahr=26"), jetzt), ValidationError);
  assert.throws(() => parseUrkundenQuery(new URLSearchParams("ausbildungen=abc"), jetzt), ValidationError);
});
