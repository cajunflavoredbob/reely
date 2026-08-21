import { describe, expect, it } from 'vitest';
import { formatDuration } from '../../web/app/src/utils/format';

// Plex gives durations in ms; the UI shows "Hh Mm", or "Mm" under an hour.
describe('formatDuration', () => {
  it('shows just minutes when under an hour', () => {
    expect(formatDuration(0)).toBe('0M');
    expect(formatDuration(60_000)).toBe('1M');
    expect(formatDuration(45 * 60_000)).toBe('45M');
  });

  it('shows hours + minutes when at or over an hour', () => {
    expect(formatDuration(60 * 60_000)).toBe('1H 0M');
    expect(formatDuration(90 * 60_000)).toBe('1H 30M');
    expect(formatDuration(2 * 60 * 60_000 + 5 * 60_000)).toBe('2H 5M');
  });

  it('rounds (not floors) to the nearest minute', () => {
    // 91s = 1.51 min.
    expect(formatDuration(91_000)).toBe('2M');
    // 89s = 1.48 min.
    expect(formatDuration(89_000)).toBe('1M');
  });

  it('handles large durations cleanly (multi-hour movies)', () => {
    expect(formatDuration(210 * 60_000)).toBe('3H 30M');
  });

  it('shows hour-only-minutes-zero correctly at the boundary', () => {
    expect(formatDuration(60 * 60_000 - 500)).toBe('1H 0M'); // 59:59.5 -> 60 min
  });
});
