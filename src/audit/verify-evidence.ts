/**
 * verify-evidence: did the implementer actually run `/verify-loop` at the
 * depth it was told to?
 *
 * The implementer prompt says "invoke `/verify-loop depth=light|full`" and
 * the skill ends with a mandatory
 *
 *   VERIFY_LOOP_RESULT: depth=<gates|light|full> cycles=<n> block=<n> warn=<n>
 *
 * line. Without checking for it, "ran the review" is a claim like any other:
 * an implementer that skips the loop (or runs it at `gates`) still ends with
 * green gates and a clean-looking transcript. This check makes the line the
 * receipt — required when the task's depth was `light` / `full`, and its
 * `depth=` must be at least the required one (gates < light < full). A
 * `block=<n>` above zero means the loop ended with unresolved BLOCKs; that
 * is the DEFER path, so it is surfaced as WARN.
 *
 * Skipped (no findings) when the depth is unknown (`verifyDepth` not given —
 * manual `fullauto audit`), when there is no transcript at all, or when the
 * depth was `gates` (the loop must NOT run there).
 */
import type { AuditFinding, AuditInput, VerifyDepth } from './types.js';

export interface VerifyLoopResult {
  depth: VerifyDepth;
  cycles?: number;
  block?: number;
  warn?: number;
}

const DEPTH_RANK: Record<VerifyDepth, number> = { gates: 0, light: 1, full: 2 };
const RESULT_LINE_RE = /^\s*VERIFY_LOOP_RESULT:\s*depth=(\S+)/m;

function isDepth(v: string): v is VerifyDepth {
  return v === 'gates' || v === 'light' || v === 'full';
}

/**
 * Parse the LAST `VERIFY_LOOP_RESULT:` line of `stdout` (the loop may print
 * interim ones). Tolerates bold / backtick markdown around the line.
 * Returns undefined when no line carries a `depth=` field.
 */
export function parseVerifyLoopResult(stdout: string): VerifyLoopResult | undefined {
  let found: VerifyLoopResult | undefined;
  for (const raw of (stdout ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/[*`]/g, '');
    const m = RESULT_LINE_RE.exec(line);
    if (!m) continue;
    const depthRaw = m[1].replace(/[^a-z]/gi, '').toLowerCase();
    if (!isDepth(depthRaw)) continue;
    const num = (key: string): number | undefined => {
      const n = new RegExp(`\\b${key}\\s*=\\s*(\\d+)`, 'i').exec(line);
      return n ? Number(n[1]) : undefined;
    };
    found = { depth: depthRaw, cycles: num('cycles'), block: num('block'), warn: num('warn') };
  }
  return found;
}

/** True when `stdout` has a line matching the mandatory `VERIFY_LOOP_RESULT: depth=…` shape. */
export function hasVerifyLoopResult(stdout: string): boolean {
  return RESULT_LINE_RE.test((stdout ?? '').replace(/[*`]/g, ''));
}

export function checkVerifyEvidence(input: Pick<AuditInput, 'verifyDepth' | 'subagentStdout' | 'classification'>): AuditFinding[] {
  const required = input.verifyDepth;
  if (!required || required === 'gates') return []; // unknown ⇒ skip; gates ⇒ the loop must not run
  const stdout = input.subagentStdout ?? '';
  if (!stdout.trim()) return []; // no transcript (manual audit): nothing to verify

  const result = parseVerifyLoopResult(stdout);
  if (!result) {
    return [
      {
        check: 'verify-evidence',
        severity: 'block',
        message: `verify-loop was required (depth=${required}) but no VERIFY_LOOP_RESULT line was emitted — run /verify-loop depth=${required} and end the message with its \`VERIFY_LOOP_RESULT: depth=${required} cycles=<n> block=<n> warn=<n>\` line`,
      },
    ];
  }
  const findings: AuditFinding[] = [];
  if (DEPTH_RANK[result.depth] < DEPTH_RANK[required]) {
    findings.push({
      check: 'verify-evidence',
      severity: 'block',
      message: `verify-loop ran at depth=${result.depth} but depth=${required} was required — re-run /verify-loop depth=${required} (the task's risk classification decides the depth, not the implementer)`,
    });
  }
  if ((result.block ?? 0) > 0) {
    findings.push({
      check: 'verify-evidence',
      severity: 'warn',
      message: `verify-loop ended with ${result.block} unresolved BLOCK(s) (VERIFY_LOOP_RESULT: depth=${result.depth}${result.cycles !== undefined ? ` cycles=${result.cycles}` : ''} block=${result.block}) — unresolved BLOCKs must go through the DEFER path (\`FULLAUTO_RESULT: DEFER\` with \`unmet:\`), not a completion claim; fix them or defer`,
    });
  }
  return findings;
}
