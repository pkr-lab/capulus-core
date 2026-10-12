import { ValidationError } from "./errors.js";

export type Abzeichen = { poNr: string; ausbildungId: string; name: string };

export const ABZEICHEN: readonly Abzeichen[] = [
  { poNr: "111", ausbildungId: "153", name: "Frühschwimmer (Seepferdchen)" },
  { poNr: "121", ausbildungId: "11", name: "Deutsches Schwimmabzeichen Bronze (Freischwimmer)" },
  { poNr: "122", ausbildungId: "12", name: "Deutsches Schwimmabzeichen Silber" },
  { poNr: "123", ausbildungId: "13", name: "Deutsches Schwimmabzeichen Gold" },
  { poNr: "141", ausbildungId: "17", name: "Juniorretter" },
];

export const STANDARD_PO_NUMMERN: readonly string[] = ABZEICHEN.map((a) => a.poNr);

export type Urkunde = {
  uid: string;
  vorname: string;
  nachname: string;
  name: string;
  geburtsdatum: string;
  abzeichen: string;
  poNr: string;
  prueferName: string;
  prueferNummer: string;
  registriernummer: string;
  ausgestelltAm: string;
  pruefungAm: string;
};

export type UrkundenQuery = { jahr: string; poNummern: string[] };

type Roh = Record<string, unknown>;

function istObjekt(value: unknown): value is Roh {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function datum(value: unknown): string {
  const roh = istObjekt(value) ? value.date : value;
  if (typeof roh === "number" && Number.isFinite(roh)) {
    return new Date(roh * 1000).toISOString().slice(0, 10);
  }
  if (typeof roh !== "string") return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(roh.trim());
  if (!match || match[1] === "0000" || match[1] === "0001") return "";
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function poNrVon(row: Roh): string {
  const direkt = text(row.poNr);
  if (direkt !== "") return direkt;
  const ausbildung = istObjekt(row.ausbildung) ? row.ausbildung : undefined;
  const ausAusbildung = text(ausbildung?.poNr);
  if (ausAusbildung !== "") return ausAusbildung;
  const ausbildungId = text(row.ausbildungId) || text(ausbildung?.id);
  const perId = ABZEICHEN.find((a) => a.ausbildungId === ausbildungId);
  if (perId) return perId.poNr;
  const ausName = /\((\d{3,4})\)\s*$/.exec(text(row.ausbildungName));
  return ausName?.[1] ?? "";
}

export function normalisiereUrkunde(raw: unknown): Urkunde | undefined {
  if (!istObjekt(raw)) return undefined;
  if (raw.isVerlaengerung === true) return undefined;
  const uid = text(raw.qualiUid) || text(raw.uid);
  if (uid === "") return undefined;
  const person = istObjekt(raw.person) ? raw.person : {};
  const vorname = text(person.vorname);
  const nachname = text(person.nachname) || text(person.name);
  const gesamt = [vorname, nachname].filter((t) => t !== "").join(" ");
  const poNr = poNrVon(raw);
  const bekannt = ABZEICHEN.find((a) => a.poNr === poNr);
  return {
    uid,
    vorname,
    nachname,
    name: gesamt !== "" ? gesamt : text(person.gesamtname),
    geburtsdatum: datum(person.gebDate),
    abzeichen: text(raw.ausbildungName) || bekannt?.name || "",
    poNr,
    prueferName: text(raw.prueferName),
    prueferNummer: text(raw.prueferNummer),
    registriernummer: text(raw.regNr),
    ausgestelltAm: datum(raw.ausgestelltAm),
    pruefungAm: datum(raw.pruefungAm),
  };
}

export function filtereUrkunden(liste: unknown, poNummern: readonly string[]): Urkunde[] {
  if (!Array.isArray(liste)) return [];
  const erlaubt = new Set(poNummern);
  const gesehen = new Set<string>();
  const ergebnis: Urkunde[] = [];
  for (const raw of liste) {
    const urkunde = normalisiereUrkunde(raw);
    if (!urkunde || !erlaubt.has(urkunde.poNr) || gesehen.has(urkunde.uid)) continue;
    gesehen.add(urkunde.uid);
    ergebnis.push(urkunde);
  }
  return ergebnis;
}

export function parseUrkundenQuery(params: URLSearchParams, jetzt: Date = new Date()): UrkundenQuery {
  const details: string[] = [];
  const jahrRoh = params.get("jahr")?.trim();
  const jahr = jahrRoh && jahrRoh !== "" ? jahrRoh : String(jetzt.getFullYear());
  if (!/^\d{4}$/.test(jahr)) details.push(`jahr muss vierstellig sein: ${jahr}`);

  const roh = params.get("ausbildungen");
  const poNummern =
    roh === null || roh.trim() === ""
      ? [...STANDARD_PO_NUMMERN]
      : [...new Set(roh.split(",").map((p) => p.trim()).filter((p) => p !== ""))];
  for (const poNr of poNummern) {
    if (!/^\d{3,4}$/.test(poNr)) details.push(`Ungültige PO-Nummer: ${poNr}`);
  }
  if (poNummern.length === 0) details.push("ausbildungen darf nicht leer sein");

  if (details.length > 0) throw new ValidationError("Ungültige Abfrage für /urkunden", details);
  return { jahr, poNummern };
}
