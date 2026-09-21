/**
 * `fullauto audit`'s core: run the deterministic post-task audit over the
 * whole working tree against a base ref, as one synthetic task, instead of
 * a real task's before/after attempt diff. Split out of cli.ts's `audit`
 * command (round 3, item 5) so the assembly (snapshots, the manual audit's
 * classification/task shape, the `wiringManifest`/`testCount` overrides
 * that only make sense with a subagent transcript) is unit-testable without
 * going through the CLI process, and so a future `/wiring-audit` skill
 * improvement or an `evolve` stage can call this directly instead of
 * shelling out to `fullauto audit`.
 *
 * Deliberately returns DATA, not printed output — JSON vs. bullet-list
 * rendering and `process.exitCode` stay in cli.ts, the presentation layer.
 */
import { RunConfig, type Task } from '../types.js';
import type { TaskClassification } from './types.js';
import { loadUserConfig } from '../persistence.js';
import { runAudit, takeBaseSnapshot, takeSnapshot, type AuditRunResult } from './index.js';
import type { TreeSnapshot } from './types.js';

export type ManualAuditOutcome =
  | { status: 'not-git-repo' }
  | { status: 'base-not-found'; base: string }
  | { status: 'ok'; base: string; before: TreeSnapshot; after: TreeSnapshot; result: AuditRunResult };

/**
 * "before" = the clean tree at `base` (nothing dirty), "after" = the real
 * working tree. Diffing them attributes every uncommitted change — plus
 * every commit between base and HEAD when `base` is older than HEAD — to
 * one synthetic task, which is exactly what a manual audit wants.
 */
export async function runManualAudit(projectDir: string, base?: string): Promise<ManualAuditOutcome> {
  const effectiveBase = base ?? 'HEAD';
  const before = await takeBaseSnapshot(projectDir, effectiveBase);
  if (before.gitRepo === false) {
    // Nothing to diff against: the audit is a tree diff. Not an error —
    // /verify-loop calls this as a pre-check and must keep going.
    return { status: 'not-git-repo' };
  }
  if (base && before.headSha === null) {
    return { status: 'base-not-found', base: effectiveBase };
  }
  const after = await takeSnapshot(projectDir);

  // Audit options come from the project config when present; two checks
  // are forced off because they need a subagent transcript / gate output
  // that a manual invocation doesn't have (they'd only emit noise).
  const userConfigRaw = await loadUserConfig(projectDir);
  const parsedConfig = userConfigRaw ? RunConfig.safeParse(userConfigRaw) : undefined;
  const baseOptions = parsedConfig?.success ? parsedConfig.data.audit : RunConfig.parse({}).audit;
  const options = { ...baseOptions, enabled: true, wiringManifest: false, testCount: false };

  const classification: TaskClassification = {
    kind: 'impl',
    risk: 'medium',
    tdd: 'none',
    redTaskIds: [],
    greenTaskIds: [],
    allowsConfigChange: false,
    allowsTestEdits: false,
    rationale: ['kind=impl (manual audit)', 'risk=medium (manual audit)'],
  };
  const task: Task = {
    id: 'AUDIT',
    title: `manual audit of working tree vs ${effectiveBase}`,
    body: '',
    dependencies: [],
    status: 'in_progress',
    attempts: [],
    kind: 'user',
  };

  const result = await runAudit({
    projectDir,
    task,
    classification,
    before,
    after,
    gateResults: [],
    subagentStdout: '',
    redTests: [],
    pendingWiring: [],
    options,
  });

  return { status: 'ok', base: effectiveBase, before, after, result };
}
