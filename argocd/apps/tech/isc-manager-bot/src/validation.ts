import { ValidationError } from "./errors.js";

export type ParsedSync = {
  vorname: string;
  nachname: string;
  mitgliedsnummer: string | undefined;
  dryRun: boolean;
};

const MAX_NAME_LENGTH = 100;
const CONTROL = /[\u0000-\u001f\u007f]/;

function nameField(value: unknown, field: string, problems: string[]): string {
  if (typeof value !== "string") {
    problems.push(`${field} muss ein String sein`);
    return "";
  }
  const cleaned = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (cleaned === "") {
    problems.push(`${field} darf nicht leer sein`);
  } else if (cleaned.length > MAX_NAME_LENGTH) {
    problems.push(`${field} ist länger als ${MAX_NAME_LENGTH} Zeichen`);
  } else if (CONTROL.test(cleaned)) {
    problems.push(`${field} enthält Steuerzeichen`);
  }
  return cleaned;
}

export function validateSyncRequest(input: unknown): ParsedSync {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError("Body muss ein JSON-Objekt sein");
  }
  const body = input as Record<string, unknown>;
  const problems: string[] = [];
  const vorname = nameField(body.vorname, "vorname", problems);
  const nachname = nameField(body.nachname, "nachname", problems);

  let mitgliedsnummer: string | undefined;
  const rawNumber = body.mitgliedsnummer;
  if (rawNumber !== undefined && rawNumber !== null && rawNumber !== "") {
    const asText = typeof rawNumber === "number" ? String(rawNumber) : rawNumber;
    if (typeof asText !== "string" || !/^\d{13}$/.test(asText.trim())) {
      problems.push("mitgliedsnummer muss 13 Ziffern haben");
    } else {
      mitgliedsnummer = asText.trim();
    }
  }

  let dryRun = false;
  if (body.dryRun !== undefined) {
    if (typeof body.dryRun !== "boolean") problems.push("dryRun muss true oder false sein");
    else dryRun = body.dryRun;
  }

  if (problems.length > 0) throw new ValidationError("Ungültige Anfrage", problems);
  return { vorname, nachname, mitgliedsnummer, dryRun };
}

export type ParsedNewMembers = {
  after: string;
  window: number;
};

export const DEFAULT_WINDOW = 10;
export const MAX_WINDOW = 25;

export function validateNewMembersRequest(input: unknown): ParsedNewMembers {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError("Body muss ein JSON-Objekt sein");
  }
  const body = input as Record<string, unknown>;
  const problems: string[] = [];

  let after = "";
  const rawAfter = typeof body.after === "number" ? String(body.after) : body.after;
  if (typeof rawAfter !== "string" || !/^\d{13}$/.test(rawAfter.trim())) {
    problems.push("after muss eine Mitgliedsnummer mit 13 Ziffern sein");
  } else {
    after = rawAfter.trim();
  }

  let window = DEFAULT_WINDOW;
  if (body.window !== undefined && body.window !== null) {
    if (typeof body.window !== "number" || !Number.isInteger(body.window) || body.window < 1 || body.window > MAX_WINDOW) {
      problems.push(`window muss eine ganze Zahl von 1 bis ${MAX_WINDOW} sein`);
    } else {
      window = body.window;
    }
  }

  if (problems.length > 0) throw new ValidationError("Ungültige Anfrage", problems);
  return { after, window };
}
