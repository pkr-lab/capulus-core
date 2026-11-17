import { BotError } from "../errors.js";
import { normalizeName } from "../text.js";
import type { Candidate, Target } from "./types.js";

export type Match =
  | { kind: "byId"; uid: string }
  | { kind: "byName"; uid: string }
  | { kind: "none" };

export function matchPerson(candidates: Candidate[], target: Target): Match {
  const byId = candidates.filter((c) => c.dlrgManagerId === target.dlrgManagerId);
  if (byId.length > 1) {
    throw new BotError("ISC_AMBIGUOUS", "Mehrere ISC-Personen mit derselben DLRG-Manager-Id", { step: "isc-match" });
  }
  const direct = byId[0];
  if (direct) return { kind: "byId", uid: direct.uid };

  const vorname = normalizeName(target.vorname);
  const nachname = normalizeName(target.nachname);
  const byName = candidates.filter(
    (c) => normalizeName(c.vorname) === vorname && normalizeName(c.nachname) === nachname && c.gebdate === target.gebdate,
  );
  if (byName.length === 0) return { kind: "none" };
  if (byName.length > 1) {
    throw new BotError("ISC_AMBIGUOUS", "Mehrere ISC-Personen mit Vorname, Name und Geburtsdatum, keine Zuordnung möglich", {
      step: "isc-match",
    });
  }
  const only = byName[0];
  if (!only) return { kind: "none" };
  if (only.dlrgManagerId !== "" && only.dlrgManagerId !== target.dlrgManagerId) {
    throw new BotError("ISC_CONFLICT", "ISC-Person mit gleichem Namen und Geburtsdatum hat eine andere DLRG-Manager-Id", {
      step: "isc-match",
    });
  }
  return { kind: "byName", uid: only.uid };
}
