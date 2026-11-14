import { ValidationError } from "./errors.js";
import { normalizeForComparison } from "./text.js";

export type CategoryOption = { value: string; name: string };

export function resolveCategories(requested: readonly string[], available: readonly CategoryOption[]): string[] {
  const values: string[] = [];
  const unknown: string[] = [];

  for (const raw of requested) {
    const wanted = raw.trim();
    if (wanted === "") continue;
    const byId = available.find((o) => o.value === wanted);
    const byName = available.filter((o) => normalizeForComparison(o.name) === normalizeForComparison(wanted));
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
