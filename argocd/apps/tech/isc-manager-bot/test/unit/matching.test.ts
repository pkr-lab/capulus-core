import { test } from "node:test";
import assert from "node:assert/strict";
import { BotError } from "../../src/errors.js";
import { matchPerson } from "../../src/sync/matching.js";
import type { Candidate, Target } from "../../src/sync/types.js";

const target: Target = {
  vorname: "Erika",
  nachname: "Musterfrau",
  gebdate: "1990-05-17",
  gender: "1",
  dlrgManagerId: "1002011000001",
  strasse: undefined,
  plz: undefined,
  ort: undefined,
  land: undefined,
};

function cand(overrides: Partial<Candidate> = {}): Candidate {
  return { uid: "10", vorname: "Erika", nachname: "Musterfrau", gebdate: "1990-05-17", dlrgManagerId: "", ...overrides };
}

function code(error: unknown): string | undefined {
  return error instanceof BotError ? error.code : undefined;
}

test("Abgleich: Treffer über die DLRG-Manager-Id", () => {
  assert.deepEqual(matchPerson([cand({ uid: "11", dlrgManagerId: "1002011000001", vorname: "Erica" })], target), { kind: "byId", uid: "11" });
});

test("Abgleich: Id-Treffer hat Vorrang vor Namenstreffer", () => {
  const match = matchPerson([cand({ uid: "10" }), cand({ uid: "11", dlrgManagerId: "1002011000001", vorname: "Anders" })], target);
  assert.deepEqual(match, { kind: "byId", uid: "11" });
});

test("Abgleich: ohne Id-Treffer genau ein Namenstreffer ohne Id wird zugeordnet", () => {
  assert.deepEqual(matchPerson([cand({ uid: "12", vorname: " erika ", nachname: "MUSTERFRAU" })], target), { kind: "byName", uid: "12" });
});

test("Abgleich: Namenstreffer mit anderer Id ist ein Konflikt", () => {
  assert.throws(
    () => matchPerson([cand({ dlrgManagerId: "1002011000099" })], target),
    (error: unknown) => code(error) === "ISC_CONFLICT",
  );
});

test("Abgleich: mehrere Namenstreffer sind uneindeutig", () => {
  assert.throws(
    () => matchPerson([cand({ uid: "1" }), cand({ uid: "2" })], target),
    (error: unknown) => code(error) === "ISC_AMBIGUOUS",
  );
});

test("Abgleich: mehrere Personen mit derselben Id sind uneindeutig", () => {
  assert.throws(
    () => matchPerson([cand({ uid: "1", dlrgManagerId: "1002011000001" }), cand({ uid: "2", dlrgManagerId: "1002011000001" })], target),
    (error: unknown) => code(error) === "ISC_AMBIGUOUS",
  );
});

test("Abgleich: anderes Geburtsdatum oder anderer Name ergibt keinen Treffer", () => {
  assert.deepEqual(matchPerson([cand({ gebdate: "1990-05-18" }), cand({ nachname: "Muster" })], target), { kind: "none" });
  assert.deepEqual(matchPerson([], target), { kind: "none" });
});
