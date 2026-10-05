import { ValidationError } from "./errors.js";

export type CategoryOption = { value: string; name: string };

export function normalizeName(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase("de-DE");
}

export function resolveCategories(requested: readonly string[], available: readonly CategoryOption[]): string[] {
  const values: string[] = [];
  const unknown: string[] = [];

  for (const raw of requested) {
    const wanted = raw.trim();
    if (wanted === "") continue;
    const byId = available.find((o) => o.value === wanted);
    const byName = available.filter((o) => normalizeName(o.name) === normalizeName(wanted));
    if (byId) {
      values.push(byId.value);
    } else if (byName.length === 1 && byName[0]) {
      values.push(byName[0].value);
    } else {
      unknown.push(wanted);
    }
  }

  if (unknown.length > 0) {
    throw new ValidationError(
      `Unbekannte Kategorie: ${unknown.join(", ")}`,
      unknown.map((u) => `Kategorie nicht in der Gliederung vorhanden: ${u}`),
    );
  }
  return [...new Set(values)];
}
