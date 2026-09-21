/**
 * Rate-limit detection for `claude -p` spawns.
 *
 * The CLI surfaces a rate-limit / usage-cap condition as a nonzero exit with
 * a diagnostic message on stdout or stderr — there is no structured exit
 * code for it. Every long-running unattended session (implementer, planner,
 * evolve shape/plan/assess) needs to tell "genuinely rate-limited, back off
 * and retry" apart from "real failure, defer and move on", so this is a
 * single shared text sniffer rather than each call site guessing.
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
  /rate[_ -]?limit(?:ed)?|(?:^|[^0-9])429(?:[^0-9]|$)|usage limit|session limit|overloaded_error|resets?\s+(?:at|in)\b/i;

/** Captures a trailing "resets at/in <hint>" clause, best-effort. */
const RESET_HINT_RE = /resets?\s+(?:at|in)\s+([^\n.,;]+)/i;

export function detectRateLimit(text: string | undefined): RateLimitSignal {
  if (!text) return { limited: false };
  if (!RATE_LIMIT_RE.test(text)) return { limited: false };
  let resetHint: string | undefined;
  try {
    const m = RESET_HINT_RE.exec(text);
    resetHint = m?.[1]?.trim() || undefined;
  } catch {
    // Regex exec on a string literally cannot throw, but the whole point of
    // "best-effort" is that a future tweak to this pattern must never take
    // the caller down with it.
    resetHint = undefined;
  }
  return { limited: true, resetHint };
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
