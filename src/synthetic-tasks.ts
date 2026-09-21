/**
 * Synthetic task construction: the `ENHANCE-*` / `VERIFY-*` tasks the
 * orchestrator splices into the queue after a feature group finishes
 * (feature-scoped /verify-loop, /vibe-enhance passes), plus the
 * VERIFY-before-ENHANCE
 * dependency wiring that holds an enhance pass back until its group's
 * review pass has landed.
 *
 * Split out of orchestrator.ts (round 3, item 5): pure bookkeeping over
 * `RunState.tasks` (build a task, splice it in, wire its dependency) with
 * no gate/audit/subagent concerns of its own, so it doesn't need to sit
 * next to the pass-driving loop. `runOrchestrator` calls
 * `sweepCompletedFeatures` once at startup (crash-recovery sweep) and
 * `maybeInjectGroupTasks` after every task finishes; nothing else in this
 * file is called from outside it.
 */
import type { RunState, Task, TaskKind } from './types.js';
import { effectiveVerifyMode } from './task-class.js';
import { printInfo } from './reporter.js';

/**
 * Synthetic tasks injected when a feature group completes, in run order:
 *   - `verify`  (only when verifyMode === 'feature'): one full /verify-loop
 *                over the group's combined diff, since per-task depth was
 *                gates-only in that mode.
 *   - `enhance` (only when vibeEnhance): the /vibe-enhance pass. Runs after
 *                verify so the researcher sees reviewed code, and it chains
 *                into /verify-loop on its own additions anyway.
 */
function syntheticKindsFor(state: RunState): TaskKind[] {
  const kinds: TaskKind[] = [];
  if (effectiveVerifyMode(state.config) === 'feature') kinds.push('verify');
  if (state.config.vibeEnhance) kinds.push('enhance');
  return kinds;
}

/**
 * Called after each task finishes. If the task that just finished was a
 * `user` task that reached `done` AND every other user task in its feature
 * group is also `done`, splice in the group's synthetic tasks (see
 * `syntheticKindsFor`) right after the group's last task, skipping any kind
 * already injected for that group. The next `queue.next()` will pick them
 * up before any task from a different group.
 *
 * Tasks with `feature: undefined` form one implicit group — this is the
 * "no h2 headings" case (auto-mode, plain tasks.md without grouping). The
 * synthetic tasks fire after the very last user task in the file.
 *
 * Failed sibling tasks block injection: a feature isn't "complete" if any
 * of its user tasks went terminal-failed. The check uses `every status ===
 * 'done'`, so failed/deferred sibling tasks short-circuit it. This matches
 * the user's intent that vibe-enhance / feature verification fire only on
 * COMPLETED features.
 */
export function maybeInjectGroupTasks(justFinished: Task, state: RunState): void {
  const kinds = syntheticKindsFor(state);
  if (kinds.length === 0) return;
  if (justFinished.kind !== 'user') return;
  if (justFinished.status !== 'done') return;
  injectSyntheticTasksForFeature(justFinished.feature, kinds, state, 'queued');
}

/**
 * One-shot sweep: for each distinct feature group in `state.tasks`, inject
 * any missing synthetic task whose group is fully `done`. Used at
 * orchestrator startup to recover from a crash that killed the per-task
 * injection in `processOneTask`'s caller. No-op on a fresh run (no feature
 * can be complete yet) and on mid-run resume after a normal task crash
 * (whichever group's last task was in_progress isn't `done`).
 */
export function sweepCompletedFeatures(state: RunState): void {
  const kinds = syntheticKindsFor(state);
  if (kinds.length === 0) return;
  // Collect distinct features (including `undefined` for the implicit group).
  // Use a Map so the implicit group's `undefined` key survives a Set.
  const featureSeen = new Map<string | undefined, true>();
  for (const t of state.tasks) {
    if (t.kind === 'user') featureSeen.set(t.feature, true);
  }
  for (const feature of featureSeen.keys()) {
    injectSyntheticTasksForFeature(feature, kinds, state, 'Resume sweep: queued');
  }
}

