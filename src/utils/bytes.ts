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
 * Format a byte count to the compact string MikroTik accepts for transfer-limit.
 * E.g. 2147483648 -> '2G', 1048576 -> '1M', 512 -> '512'
 */
export function formatBytesForMikrotik(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0';
  if (bytes >= GB) return `${Math.floor(bytes / GB)}G`;
  if (bytes >= MB) return `${Math.floor(bytes / MB)}M`;
  if (bytes >= KB) return `${Math.floor(bytes / KB)}K`;
  return String(Math.floor(bytes));
}
