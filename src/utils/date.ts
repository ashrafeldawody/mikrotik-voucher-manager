const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a MikroTik date string to a Date object, or null if invalid / 'never'.
 * Format: 'jan/27/2026 23:20:15'
 */
export function parseMikrotikDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();
  if (!trimmed || trimmed === 'never' || trimmed === 'bind') return null;

  const match = trimmed.match(
    /^([a-z]{3})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/i
  );
  if (!match) return null;

  const [, monthStr, day, year, hours, minutes, seconds] = match;
  const month = MONTHS[monthStr!.toLowerCase()];
  if (month === undefined) return null;

  const date = new Date(
    parseInt(year!, 10),
    month,
    parseInt(day!, 10),
    parseInt(hours!, 10),
    parseInt(minutes!, 10),
    parseInt(seconds!, 10)
  );

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 'bind' means "waiting for first use" — treated as null.
 */
export function normalizeCallerId(callerId: string | null | undefined): string | null {
  if (!callerId) return null;
  const trimmed = callerId.trim();
  if (!trimmed || trimmed === 'bind' || trimmed === 'never') return null;
  return trimmed;
}
