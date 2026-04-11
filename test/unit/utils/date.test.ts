import { describe, it, expect } from 'vitest';
import { parseMikrotikDate, normalizeCallerId } from '../../../src/utils/date.js';

describe('parseMikrotikDate', () => {
  it('returns null for null/undefined/empty/never/bind', () => {
    expect(parseMikrotikDate(null)).toBe(null);
    expect(parseMikrotikDate(undefined)).toBe(null);
    expect(parseMikrotikDate('')).toBe(null);
    expect(parseMikrotikDate('never')).toBe(null);
    expect(parseMikrotikDate('bind')).toBe(null);
  });

  it('parses valid MikroTik dates', () => {
    const date = parseMikrotikDate('jan/27/2026 23:20:15');
    expect(date).toBeInstanceOf(Date);
    expect(date!.getFullYear()).toBe(2026);
    expect(date!.getMonth()).toBe(0); // January
    expect(date!.getDate()).toBe(27);
    expect(date!.getHours()).toBe(23);
    expect(date!.getMinutes()).toBe(20);
    expect(date!.getSeconds()).toBe(15);
  });

  it('handles every month', () => {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    months.forEach((m, i) => {
      const date = parseMikrotikDate(`${m}/01/2026 00:00:00`);
      expect(date).not.toBeNull();
      expect(date!.getMonth()).toBe(i);
    });
  });

  it('returns null for malformed input', () => {
    expect(parseMikrotikDate('not a date')).toBe(null);
    expect(parseMikrotikDate('2026-01-27')).toBe(null);
    expect(parseMikrotikDate('xyz/01/2026 00:00:00')).toBe(null);
  });
});

describe('normalizeCallerId', () => {
  it('returns null for empty/bind/never', () => {
    expect(normalizeCallerId(null)).toBe(null);
    expect(normalizeCallerId('')).toBe(null);
    expect(normalizeCallerId('bind')).toBe(null);
    expect(normalizeCallerId('never')).toBe(null);
  });

  it('returns a real MAC unchanged', () => {
    expect(normalizeCallerId('AA:BB:CC:DD:EE:FF')).toBe('AA:BB:CC:DD:EE:FF');
  });
});