function injectSyntheticTasksForFeature(
  feature: string | undefined,
  kinds: TaskKind[],
  state: RunState,
  logPrefix: string
): void {
  const sameGroup = state.tasks.filter(
    (t) => t.kind === 'user' && t.feature === feature
  );
  if (sameGroup.length === 0) return;
  if (!sameGroup.every((t) => t.status === 'done')) return;

  for (const kind of kinds) {
    // Already injected for this group? Don't double up.
    const existing = state.tasks.find((t) => t.kind === kind && t.feature === feature);
    if (existing) continue;

    // Insert immediately after the group's last task — counting synthetic
    // tasks already injected for the group, so verify → enhance keep their
    // relative order and the natural array-order scan in `queue.next()`
    // picks them before tasks of other groups. For undefined-feature
    // (implicit group), this puts them at the end.
    let lastIndex = -1;
    for (let i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].feature === feature) lastIndex = i;
    }
    if (lastIndex === -1) continue; // defensive — sameGroup was non-empty so this shouldn't happen

    const synthetic = buildSyntheticTask(kind, feature, sameGroup, state.currentPass, state.tasks);
    // The enhance pass reviews the group AFTER its verification pass fixed
    // what the reviewers found: make that an explicit dependency so a
    // deferred VERIFY-<feature> holds the ENHANCE-<feature> back instead of
    // letting it enhance code that is still under review.
    if (kind === 'enhance') {
      const verify = state.tasks.find((t) => t.kind === 'verify' && t.feature === feature);
      if (verify && !synthetic.dependencies.includes(verify.id)) synthetic.dependencies.push(verify.id);
    }
    state.tasks.splice(lastIndex + 1, 0, synthetic);
    const label = kind === 'verify' ? 'feature verification' : 'vibe-enhance pass';
    printInfo(
      `${logPrefix} ${label} for ${feature ? `feature "${feature}"` : 'end-of-run'} (${synthetic.id}).`
    );
  }
}

/**
 * Construct a synthetic task. ID is derived from the kind + feature name (or
 * "ALL" for the implicit group) so it's distinguishable from user task IDs
 * in reports and logs. The body carries the just-completed task titles +
 * bodies so the prompt builder can render them — and so resume after a
 * crash sees the full scope without recomputing.
 */
function buildSyntheticTask(
  kind: TaskKind,
  feature: string | undefined,
  groupTasks: Task[],
  currentPass: number,
  existingTasks: Task[] = []
): Task {
  const slug = feature
    ? feature
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
    : 'all';
  const prefix = kind === 'verify' ? 'VERIFY' : 'ENHANCE';
  const baseId = `${prefix}-${slug || 'group'}`;
  const existingIds = new Set(existingTasks.map((t) => t.id));
  let id = baseId;
  for (let i = 2; existingIds.has(id); i++) {
    id = `${baseId}-${i}`;
  }
  const titleLabel = feature
    ? `feature "${feature}"`
    : 'all completed user tasks';
  // Include the FULL body (acceptance criteria, file paths, sub-bullets) of
  // each user task — title alone gives the researcher / reviewer subagent
  // only a surface view of what was just shipped, weakening both the
  // convention axis ("are the table-stakes features in place?") and the
  // requirements-fit axis ("does the implementation match what was
  // asked?"). Cap each task body at ~800 chars so a verbose group doesn't
  // blow up the prompt context: that's enough for typical acceptance-
  // criteria sub-bullets but not for full RFCs that occasionally land in
  // task bodies. The cap is per-task, not aggregate, so a 20-task group
  // still surfaces every task's gist.
  const PER_TASK_BODY_CAP = 800;
  const bodyLines = groupTasks.map((t) => {
    const head = `- ${t.id}: ${t.title}`;
    if (!t.body || t.body.trim() === t.title.trim()) return head;
    const body = t.body.length > PER_TASK_BODY_CAP
      ? `${t.body.slice(0, PER_TASK_BODY_CAP)}…(truncated)`
      : t.body;
    // Indent body so it visually nests under the bullet.
    const indented = body
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    return `${head}\n${indented}`;
  });
  // Match the queue's pass-aware status filter: pass 1 looks for 'pending',
  // pass >= 2 looks for 'deferred'. If we set status='pending' while
  // currentPass=2, queue.next() never picks it and end-of-pass promotion
  // turns it into 'deferred' for the next pass — which under a low
  // maxPasses (e.g. user-overridden to 1) could mean it never runs.
  const status = currentPass === 1 ? 'pending' : 'deferred';
  return {
    id,
    title: kind === 'verify'
      ? `feature verification (/verify-loop depth=full) for ${titleLabel}`
      : `vibe-enhance pass for ${titleLabel}`,
    body: bodyLines.join('\n'),
    dependencies: groupTasks.map((t) => t.id),
    status,
    attempts: [],
    feature,
    kind,
  };
}
