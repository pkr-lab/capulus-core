import { test } from "node:test";
import assert from "node:assert/strict";
import { BotError } from "../../src/errors.js";
import { planCreate, planUpdate } from "../../src/sync/plan.js";
import type { IscState, Target } from "../../src/sync/types.js";

const GLIEDERUNG = "Ortsgruppe Andernach e.V.";

const target: Target = {
  vorname: "Erika",
  nachname: "Musterfrau",
  gebdate: "1990-05-17",
  gender: "1",
  dlrgManagerId: "1002011000001",
  strasse: "Hauptstraße 1",
  plz: "56626",
  ort: "Andernach",
  land: "Deutschland",
};

function state(overrides: Partial<IscState> = {}): IscState {
  return {
    vorname: "Erika",
    nachname: "Musterfrau",
    gebdate: "1990-05-17",
    gender: "1",
    dlrgManagerId: "1002011000001",
    hasMembership: true,
    address: { locId: "5", strasse: "Hauptstraße 1", plz: "56626", ort: "Andernach", land: "Deutschland" },
    ...overrides,
  };
}

test("Plan: identische Daten ergeben keine Änderung", () => {
  const plan = planUpdate(state(), target, GLIEDERUNG);
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.grunddaten, {});
  assert.equal(plan.address.kind, "none");
  assert.equal(plan.membership, false);
});

test("Plan: nur geänderte Felder, Diff mit Alt- und Neuwert", () => {
  const plan = planUpdate(state({ vorname: "Erik", ort: undefined, address: { locId: "5", strasse: "Hauptstraße 1", plz: "56626", ort: "Koblenz", land: "deutschland" } } as Partial<IscState>), target, GLIEDERUNG);
  assert.deepEqual(plan.changes, [
    { field: "vorname", old: "Erik", new: "Erika" },
    { field: "ort", old: "Koblenz", new: "Andernach" },
  ]);
  assert.deepEqual(plan.grunddaten, { vorname: "Erika" });
  assert.deepEqual(plan.address, { kind: "update", values: { strasse: "Hauptstraße 1", plz: "56626", ort: "Andernach", land: "deutschland" } });
});

test("Plan: leere SEWOBE-Felder überschreiben keine ISC-Werte", () => {
  const sparse: Target = { ...target, gender: undefined, strasse: undefined, plz: undefined, ort: undefined, land: undefined };
  const plan = planUpdate(state({ gender: "0", address: { locId: "5", strasse: "Alt 1", plz: "1", ort: "X", land: "Y" } }), sparse, GLIEDERUNG);
  assert.deepEqual(plan.changes, []);
});

test("Plan: Geschlecht wird nur bei gesetzter Anrede geändert", () => {
  assert.deepEqual(planUpdate(state({ gender: "0" }), target, GLIEDERUNG).grunddaten, { gender: "1" });
  assert.deepEqual(planUpdate(state({ gender: "" }), { ...target, gender: "2" }, GLIEDERUNG).changes, [
    { field: "geschlecht", old: "", new: "divers" },
  ]);
  assert.deepEqual(planUpdate(state({ gender: "0" }), { ...target, gender: undefined }, GLIEDERUNG).changes, []);
});

test("Plan: Id wird bei Namenstreffer ohne Id gesetzt", () => {
  const plan = planUpdate(state({ dlrgManagerId: "" }), target, GLIEDERUNG);
  assert.deepEqual(plan.changes, [{ field: "dlrgManagerId", old: "", new: "1002011000001" }]);
  assert.deepEqual(plan.grunddaten, { dlrgManagerId: "1002011000001" });
});

test("Plan: fehlende Mitgliedschaft wird ergänzt, vorhandene nicht doppelt", () => {
  const plan = planUpdate(state({ hasMembership: false }), target, GLIEDERUNG);
  assert.equal(plan.membership, true);
  assert.deepEqual(plan.changes, [{ field: "mitgliedschaft", old: "", new: GLIEDERUNG }]);
  assert.equal(planUpdate(state(), target, GLIEDERUNG).membership, false);
});

test("Plan: ohne vorhandene Adresse wird eine angelegt, nur wenn SEWOBE Adressdaten liefert", () => {
  const created = planUpdate(state({ address: undefined }), target, GLIEDERUNG);
  assert.equal(created.address.kind, "create");
  assert.equal(created.changes.length, 4);
  const none = planUpdate(state({ address: undefined }), { ...target, strasse: undefined, plz: undefined, ort: undefined, land: undefined }, GLIEDERUNG);
  assert.equal(none.address.kind, "none");
});

test("Plan: Neuanlage enthält alle Felder und die Mitgliedschaft", () => {
  const plan = planCreate(target, GLIEDERUNG);
  assert.deepEqual(
    plan.changes.map((c) => c.field),
    ["vorname", "nachname", "geburtsdatum", "geschlecht", "dlrgManagerId", "strasse", "plz", "ort", "land", "mitgliedschaft"],
  );
  assert.equal(plan.membership, true);
  assert.equal(plan.address.kind, "create");
});

test("Plan: Neuanlage ohne Geschlecht bricht mit GESCHLECHT_FEHLT ab", () => {
  assert.throws(
    () => planCreate({ ...target, gender: undefined }, GLIEDERUNG),
    (error: unknown) => error instanceof BotError && error.code === "GESCHLECHT_FEHLT",
  );
});
