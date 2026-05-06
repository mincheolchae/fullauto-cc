import type { Task } from './types.js';

/**
 * Result of validating a planner-emitted task list. `ok: true` means the
 * orchestrator can safely consume it; `ok: false` means at least one fatal
 * issue exists and the run should NOT start (the planner ran on a stale
 * model state, the prompt hit length pressure and dropped a dependency,
 * etc.).
 *
 * The orchestrator could in theory tolerate some of these (unknown deps
 * are silently treated as satisfied by `queue.dependenciesSatisfied`, and
 * cycles only get a warn at startup) — but tolerating means a malformed
 * plan runs to completion and produces wrong work. Better to fail fast
 * here so the user can re-plan with a sharper description or edit the
 * file directly.
 */
export interface PlanValidationResult {
  ok: boolean;
  /** Fatal — caller should abort. */
  errors: string[];
  /** Non-fatal — caller logs them but proceeds. */
  warnings: string[];
}

/**
 * Validate a planner-emitted task list before handing it to the
 * orchestrator. Catches three classes of failure:
 *
 *   1. Dangling dependencies — `(depends on T999)` where T999 isn't in the
 *      list. Tasks that depend on the missing ID would get treated as
 *      "deps satisfied" by the queue's defensive fallback (it can't tell
 *      the difference between "parser stripped IDs" and "planner
 *      hallucinated"), so they'd start before their actual prerequisites
 *      finish, producing wrong work.
 *
 *   2. Duplicate task IDs — would shadow each other in the queue. The
 *      first occurrence in source order wins; the second silently never
 *      runs. Always indicates planner confusion.
 *
 *   3. Cycles in the dep graph — a → b → a. Tasks in the cycle never
 *      become eligible (`dependenciesSatisfied` requires all deps to be
 *      `done`), so they burn through `maxPasses` as deferred and fail at
 *      the end. Better to surface the cycle now.
 *
 * Tests intentionally NOT validated here: paired-test enforcement,
 * Manual Prerequisites section presence, Assumptions section presence.
 * Those are LLM-judged compliance with prompt rules; surfacing them as
 * validator errors creates false positives (e.g. a self-contained
 * refactor genuinely has no manual prereqs) and the orchestrator's gates
 * + run-end report already catch the consequences when they matter.
 */
export function validatePlanShape(tasks: Task[]): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (tasks.length === 0) {
    errors.push('Task list is empty.');
    return { ok: false, errors, warnings };
  }

  // 1. Duplicate IDs.
  const seen = new Map<string, number>();
  for (const t of tasks) {
    seen.set(t.id, (seen.get(t.id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) {
      errors.push(`Duplicate task ID "${id}" appears ${count} times.`);
    }
  }

  // 2. Dangling dependencies.
  const knownIds = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      if (!knownIds.has(dep)) {
        errors.push(
          `Task ${t.id} depends on "${dep}" which is not in the task list. The planner likely hallucinated the ID, or stripped a task that other tasks reference.`
        );
      }
    }
  }

  // 3. Cycles. Iterative DFS; collect one representative path per cycle so
  //    a SCC of size > 2 doesn't drown the report. Skip dangling deps —
  //    they're already errored above and would just produce noise.
  const cycles = findCycles(tasks, knownIds);
  for (const path of cycles) {
    errors.push(`Dependency cycle: ${path}.`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

function findCycles(tasks: Task[], knownIds: Set<string>): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const cycles: string[] = [];
  const seenCycles = new Set<string>();
  const visited = new Set<string>();

  // DFS state per starting node uses its own onStack so unrelated chains
  // don't false-share. Stack is a list to preserve path order; onStack is
  // a set for O(1) membership.
  const dfs = (id: string, stack: string[], onStack: Set<string>): void => {
    if (onStack.has(id)) {
      const start = stack.indexOf(id);
      const cyclePath = [...stack.slice(start), id];
      const key = canonicalCycleKey(cyclePath);
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        cycles.push(cyclePath.join(' → '));
      }
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    onStack.add(id);
    stack.push(id);
    const task = byId.get(id);
    if (task) {
      for (const depId of task.dependencies) {
        if (!knownIds.has(depId)) continue; // dangling — handled elsewhere
        dfs(depId, stack, onStack);
      }
    }
    stack.pop();
    onStack.delete(id);
  };

  for (const t of tasks) {
    if (visited.has(t.id)) continue;
    dfs(t.id, [], new Set());
  }
  return cycles;
}

/**
 * Two different DFS entry points can hit the same cycle from different
 * angles (e.g. a→b→c→a vs b→c→a→b). Rotate to a canonical starting
 * point (lexicographically smallest member) so the dedup set treats them
 * as the same finding.
 */
function canonicalCycleKey(path: string[]): string {
  // Drop the closing repetition so we rotate over the unique members.
  const unique = path.slice(0, -1);
  if (unique.length === 0) return '';
  let min = unique[0];
  let minIdx = 0;
  for (let i = 1; i < unique.length; i++) {
    if (unique[i] < min) {
      min = unique[i];
      minIdx = i;
    }
  }
  const rotated = unique.slice(minIdx).concat(unique.slice(0, minIdx));
  return rotated.join('|');
}
