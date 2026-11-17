import { BotError } from "../errors.js";
import { collapse, normalizeName } from "../text.js";
import { GENDER_LABEL } from "./mapping.js";
import type { AddressValues, FieldChange, Gender, IscAddress, IscState, Plan, Target } from "./types.js";

function genderLabel(value: string): string {
  return value === "0" || value === "1" || value === "2" ? GENDER_LABEL[value as Gender] : "";
}

function differs(a: string, b: string): boolean {
  return collapse(a) !== collapse(b);
}

function planAddress(current: IscAddress | undefined, target: Target, changes: FieldChange[]): Plan["address"] {
  const wanted: Record<keyof AddressValues, string | undefined> = {
    strasse: target.strasse,
    plz: target.plz,
    ort: target.ort,
    land: target.land,
  };
  const merged: AddressValues = {
    strasse: current?.strasse ?? "",
    plz: current?.plz ?? "",
    ort: current?.ort ?? "",
    land: current?.land ?? "",
  };
  const found: FieldChange[] = [];
  for (const field of ["strasse", "plz", "ort", "land"] as const) {
    const next = wanted[field];
    if (next === undefined) continue;
    const old = merged[field];
    const same = field === "land" ? normalizeName(old) === normalizeName(next) : !differs(old, next);
    if (same) continue;
    found.push({ field, old, new: next });
    merged[field] = next;
  }
  if (found.length === 0) return { kind: "none" };
  changes.push(...found);
  return { kind: current ? "update" : "create", values: merged };
}

export function planUpdate(state: IscState, target: Target, membershipName: string): Plan {
  const changes: FieldChange[] = [];
  const grunddaten: Plan["grunddaten"] = {};

  if (differs(state.vorname, target.vorname)) {
    changes.push({ field: "vorname", old: state.vorname, new: target.vorname });
    grunddaten.vorname = target.vorname;
  }
  if (differs(state.nachname, target.nachname)) {
    changes.push({ field: "nachname", old: state.nachname, new: target.nachname });
    grunddaten.nachname = target.nachname;
  }
  if (state.gebdate !== target.gebdate) {
    changes.push({ field: "geburtsdatum", old: state.gebdate, new: target.gebdate });
    grunddaten.gebdate = target.gebdate;
  }
  if (target.gender !== undefined && state.gender !== target.gender) {
    changes.push({ field: "geschlecht", old: genderLabel(state.gender), new: genderLabel(target.gender) });
    grunddaten.gender = target.gender;
  }
  if (state.dlrgManagerId !== target.dlrgManagerId) {
    changes.push({ field: "dlrgManagerId", old: state.dlrgManagerId, new: target.dlrgManagerId });
    grunddaten.dlrgManagerId = target.dlrgManagerId;
  }

  const address = planAddress(state.address, target, changes);

  const membership = !state.hasMembership;
  if (membership) changes.push({ field: "mitgliedschaft", old: "", new: membershipName });

  return { changes, grunddaten, address, membership };
}

export function planCreate(target: Target, membershipName: string): Plan {
  if (target.gender === undefined) {
    throw new BotError("GESCHLECHT_FEHLT", "Neue Person kann nicht angelegt werden: Anrede in SEWOBE liefert kein Geschlecht", {
      step: "plan",
    });
  }
  const changes: FieldChange[] = [
    { field: "vorname", old: "", new: target.vorname },
    { field: "nachname", old: "", new: target.nachname },
    { field: "geburtsdatum", old: "", new: target.gebdate },
    { field: "geschlecht", old: "", new: genderLabel(target.gender) },
    { field: "dlrgManagerId", old: "", new: target.dlrgManagerId },
  ];
  const address = planAddress(undefined, target, changes);
  changes.push({ field: "mitgliedschaft", old: "", new: membershipName });
  return {
    changes,
    grunddaten: {
      vorname: target.vorname,
      nachname: target.nachname,
      gebdate: target.gebdate,
      gender: target.gender,
      dlrgManagerId: target.dlrgManagerId,
    },
    address,
    membership: true,
  };
}
