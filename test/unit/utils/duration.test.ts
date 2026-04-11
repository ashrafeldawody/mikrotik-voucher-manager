import { describe, it, expect } from 'vitest';
import {
  parseDurationToSeconds,
  formatSecondsToDuration,
  normalizeDuration,
} from '../../../src/utils/duration.js';

describe('parseDurationToSeconds', () => {
  it('returns 0 for null/undefined/empty', () => {
    expect(parseDurationToSeconds(null)).toBe(0);
    expect(parseDurationToSeconds(undefined)).toBe(0);
    expect(parseDurationToSeconds('')).toBe(0);
    expect(parseDurationToSeconds('0s')).toBe(0);
    expect(parseDurationToSeconds('0')).toBe(0);
  });

  it('treats numeric input as seconds', () => {
    expect(parseDurationToSeconds(3600)).toBe(3600);
    expect(parseDurationToSeconds(0)).toBe(0);
    expect(parseDurationToSeconds(-5)).toBe(0);
    expect(parseDurationToSeconds(1.9)).toBe(1);
  });

  it('parses a numeric string as seconds', () => {
    expect(parseDurationToSeconds('45')).toBe(45);
  });

  it('parses basic MikroTik formats', () => {
    expect(parseDurationToSeconds('30s')).toBe(30);
    expect(parseDurationToSeconds('5m')).toBe(300);
    expect(parseDurationToSeconds('1h')).toBe(3600);
    expect(parseDurationToSeconds('1d')).toBe(86400);
    expect(parseDurationToSeconds('1w')).toBe(604800);
  });

  it('parses composite MikroTik durations', () => {
    expect(parseDurationToSeconds('1h30m')).toBe(5400);
    expect(parseDurationToSeconds('2d5h')).toBe(2 * 86400 + 5 * 3600);
    expect(parseDurationToSeconds('1h30m45s')).toBe(3600 + 1800 + 45);
  });

  it('does not confuse "m" with "ms"', () => {
    // MikroTik doesn't use 'ms'. Our regex rejects 'm' followed by 's' to
    // avoid false matches. '1ms' has no digit directly before the 's' so
    // the seconds match also fails — the whole input yields 0.
    expect(parseDurationToSeconds('1ms')).toBe(0);
  });

  it('parses a mix with minutes adjacent to seconds', () => {
    expect(parseDurationToSeconds('1m30s')).toBe(90);
  });
});

describe('formatSecondsToDuration', () => {
  it('formats 0 as "0s"', () => {
    expect(formatSecondsToDuration(0)).toBe('0s');
    expect(formatSecondsToDuration(-1)).toBe('0s');
  });

  it('formats basic durations', () => {
    expect(formatSecondsToDuration(30)).toBe('30s');
    expect(formatSecondsToDuration(60)).toBe('1m');
    expect(formatSecondsToDuration(3600)).toBe('1h');
    expect(formatSecondsToDuration(86400)).toBe('1d');
  });

  it('formats composite durations in d/h/m/s order', () => {
    expect(formatSecondsToDuration(5400)).toBe('1h30m');
    expect(formatSecondsToDuration(2 * 86400 + 5 * 3600)).toBe('2d5h');
    expect(formatSecondsToDuration(3600 + 1800 + 45)).toBe('1h30m45s');
  });
});

describe('normalizeDuration', () => {
  it('round-trips MikroTik strings', () => {
    expect(normalizeDuration('1h30m')).toBe('1h30m');
    expect(normalizeDuration('0s')).toBe('0s');
  });

  it('normalizes numbers to strings', () => {
    expect(normalizeDuration(3600)).toBe('1h');
    expect(normalizeDuration(0)).toBe('0s');
  });

  it('handles null/undefined gracefully', () => {
    expect(normalizeDuration(null)).toBe('0s');
    expect(normalizeDuration(undefined)).toBe('0s');
  });
});
