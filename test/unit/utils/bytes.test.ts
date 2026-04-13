import { describe, it, expect } from 'vitest';
import { parseByteSize, formatBytesForMikrotik } from '../../../src/utils/bytes.js';

describe('parseByteSize', () => {
  it('returns 0 for null/undefined/empty/0', () => {
    expect(parseByteSize(null)).toBe(0);
    expect(parseByteSize(undefined)).toBe(0);
    expect(parseByteSize('')).toBe(0);
    expect(parseByteSize('0')).toBe(0);
  });

  it('treats numeric input as bytes', () => {
    expect(parseByteSize(1024)).toBe(1024);
    expect(parseByteSize(0)).toBe(0);
    expect(parseByteSize(-1)).toBe(0);
  });

  it('parses compact unit strings', () => {
    expect(parseByteSize('1K')).toBe(1024);
    expect(parseByteSize('1M')).toBe(1024 * 1024);
    expect(parseByteSize('1G')).toBe(1024 * 1024 * 1024);
    expect(parseByteSize('2G')).toBe(2 * 1024 * 1024 * 1024);
  });

  it('parses full unit strings', () => {
    expect(parseByteSize('1KB')).toBe(1024);
    expect(parseByteSize('500MB')).toBe(500 * 1024 * 1024);
    expect(parseByteSize('2GB')).toBe(2 * 1024 * 1024 * 1024);
  });

  it('parses fractional values', () => {
    expect(parseByteSize('1.5G')).toBe(Math.floor(1.5 * 1024 * 1024 * 1024));
    expect(parseByteSize('0.5M')).toBe(Math.floor(0.5 * 1024 * 1024));
  });

  it('is case insensitive', () => {
    expect(parseByteSize('1gb')).toBe(1024 * 1024 * 1024);
    expect(parseByteSize('500mb')).toBe(500 * 1024 * 1024);
  });
});

describe('formatBytesForMikrotik', () => {
  it('returns "0" for 0/negative/nan', () => {
    expect(formatBytesForMikrotik(0)).toBe('0');
    expect(formatBytesForMikrotik(-1)).toBe('0');
    expect(formatBytesForMikrotik(NaN)).toBe('0');
  });

  it('formats bytes below 1K as raw number', () => {
    expect(formatBytesForMikrotik(512)).toBe('512');
  });

  it('formats as raw byte count to avoid decimal/binary ambiguity', () => {
    expect(formatBytesForMikrotik(1024)).toBe('1024');
    expect(formatBytesForMikrotik(1024 * 1024)).toBe('1048576');
    expect(formatBytesForMikrotik(1024 * 1024 * 1024)).toBe('1073741824');
    expect(formatBytesForMikrotik(2 * 1024 * 1024 * 1024)).toBe('2147483648');
  });
});
