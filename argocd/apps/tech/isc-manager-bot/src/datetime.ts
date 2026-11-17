const GERMAN = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function parseGermanDate(raw: string): string | undefined {
  const match = GERMAN.exec(raw.trim());
  if (!match) return undefined;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (year < 1900) return undefined;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return undefined;
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function isoPrefix(raw: string): string {
  const match = ISO.exec(raw.trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}
