export function collapse(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function normalizeName(text: string): string {
  return collapse(text).toLocaleLowerCase("de-DE");
}

export function scrubMessage(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"')]+/g, "[url]")
    .replace(/\b\d{6,}\b/g, "[nr]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
