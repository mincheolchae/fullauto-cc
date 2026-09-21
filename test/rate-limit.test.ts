import { describe, it, expect } from 'vitest';
import {
  backoffSecFor,
  computeRetryWaitMs,
  DEFAULT_RATE_LIMIT_BACKOFF,
  detectRateLimit,
  resetHintSleepMs,
  RESET_HINT_MAX_SLEEP_SEC,
  RESET_HINT_SAFETY_MARGIN_SEC,
} from '../src/runner/rate-limit.js';

describe('detectRateLimit', () => {
  it('recognizes realistic rate-limit / usage-cap error shapes', () => {
    const fixtures = [
      'Error: rate_limit_error: Number of request tokens has exceeded your rate limit.',
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"..."}}',
      "You've hit your usage limit for this session. Try again later.",
      'Claude usage limit reached for this session. resets at 3:45pm',
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      'Error: rate limit exceeded, please slow down your requests',
      // Verbatim shape observed live against a real session-limit error.
      "You've hit your session limit · resets 5:50pm (Asia/Seoul)",
    ];
    for (const text of fixtures) {
      expect(detectRateLimit(text).limited, text).toBe(true);
    }
  });

  it('does not flag an ordinary failure', () => {
    const fixtures = [
      '',
      undefined,
      'TypeError: Cannot read properties of undefined',
      'Error: ENOENT: no such file or directory, open \'/tmp/missing\'',
      'Test suite failed with 3 failing tests',
    ];
    for (const text of fixtures) {
      expect(detectRateLimit(text).limited, String(text)).toBe(false);
    }
  });

  it('extracts a best-effort reset hint when present, without throwing on odd input', () => {
    expect(detectRateLimit('rate limit hit. resets at 3:45pm').resetHint).toBe('3:45pm');
    expect(detectRateLimit('usage limit reached, resets in 2 hours').resetHint).toBe('2 hours');
    // The CLI's real `at`-less phrasing, with a parenthesized IANA zone.
    expect(detectRateLimit("You've hit your session limit · resets 5:50pm (Asia/Seoul)").resetHint).toBe(
      '5:50pm (Asia/Seoul)'
    );
    // No hint clause: still detected as limited, resetHint stays undefined.
    expect(detectRateLimit('rate_limit_error').resetHint).toBeUndefined();
    // Never throws, whatever the shape of the text.
    expect(() => detectRateLimit('rate limit' + '\u0000'.repeat(10))).not.toThrow();
  });
});

