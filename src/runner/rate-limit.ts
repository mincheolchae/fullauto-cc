/**
 * Rate-limit detection for `claude -p` spawns.
 *
 * The CLI surfaces a rate-limit / usage-cap condition as a nonzero exit with
 * a diagnostic message on stdout or stderr — there is no structured exit
 * code for it. Every long-running unattended session (implementer, planner,
 * evolve shape/plan/assess) needs to tell "genuinely rate-limited, back off
 * and retry" apart from "real failure, defer and move on", so this is a
 * single shared text sniffer rather than each call site guessing.
 *
 * The message often carries an exact reset time ("resets 5:50pm
 * (Asia/Seoul)"). `resetHintSleepMs` turns that into a sleep duration so
 * `spawnClaudeWithBackoff` can wait close to the real reopening instead of
 * blind exponential backoff capped at `maxBackoffSec` — a session hit early
 * in a long reset window would otherwise burn many 900s-spaced retries
 * (each a real failed `claude -p` round trip) before the window actually
 * reopens.
 */

/** Result of scanning a subagent's combined stdout+stderr for a rate-limit signal. */
export interface RateLimitSignal {
  limited: boolean;
  /** Best-effort reset hint (e.g. "3:45pm" / an ISO timestamp), when the message included one. Never throws on unparseable text. */
  resetHint?: string;
}

/**
 * Phrases observed (or documented by Anthropic) in `claude` CLI rate-limit /
 * usage-cap errors. Deliberately broad — a false positive here just means an
 * ordinary failure gets one extra backoff-and-retry cycle before falling
 * through to the normal `subagent_error` path (see `spawnClaudeWithBackoff`),
 * which is cheap; a false negative means the old hammer-the-API behavior.
 */
const RATE_LIMIT_RE =
  /rate[_ -]?limit(?:ed)?|(?:^|[^0-9])429(?:[^0-9]|$)|usage limit|session limit|overloaded_error|resets?\s+(?:at|in)\b|resets?\s+\d{1,2}(?::\d{2})?\s*[ap]m\b/i;

/**
 * Captures a trailing reset clause, best-effort, in either shape actually
 * observed:
 *   - "resets at 3:45pm" / "resets in 2 hours" (relative or `at`-prefixed)
 *   - "resets 5:50pm (Asia/Seoul)" (the CLI's real, `at`-less phrasing,
 *     optionally followed by a parenthesized IANA zone) — confirmed live
 *     against a real session-limit error.
 * Group 1 covers the first shape, group 2 the second; `detectRateLimit`
 * takes whichever matched.
 */
const RESET_HINT_RE =
  /resets?\s+(?:(?:at|in)\s+([^\n.,;]+)|(\d{1,2}(?::\d{2})?\s*[ap]m\b(?:\s*\([^)\n]+\))?))/i;

export function detectRateLimit(text: string | undefined): RateLimitSignal {
  if (!text) return { limited: false };
  if (!RATE_LIMIT_RE.test(text)) return { limited: false };
  let resetHint: string | undefined;
  try {
    const m = RESET_HINT_RE.exec(text);
    resetHint = (m?.[1] ?? m?.[2])?.trim() || undefined;
  } catch {
    // Regex exec on a string literally cannot throw, but the whole point of
    // "best-effort" is that a future tweak to this pattern must never take
    // the caller down with it.
    resetHint = undefined;
  }
  return { limited: true, resetHint };
}

// ---------- reset-hint-aware sleep ----------

/**
 * Ceiling on how long a PARSED reset hint is allowed to make the caller
 * sleep, however far away it appears to compute to. `resetHint` comes from
 * the subagent's own stdout/stderr — untrusted text a malicious tasks.md
 * cannot directly control (it's the real `claude` binary's own output), but
 * a clock-time parse can still be wrong (AM/PM edge case, a stale/foreign
 * locale, a wrap-to-tomorrow miscalculation). Capping bounds the damage of
 * a bad parse to "a few wasted hours", never "the run silently sleeps most
 * of a day" — the exponential backoff path remains the fallback for
 * anything this cannot confidently resolve.
 */
export const RESET_HINT_MAX_SLEEP_SEC = 6 * 60 * 60;

/**
 * Buffer added past the parsed reset instant, so the retry lands just after
 * the window reopens rather than racing its exact boundary.
 */
export const RESET_HINT_SAFETY_MARGIN_SEC = 30;

const CLOCK_TIME_RE = /^(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b(?:\s*\(([^)]+)\))?/i;

