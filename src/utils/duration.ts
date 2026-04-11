import type { Duration } from '../types.js';

/**
 * Parse a Duration (number of seconds or string like '1h30m') to seconds.
 * Returns 0 for empty/invalid input.
 */
export function parseDurationToSeconds(value: Duration | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  const str = value.trim();
  if (!str || str === '0' || str === '0s') return 0;

  // Pure integer string -> seconds
  if (/^\d+$/.test(str)) return parseInt(str, 10);

  let total = 0;
  let matched = false;

  const weekMatch = str.match(/(\d+)w/);
  const dayMatch = str.match(/(\d+)d/);
  const hourMatch = str.match(/(\d+)h/);
  // Match 'm' only when not followed by 's' (to avoid matching 'ms')
  const minMatch = str.match(/(\d+)m(?!s)/);
  const secMatch = str.match(/(\d+)s/);

  if (weekMatch) {
    total += parseInt(weekMatch[1]!, 10) * 604800;
    matched = true;
  }
  if (dayMatch) {
    total += parseInt(dayMatch[1]!, 10) * 86400;
    matched = true;
  }
  if (hourMatch) {
    total += parseInt(hourMatch[1]!, 10) * 3600;
    matched = true;
  }
  if (minMatch) {
    total += parseInt(minMatch[1]!, 10) * 60;
    matched = true;
  }
  if (secMatch) {
    total += parseInt(secMatch[1]!, 10);
    matched = true;
  }

  return matched ? total : 0;
}

/**
 * Format a number of seconds to a MikroTik-compatible duration string.
 * E.g. 3600 -> '1h', 5400 -> '1h30m', 0 -> '0s'
 */
export function formatSecondsToDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';

  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;

  let result = '';
  if (days > 0) result += `${days}d`;
  if (hours > 0) result += `${hours}h`;
  if (minutes > 0) result += `${minutes}m`;
  if (secs > 0 || result === '') result += `${secs}s`;

  return result;
}

/**
 * Normalize any Duration input to the MikroTik string format.
 */
export function normalizeDuration(value: Duration | null | undefined): string {
  if (value == null) return '0s';
  if (typeof value === 'string' && /[a-z]/i.test(value.trim())) {
    // Already in MikroTik format — normalize by round-tripping
    const secs = parseDurationToSeconds(value);
    return formatSecondsToDuration(secs);
  }
  const secs = parseDurationToSeconds(value);
  return formatSecondsToDuration(secs);
}
