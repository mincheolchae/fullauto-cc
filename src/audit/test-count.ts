/**
 * Test-count check: the deterministic backstop for single-task TDD.
 *
 *  - counts not parsed        → INFO (nothing to compare)
 *  - passed < baseline.passed → BLOCK "test count decreased" (unless the task may edit tests)
 *  - behavior task (impl, tdd=none, no delegation, no `no test`) must ADD tests
 *    → passed must exceed baseline.passed, else BLOCK — but only when the task
 *      actually added/changed production code (the diff is known); a behavior
 *      task whose diff touched no code has nothing new to test → WARN.
 *      Existence-only test blocks (`expect(fn).toBeDefined()` and friends, see
 *      `countTrivialTestBlocks`) do not count: passed − baseline must exceed
 *      the number of trivial blocks the task added.
 *  - skipped increased        → WARN
 */
import type { AuditFinding, TaskClassification, TaskDiff, TestCounts } from './types.js';

export function isBehaviorTask(cls: TaskClassification): boolean {
  return cls.kind === 'impl' && cls.tdd === 'none' && !cls.testsDelegatedTo && !cls.noTestReason;
}

/** Did the task add or modify a non-test code file (the only thing that can introduce behavior)? */
function touchedProductionCode(diff: TaskDiff | undefined): boolean | undefined {
  if (!diff) return undefined;
  return diff.files.some((f) => f.isCode && !f.isTest && f.kind !== 'deleted');
}

export function checkTestCount(
  counts: TestCounts | undefined,
  baseline: TestCounts | undefined,
  cls: TaskClassification,
  diff?: TaskDiff,
  trivialBlocksAdded = 0
): AuditFinding[] {
  const findings: AuditFinding[] = [];

  if (!counts) {
    findings.push({ check: 'test-count', severity: 'info', message: 'test output not parsed (no test gate output available); test-count check skipped' });
    return findings;
  }
  if (counts.runner === 'unknown') {
    findings.push({ check: 'test-count', severity: 'info', message: 'test runner output not recognized (vitest/jest/mocha/node:test/pytest/go/cargo); test-count check skipped' });
    return findings;
  }

  const total = counts.passed + counts.failed + counts.skipped;

  if (!baseline || baseline.runner === 'unknown') {
    findings.push({
      check: 'test-count',
      severity: 'info',
      message: `no test baseline yet; recorded ${counts.runner}: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`,
    });
    if (isBehaviorTask(cls) && total === 0) {
      findings.push({
        check: 'test-count',
        severity: 'warn',
        message: 'test gate ran zero tests for a behavior task — add a test that exercises the new behavior',
      });
    }
    return findings;
  }

  if (counts.passed < baseline.passed && !cls.allowsTestEdits) {
    findings.push({
      check: 'test-count',
      severity: 'block',
      message: `test count decreased: ${baseline.passed} → ${counts.passed} passing (${counts.runner}) — tests were removed, skipped, or broken; restore them (only \`- modifies-tests: <reason>\` tasks may reduce the count)`,
    });
  } else if (counts.passed < baseline.passed) {
    findings.push({
      check: 'test-count',
      severity: 'info',
      message: `test count decreased ${baseline.passed} → ${counts.passed} (allowed by modifies-tests)`,
    });
  }

  const trivial = Math.max(0, trivialBlocksAdded);
  const realNew = counts.passed - baseline.passed - trivial;
  if (isBehaviorTask(cls) && realNew <= 0) {
    // Without a diff (legacy callers) the count alone decides; with one, only a
    // task that changed production code can be missing tests for new behavior.
    const touched = touchedProductionCode(diff);
    const block = touched !== false;
    const onlyTrivial = counts.passed > baseline.passed;
    findings.push({
      check: 'test-count',
      severity: block ? 'block' : 'warn',
      message: onlyTrivial
        ? `no new tests for behavior task: ${counts.passed - baseline.passed} new passing test(s) (${counts.runner}) but ${trivial} added block(s) are existence-only (toBeDefined / toBeTruthy / typeof checks) and do not count — add a test that calls the new behavior and asserts on its result`
        : block
          ? `no new tests for behavior task: ${counts.passed} passing before and after (${counts.runner}) — add a unit/integration test that exercises the behavior this task implements (or mark the task \`- no test: <reason>\` / \`- tests: T###\`)`
          : `no new tests for behavior task (${counts.passed} passing before and after, ${counts.runner}) — the task changed no production code, so nothing new needs coverage; mark it \`- no test: <reason>\` or \`- kind: docs|config\` if that is expected`,
    });
  }

  if (counts.skipped > baseline.skipped) {
    findings.push({
      check: 'test-count',
      severity: 'warn',
      message: `skipped tests increased ${baseline.skipped} → ${counts.skipped} (${counts.runner}) — check for new .skip/.todo/xfail markers`,
    });
  }

  return findings;
}
