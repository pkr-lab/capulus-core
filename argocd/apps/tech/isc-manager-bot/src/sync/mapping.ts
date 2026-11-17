import { BotError } from "../errors.js";
import { parseGermanDate } from "../datetime.js";
import { collapse } from "../text.js";
import type { Gender, SewobePerson, Target } from "./types.js";

export const GENDER_LABEL: Record<Gender, string> = {
  "0": "männlich",
  "1": "weiblich",
  "2": "divers",
};

export function mapGender(anrede: string): Gender | undefined {
  switch (collapse(anrede).toLocaleLowerCase("de-DE")) {
    case "herr":
      return "0";
    case "frau":
      return "1";
    case "divers":
      return "2";
    default:
      return undefined;
  }
}

function optional(value: string): string | undefined {
  const cleaned = collapse(value);
  return cleaned === "" ? undefined : cleaned;
}

export function toTarget(person: SewobePerson): Target {
  const problems: string[] = [];
  const vorname = collapse(person.vorname);
  const nachname = collapse(person.nachname);
  if (vorname === "") problems.push("Vorname fehlt");
  if (nachname === "") problems.push("Name fehlt");

  const gebdate = parseGermanDate(person.geburtstag);
  if (gebdate === undefined) problems.push("Geburtstag fehlt oder ist kein gültiges Datum (TT.MM.JJJJ)");

  const nummer = person.mitgliedsnummer.trim();
  if (!/^\d{13}$/.test(nummer)) problems.push("Mitgliedsnummer hat keine 13 Ziffern");

  if (problems.length > 0 || gebdate === undefined) {
    throw new BotError("SEWOBE_DATA_INVALID", "Daten aus SEWOBE unvollständig oder ungültig", { step: "mapping", details: problems });
  }

  return {
    vorname,
    nachname,
    gebdate,
    gender: mapGender(person.anrede),
    dlrgManagerId: nummer,
    strasse: optional(person.strasse),
    plz: optional(person.plz),
    ort: optional(person.ort),
    land: optional(person.land),
  };
}
