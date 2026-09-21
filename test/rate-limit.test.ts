import { describe, it, expect } from 'vitest';
import { backoffSecFor, DEFAULT_RATE_LIMIT_BACKOFF, detectRateLimit } from '../src/runner/rate-limit.js';

describe('detectRateLimit', () => {
  it('recognizes realistic rate-limit / usage-cap error shapes', () => {
    const fixtures = [
      'Error: rate_limit_error: Number of request tokens has exceeded your rate limit.',
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"..."}}',
      "You've hit your usage limit for this session. Try again later.",
      'Claude usage limit reached for this session. resets at 3:45pm',
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      'Error: rate limit exceeded, please slow down your requests',
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
    // No hint clause: still detected as limited, resetHint stays undefined.
    expect(detectRateLimit('rate_limit_error').resetHint).toBeUndefined();
    // Never throws, whatever the shape of the text.
    expect(() => detectRateLimit('rate limit' + '\u0000'.repeat(10))).not.toThrow();
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
