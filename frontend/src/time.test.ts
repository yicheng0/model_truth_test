import { describe, expect, it } from 'vitest';
import { formatDateTime, parseApiDate } from './time';

describe('API date formatting', () => {
  it('treats timezone-less API timestamps as UTC and displays Shanghai time', () => {
    expect(formatDateTime('2026-05-09T12:00:00')).toBe('2026-05-09 20:00:00');
  });

  it('keeps explicit UTC timestamps equivalent to timezone-less UTC values', () => {
    expect(formatDateTime('2026-05-09T12:00:00Z')).toBe('2026-05-09 20:00:00');
  });

  it('respects explicit Asia/Shanghai offsets', () => {
    expect(formatDateTime('2026-05-09T20:00:00+08:00')).toBe('2026-05-09 20:00:00');
  });

  it('returns a placeholder for empty or invalid values', () => {
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime('')).toBe('-');
    expect(parseApiDate('not-a-date')).toBeNull();
  });
});