/**
 * The UTC-vs-local offset (ms) of `date` as observed in IANA zone
 * `timeZone` — i.e. `(wall-clock time in timeZone, read as if it were UTC)
 * - (true UTC instant)`. Standard `Intl`-based trick for converting a
 * zoned wall-clock time to/from an absolute instant without a date library.
 * Computed AT `date` (not a fixed constant) so a DST transition inside the
 * zone is reflected; `resetHintSleepMs`'s 6h cap keeps the residual error
 * from a transition landing exactly inside the sleep window negligible.
 */
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

/**
 * The next instant `hour:minute` (24h, in `timeZone` when given, else the
 * process's local zone) occurs at or after `now`. Wraps to tomorrow when
 * that time-of-day already passed today. Returns undefined only when
 * `timeZone` is an unrecognized IANA name (`Intl` throws).
 */
function nextOccurrenceOf(hour: number, minute: number, now: Date, timeZone?: string): Date | undefined {
  try {
    const offsetMs = timeZone ? tzOffsetMs(now, timeZone) : -now.getTimezoneOffset() * 60_000;
    const nowInZone = new Date(now.getTime() + offsetMs);
    let candidate =
      Date.UTC(nowInZone.getUTCFullYear(), nowInZone.getUTCMonth(), nowInZone.getUTCDate(), hour, minute, 0, 0) -
      offsetMs;
    if (candidate <= now.getTime()) candidate += 24 * 60 * 60 * 1000;
    return new Date(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort: turn a `RateLimitSignal.resetHint` into a sleep duration (ms)
 * from `now` until just past that reset. Returns undefined when the hint is
 * not a clock time this can parse (e.g. "2 hours" — the caller's exponential
 * backoff already handles a relative duration fine; teaching this function
 * relative-time arithmetic would just be a second implementation of the
 * same thing) — the caller falls back to normal backoff in that case.
 * Never throws; a malformed timezone name or an unparseable hint both
 * resolve to undefined rather than a bad sleep.
 */
export function resetHintSleepMs(resetHint: string | undefined, now: Date = new Date()): number | undefined {
  if (!resetHint) return undefined;
  const m = CLOCK_TIME_RE.exec(resetHint.trim());
  if (!m) return undefined;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  const isPm = m[3].toLowerCase() === 'pm';
  if (hour === 12) hour = 0; // 12am → 0, 12pm → 12 (handled by the +12 below)
  hour += isPm ? 12 : 0;
  const timeZone = m[4]?.trim();

  const target = nextOccurrenceOf(hour, minute, now, timeZone);
  if (!target) return undefined;
  const ms = target.getTime() - now.getTime() + RESET_HINT_SAFETY_MARGIN_SEC * 1000;
  if (ms <= 0) return undefined;
  return Math.min(ms, RESET_HINT_MAX_SLEEP_SEC * 1000);
}

/** Backoff policy for retrying a rate-limited `claude -p` spawn. */
export interface RateLimitBackoff {
  /** Seconds before the FIRST retry (doubles each subsequent retry). */
  baseBackoffSec: number;
  /** Ceiling on any single wait, however many consecutive hits. */
  maxBackoffSec: number;
  /** Retries exhausted after this many consecutive rate-limit hits → give up and let the caller defer. */
  maxRetries: number;
}

/** Defaults used by every call site that does not have a `RunConfig` to source them from (planner, evolve stages). */
export const DEFAULT_RATE_LIMIT_BACKOFF: RateLimitBackoff = {
  baseBackoffSec: 30,
  maxBackoffSec: 900,
  maxRetries: 10,
};

/** `min(base * 2^(attempt-1), cap)`, `attempt` is 1-based (the first retry). */
export function backoffSecFor(attempt: number, policy: RateLimitBackoff): number {
  const scaled = policy.baseBackoffSec * 2 ** Math.max(0, attempt - 1);
  return Math.min(scaled, policy.maxBackoffSec);
}

/**
 * The wait (ms) before the next retry of a rate-limited spawn: the CLI's
 * own reported reset time when `resetHint` parses as a clock time, else the
 * exponential backoff schedule. Pulled out of `spawnClaudeWithBackoff`
 * (runner/claude.ts) as a pure function so the selection between the two
 * strategies is unit-testable without actually spawning a process or
 * sleeping for real.
 */
export function computeRetryWaitMs(
  resetHint: string | undefined,
  attempt: number,
  backoff: RateLimitBackoff,
  now?: Date
): number {
  return resetHintSleepMs(resetHint, now) ?? Math.round(backoffSecFor(attempt, backoff) * 1000);
}
