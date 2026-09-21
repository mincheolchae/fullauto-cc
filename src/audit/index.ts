/**
 * Post-task deterministic audit — entry point.
 *
 * `runAudit` diffs the before/after snapshots, parses the test gate output,
 * runs every enabled check, and returns findings sorted block → warn → info.
 * Each check is isolated: an exception inside one becomes a WARN finding
 * under that check's name instead of taking the whole audit (and the task)
 * down — and instead of silently passing the task unaudited.
 */
import { diffSnapshots } from './diff.js';
import { checkGateIntegrity } from './gate-integrity.js';
import { checkOrphans } from './orphan.js';
import { checkTddEvidence, checkTddGreen, checkTddRed, findTestGate } from './tdd.js';
import { checkTestCount } from './test-count.js';
import { checkTestIntegrity, trivialTestBlocksAdded } from './test-integrity.js';
import { parseTestOutput, stripAnsi } from './test-output.js';
import { checkUnusedExports } from './unused-export.js';
import { checkVerifyEvidence } from './verify-evidence.js';
import { checkWiringClaims, parseWiringClaims } from './wiring-manifest.js';
import { DEFAULT_AUDIT_OPTIONS } from './types.js';
import type {
  AuditCheck,
  AuditFinding,
  AuditInput,
  AuditResult,
  AuditSeverity,
  PendingWiring,
  TaskDiff,
  TestCounts,
  TreeSnapshot,
} from './types.js';

export { takeSnapshot, takeBaseSnapshot, emptySnapshot, sha1File, sha1String } from './snapshot.js';
export { diffSnapshots } from './diff.js';
export { parseTestOutput, stripAnsi, failureMatchesFile, failureMatchesFiles, normalizePath } from './test-output.js';
export { checkOrphans } from './orphan.js';
export { checkUnusedExports, extractExports } from './unused-export.js';
export { parseWiringClaims, checkWiringClaims, hasWiringBlock } from './wiring-manifest.js';
export { checkTestIntegrity, countTrivialTestBlocks, trivialTestBlocksAdded } from './test-integrity.js';
export { checkGateIntegrity } from './gate-integrity.js';
export { checkTestCount } from './test-count.js';
export { checkTddRed, checkTddGreen, checkTddEvidence, buildRedTestRecord, findTestGate, parseTestChangeNotices, parseTddEvidence } from './tdd.js';
export { checkVerifyEvidence, parseVerifyLoopResult, hasVerifyLoopResult } from './verify-evidence.js';
export { isTestFile, isCodeFile, isGateConfigFile, isEntrypoint } from './patterns.js';
export * from './types.js';

/** `AuditResult` plus the pending-wiring bookkeeping the orchestrator applies on success. */
export interface AuditRunResult extends AuditResult {
  diff: TaskDiff;
  /** Wiring promises created by this task (`- wired by: T###`). */
  newPendingWiring: PendingWiring[];
  /** Wiring promises this task fulfilled (or that became moot). */
  resolvedPendingWiring: PendingWiring[];
}

const SEVERITY_ORDER: Record<AuditSeverity, number> = { block: 0, warn: 1, info: 2 };

export function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    if (a.check !== b.check) return a.check < b.check ? -1 : 1;
    return (a.path ?? '').localeCompare(b.path ?? '');
  });
}

function isNotGitRepo(before: TreeSnapshot, after: TreeSnapshot): boolean {
  if (before.gitRepo === false || after.gitRepo === false) return true;
  if (before.gitRepo === true || after.gitRepo === true) return false;
  return before.headSha === null && after.headSha === null && before.dirty.size === 0 && after.dirty.size === 0;
}

function countChanged(diff: TaskDiff): AuditResult['changed'] {
  const changed = { added: 0, modified: 0, deleted: 0 };
  for (const f of diff.files) changed[f.kind]++;
  return changed;
}

/**
 * A crashing check must not silently let the task through unaudited: the
 * failure is reported as WARN under the check's own name (so the report and
 * the next-pass prompt say which guarantee is missing), never as INFO.
 */
async function guarded(name: AuditCheck, run: () => Promise<AuditFinding[]> | AuditFinding[]): Promise<AuditFinding[]> {
  try {
    return await run();
  } catch (e) {
    return [
      {
        check: name,
        severity: 'warn',
        message: `audit check ${name} crashed and its guarantees were NOT verified for this task: ${(e as Error)?.message ?? String(e)} — review the change by hand (or retry the task) before trusting it`,
      },
    ];
  }
}

/** Parse the test gate output of `gateResults`, if a test gate exists. */
export function testCountsFromGates(input: Pick<AuditInput, 'gateResults' | 'projectDir'>): TestCounts | undefined {
  const gate = findTestGate(input.gateResults ?? []);
  if (!gate || typeof gate.output !== 'string') return undefined;
  return parseTestOutput(gate.output, { projectDir: input.projectDir });
}

