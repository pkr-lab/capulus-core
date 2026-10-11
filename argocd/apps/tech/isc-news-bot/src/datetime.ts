const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;

const berlinParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatBerlinLocal(date: Date): string {
  const parts = Object.fromEntries(berlinParts.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function isRealCalendarDate(year: number, month: number, day: number, hour: number, minute: number): boolean {
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

export function toIscLocal(value: string): string | undefined {
  const local = LOCAL.exec(value);
  if (local) {
    const [, y, mo, d, h, mi] = local.map(Number) as [string, number, number, number, number, number];
    return isRealCalendarDate(y, mo, d, h, mi) ? value : undefined;
  }
  if (ZONED.test(value)) {
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) return undefined;
    return formatBerlinLocal(instant);
  }
  return undefined;
}