describe('resetHintSleepMs', () => {
  // Asia/Seoul has no DST (always UTC+9), so these are exact and
  // host-timezone-independent regardless of where the tests run.
  it('sleeps until just past a same-day reset time in the named zone', () => {
    // 2024-06-01T08:00:00Z = 17:00:00 in Asia/Seoul.
    const now = new Date('2024-06-01T08:00:00.000Z');
    const ms = resetHintSleepMs('5:50pm (Asia/Seoul)', now);
    // 50 minutes until 17:50 Seoul time, plus the safety margin.
    expect(ms).toBe(50 * 60_000 + RESET_HINT_SAFETY_MARGIN_SEC * 1000);
  });

  it('wraps to tomorrow when the time-of-day already passed today, capped at RESET_HINT_MAX_SLEEP_SEC', () => {
    // 2024-06-01T08:55:00Z = 17:55:00 in Asia/Seoul — 17:50 already passed.
    const now = new Date('2024-06-01T08:55:00.000Z');
    const ms = resetHintSleepMs('5:50pm (Asia/Seoul)', now);
    // Real diff would be ~23h55m — far past the cap.
    expect(ms).toBe(RESET_HINT_MAX_SLEEP_SEC * 1000);
  });

  it('returns undefined for a relative-duration hint (the caller falls back to exponential backoff)', () => {
    expect(resetHintSleepMs('2 hours')).toBeUndefined();
    expect(resetHintSleepMs(undefined)).toBeUndefined();
    expect(resetHintSleepMs('')).toBeUndefined();
  });

  it('never throws on an unrecognized IANA zone name — resolves to undefined', () => {
    expect(() => resetHintSleepMs('5:50pm (Not/AZone)')).not.toThrow();
    expect(resetHintSleepMs('5:50pm (Not/AZone)')).toBeUndefined();
  });

  it('falls back to local time when the hint has no parenthesized zone', () => {
    const now = new Date('2024-06-01T08:00:00.000Z');
    const ms = resetHintSleepMs('11:59pm', now);
    expect(ms).not.toBeUndefined();
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(RESET_HINT_MAX_SLEEP_SEC * 1000);
  });

  it('handles the 12am/12pm wraparound correctly', () => {
    // 2024-06-01T00:00:00Z = 09:00:00 Seoul. Target 12:30am Seoul today
    // already passed (it's 9am) — wraps to tomorrow.
    const now = new Date('2024-06-01T00:00:00.000Z');
    const midnight = resetHintSleepMs('12:30am (Asia/Seoul)', now);
    expect(midnight).toBe(RESET_HINT_MAX_SLEEP_SEC * 1000); // wraps to tomorrow, capped

    // Noon (12pm) Seoul today is 3 hours away from 09:00 — under the cap.
    const noon = resetHintSleepMs('12:00pm (Asia/Seoul)', now);
    expect(noon).toBe(3 * 60 * 60_000 + RESET_HINT_SAFETY_MARGIN_SEC * 1000);
  });
});

describe('backoffSecFor', () => {
  it('doubles per consecutive hit and caps at maxBackoffSec', () => {
    const policy = { baseBackoffSec: 30, maxBackoffSec: 900, maxRetries: 10 };
    expect(backoffSecFor(1, policy)).toBe(30);
    expect(backoffSecFor(2, policy)).toBe(60);
    expect(backoffSecFor(3, policy)).toBe(120);
    expect(backoffSecFor(4, policy)).toBe(240);
    expect(backoffSecFor(5, policy)).toBe(480);
    expect(backoffSecFor(6, policy)).toBe(900); // 960 → capped
    expect(backoffSecFor(20, policy)).toBe(900);
  });

  it('DEFAULT_RATE_LIMIT_BACKOFF matches the documented defaults', () => {
    expect(DEFAULT_RATE_LIMIT_BACKOFF).toEqual({ baseBackoffSec: 30, maxBackoffSec: 900, maxRetries: 10 });
  });
});

describe('computeRetryWaitMs (used by spawnClaudeWithBackoff)', () => {
  const backoff = { baseBackoffSec: 30, maxBackoffSec: 900, maxRetries: 10 };

  it('prefers a parseable reset hint over the blind exponential schedule', () => {
    // 2024-06-01T08:00:00Z = 17:00:00 Asia/Seoul; target is 50 minutes away —
    // the blind schedule for attempt 1 would be only 30s (backoffSecFor).
    const now = new Date('2024-06-01T08:00:00.000Z');
    const ms = computeRetryWaitMs('5:50pm (Asia/Seoul)', 1, backoff, now);
    expect(ms).toBe(50 * 60_000 + RESET_HINT_SAFETY_MARGIN_SEC * 1000);
    expect(ms).not.toBe(Math.round(backoffSecFor(1, backoff) * 1000));
  });

  it('falls back to the exponential schedule when the hint is relative, not a clock time', () => {
    // The CLI's own second real phrasing ("resets in 2 hours") is left to
    // this fallback deliberately — see resetHintSleepMs's doc comment.
    expect(computeRetryWaitMs('2 hours', 2, backoff)).toBe(Math.round(backoffSecFor(2, backoff) * 1000));
    expect(computeRetryWaitMs(undefined, 3, backoff)).toBe(Math.round(backoffSecFor(3, backoff) * 1000));
  });
});
