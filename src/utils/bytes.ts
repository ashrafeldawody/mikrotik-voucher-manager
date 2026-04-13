import type { ByteSize } from '../types.js';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;

/**
 * Parse a ByteSize (number of bytes or string like '2GB') to bytes.
 */
export function parseByteSize(value: ByteSize | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  const str = value.trim();
  if (!str || str === '0') return 0;

  const match = str.match(/^(\d+(?:\.\d+)?)\s*([KMGT])?B?$/i);
  if (!match) {
    const n = parseInt(str, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  const num = parseFloat(match[1]!);
  const unit = (match[2] || '').toUpperCase();

  switch (unit) {
    case 'K':
      return Math.floor(num * KB);
    case 'M':
      return Math.floor(num * MB);
    case 'G':
      return Math.floor(num * GB);
    case 'T':
      return Math.floor(num * TB);
    default:
      return Math.floor(num);
  }
}

/**
 * Format a byte count to the string MikroTik accepts for transfer-limit.
 * Always outputs the raw byte count to avoid decimal vs binary ambiguity —
 * MikroTik interprets G/M/K as decimal (10^3) multipliers, not binary (2^10).
 */
export function formatBytesForMikrotik(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0';
  return String(Math.floor(bytes));
}