export async function runAudit(input: AuditInput): Promise<AuditRunResult> {
  const emptyDiff: TaskDiff = { files: [], headMoved: false };
  const testCounts = testCountsFromGates(input);
  const base = (findings: AuditFinding[], diff: TaskDiff): AuditRunResult => {
    const sorted = sortFindings(findings);
    return {
      findings: sorted,
      blocked: sorted.some((f) => f.severity === 'block'),
      testCounts,
      changed: countChanged(diff),
      diff,
      newPendingWiring: [],
      resolvedPendingWiring: [],
    };
  };

  const opts = input.options ?? DEFAULT_AUDIT_OPTIONS;
  if (!opts.enabled) return base([], emptyDiff);

  if (isNotGitRepo(input.before, input.after)) {
    return base([{ check: 'audit', severity: 'info', message: 'audit skipped: not a git repository' }], emptyDiff);
  }

  let diff: TaskDiff;
  try {
    diff = await diffSnapshots(input.before, input.after, input.projectDir);
  } catch (e) {
    // Without a diff NOTHING below can run; passing the task here would mean
    // "unaudited = clean". Block, and let the retry take a fresh snapshot.
    return base(
      [{ check: 'audit', severity: 'block', message: `audit could not diff the tree (${(e as Error)?.message ?? e}) — retry the task; if it persists, check that git can read the working tree` }],
      emptyDiff
    );
  }

  const cls = input.classification;
  const findings: AuditFinding[] = [];
  let newPendingWiring: PendingWiring[] = [];
  let resolvedPendingWiring: PendingWiring[] = [];

  // A synthetic enhance / verify pass that changed nothing is a no-op by
  // definition: there is no artifact to wire, no test to count, no manifest
  // to demand. The finding list must be empty, not a pile of INFO/WARN noise.
  if (cls.kind === 'enhance' && diff.files.length === 0) return base([], diff);

  if (opts.orphanCheck) {
    const res = await guarded('orphan-code', async () => {
      const r = await checkOrphans(diff, input.projectDir, cls, input.pendingWiring ?? [], input.task.id);
      newPendingWiring = r.newPending;
      resolvedPendingWiring = r.resolvedPending;
      return r.findings;
    });
    findings.push(...res);
  }

  if (opts.unusedExportCheck) {
    const flaggedPaths = new Set(findings.filter((f) => f.check === 'orphan-code' && f.path).map((f) => f.path));
    const res = await guarded('unused-export', () => checkUnusedExports(diff, input.projectDir, cls));
    // A file the orphan check already flagged needs neither a second orphan-code
    // finding nor per-symbol unused-export noise: nothing imports the module at all.
    findings.push(...res.filter((f) => !(f.path && flaggedPaths.has(f.path) && (f.check === 'orphan-code' || f.check === 'unused-export'))));
  }

  if (opts.wiringManifest) {
    const res = await guarded('wiring-manifest', () => {
      const claims = parseWiringClaims(input.subagentStdout ?? '');
      return checkWiringClaims(claims, diff, input.projectDir, cls, input.subagentStdout ?? '');
    });
    findings.push(...res);
  }

  if (opts.testIntegrity) findings.push(...(await guarded('test-integrity', () => checkTestIntegrity(diff, cls))));
  if (opts.gateIntegrity) {
    const gateCommands = (input.gateResults ?? []).map((g) => g?.command).filter((c): c is string => typeof c === 'string');
    findings.push(...(await guarded('gate-integrity', () => checkGateIntegrity(diff, cls, gateCommands.length ? { gateCommands } : {}))));
  }
  if (opts.testCount) findings.push(...(await guarded('test-count', () => checkTestCount(testCounts, input.testBaseline, cls, diff, trivialTestBlocksAdded(diff)))));

  if (opts.tdd) {
    findings.push(...(await guarded('tdd-red', () => checkTddRed(input, diff, testCounts))));
    findings.push(...(await guarded('tdd-green', () => checkTddGreen(input, diff, testCounts))));
    findings.push(...(await guarded('test-count', () => checkTddEvidence(cls, input.subagentStdout ?? ''))));
  }

  if (opts.verifyEvidence !== false) findings.push(...(await guarded('verify-evidence', () => checkVerifyEvidence(input))));

  const result = base(findings, diff);
  result.newPendingWiring = newPendingWiring;
  result.resolvedPendingWiring = resolvedPendingWiring;
  return result;
}

const TAG: Record<AuditSeverity, string> = { block: '[BLOCK]', warn: '[WARN]', info: '[INFO]' };

/**
 * Markdown bullet list, BLOCK first, for injection into the next-pass prompt:
 *
 *   - [BLOCK] orphan-code src/components/Foo.tsx:1 — Foo is exported but never rendered ...
 */
export function renderFindings(findings: AuditFinding[]): string {
  if (!findings.length) return '';
  return sortFindings(findings)
    .map((f) => {
      const loc = f.path ? ` ${oneLine(f.path)}${f.line ? `:${f.line}` : ''}` : '';
      return `- ${TAG[f.severity]} ${f.check}${loc} — ${oneLine(f.message)}`;
    })
    .join('\n');
}

/** Paths and messages may carry subagent-controlled text: keep each bullet on one line, no control characters. */
function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return stripAnsi(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\r?\n|\t/g, ' ').replace(/ {2,}/g, ' ').trim();
}
