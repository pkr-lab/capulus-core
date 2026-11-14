export function normalizeForComparison(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase("de-DE");
}
