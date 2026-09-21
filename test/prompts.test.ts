import { describe, it, expect } from 'vitest';
import {
  buildSubagentPrompt,
  buildEnhanceSubagentPrompt,
  buildVerifySubagentPrompt,
  featureScopeLabel,
  parseSubagentVerdict,
  parseEnhanceResult,
  previousRollback,
  rollbackNoticeLines,
  OTHER_TASKS_CAP,
} from '../src/runner/claude.js';
import { buildPlannerPrompt } from '../src/planner.js';
import { RunConfig, type Task } from '../src/types.js';
import type { TaskClassification, RedTestRecord, PendingWiring } from '../src/audit/types.js';

function task(id: string, title: string, body = '', extra: Partial<Task> = {}): Task {
  return { id, title, body: body || title, dependencies: [], status: 'pending', attempts: [], kind: 'user', ...extra };
}

function cls(over: Partial<TaskClassification> = {}): TaskClassification {
  return {
    kind: 'impl',
    risk: 'medium',
    tdd: 'none',
    redTaskIds: [],
    greenTaskIds: [],
    allowsConfigChange: false,
    allowsTestEdits: false,
    rationale: ['kind=impl (default)'],
    ...over,
  };
}

const config = RunConfig.parse({ verifyMaxCycles: 3 });

/** Text of the `## <heading>…` section up to the next h2 (empty when absent). */
function sectionOf(prompt: string, heading: string): string {
  const start = prompt.indexOf(heading);
  if (start === -1) return '';
  const rest = prompt.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return heading + (next === -1 ? rest : rest.slice(0, next));
}

describe('buildSubagentPrompt — verification depth', () => {
  it('gates: says do NOT invoke /verify-loop and never mentions a depth invocation', () => {
    const p = buildSubagentPrompt(task('T1', 'x'), config, [], { classification: cls(), verifyDepth: 'gates' });
    expect(p).toContain('## Verification depth: gates');
    expect(p).toMatch(/do NOT invoke \/verify-loop/i);
    expect(p).not.toMatch(/\/verify-loop depth=/);
  });

  it('light: invokes /verify-loop depth=light with verifyMaxCycles', () => {
    const p = buildSubagentPrompt(task('T1', 'x'), config, [], { classification: cls(), verifyDepth: 'light' });
    expect(p).toContain('## Verification depth: light');
    expect(p).toContain('invoke `/verify-loop depth=light cycles=3`');
    expect(p).toContain('`verifyMaxCycles`');
  });

  it('full: invokes /verify-loop depth=full with verifyMaxCycles', () => {
    const p = buildSubagentPrompt(task('T1', 'x'), config, [], { classification: cls({ risk: 'high' }), verifyDepth: 'full' });
    expect(p).toContain('## Verification depth: full');
    expect(p).toContain('invoke `/verify-loop depth=full cycles=3`');
  });

  it('derives classification + depth itself when the orchestrator passes none', () => {
    const p = buildSubagentPrompt(task('T1', 'Update README with usage docs'), config);
    expect(p).toContain('## Verification depth: gates');
    expect(p).toContain('kind=docs');
  });

  it('honors useVerifyLoop:false as gates-only when depth is not supplied', () => {
    const p = buildSubagentPrompt(task('T1', 'Implement login'), RunConfig.parse({ useVerifyLoop: false }));
    expect(p).toContain('## Verification depth: gates');
  });
});

describe('buildSubagentPrompt — TDD protocol', () => {
  it('single-task impl: /tdd-loop, e2e for endpoints, evidence line', () => {
    const p = buildSubagentPrompt(task('T1', 'Implement pricing'), config, [], { classification: cls(), verifyDepth: 'light' });
    expect(p).toContain('## TDD protocol (single-task');
    expect(p).toContain('Use /tdd-loop');
    expect(p).toContain('confirm it FAILS');
    expect(p).toContain('end-to-end test that exercises the real entry point');
    expect(p).toContain('FULLAUTO_TDD: red=<n failing before impl> green=<n passing after impl>');
  });

  it('red task: tests only, must fail, no skip, evidence line', () => {
    const p = buildSubagentPrompt(task('T2', 'Failing tests for login'), config, [], {
      classification: cls({ kind: 'test', tdd: 'red', greenTaskIds: ['T3'] }),
      verifyDepth: 'gates',
    });
    expect(p).toContain('## TDD protocol (RED phase');
    expect(p).toContain('Write ONLY tests');
    expect(p).toContain("throw 'not implemented'");
    expect(p).toContain('Tests MUST fail at runtime');
    expect(p).toContain('Do NOT implement');
    expect(p).toContain('Do NOT skip/xfail/todo');
    expect(p).toContain('green task(s) T3 will implement');
    expect(p).toContain('FULLAUTO_TDD: red=<n failing> green=0');
  });

  it('green task: lists red files as the contract and the FULLAUTO_TEST_CHANGE escape hatch', () => {
    const redTests: RedTestRecord[] = [
      { taskId: 'T2', files: [{ path: 'tests/login.test.ts', hash: 'h', size: 1 }], failing: 2, recordedAt: 'now' },
      { taskId: 'T9', files: [{ path: 'tests/other.test.ts', hash: 'h', size: 1 }], failing: 1, recordedAt: 'now' },
    ];
    const p = buildSubagentPrompt(task('T3', 'Implement login'), config, [], {
      classification: cls({ tdd: 'green', redTaskIds: ['T2'], testsDelegatedTo: 'T2' }),
      verifyDepth: 'full',
      redTests,
    });
    expect(p).toContain('## TDD protocol (GREEN phase');
    expect(p).toContain('written by red task(s) T2, are the CONTRACT');
    expect(p).toContain('  - tests/login.test.ts (written by T2)');
    expect(p).not.toContain('tests/other.test.ts');
    expect(p).toContain('Do NOT edit them');
    expect(p).toContain('FULLAUTO_TEST_CHANGE: <file> — <reason>');
    expect(p).toContain('FULLAUTO_TDD: red=0 green=<n passing>');
  });

  it('green task without a record in state still names the red task', () => {
    const p = buildSubagentPrompt(task('T3', 'Implement login'), config, [], {
      classification: cls({ tdd: 'green', redTaskIds: ['T2'] }),
      verifyDepth: 'light',
    });
    expect(p).toContain('the test files written by T2');
  });

  it('delegated / no-test / test-only / config variants', () => {
    expect(
      buildSubagentPrompt(task('T3', 'x'), config, [], { classification: cls({ testsDelegatedTo: 'T2' }), verifyDepth: 'light' })
    ).toContain('Tests for this task live in T2');
    expect(
      buildSubagentPrompt(task('T3', 'x'), config, [], { classification: cls({ noTestReason: 'styling' }), verifyDepth: 'gates' })
    ).toContain('opted out of tests (`- no test: styling`)');
    expect(
      buildSubagentPrompt(task('T3', 'x'), config, [], { classification: cls({ kind: 'test' }), verifyDepth: 'gates' })
    ).toContain('NOT paired with a later implementation task');
    expect(
      buildSubagentPrompt(task('T3', 'x'), config, [], { classification: cls({ kind: 'config' }), verifyDepth: 'gates' })
    ).toContain('No TDD protocol applies (kind=config)');
  });
});

describe('buildSubagentPrompt — anti-cheat and wiring', () => {
  it('summarizes the machine-checked anti-cheat rules and points at /tdd-loop for the full list', () => {
    const p = buildSubagentPrompt(task('T1', 'x'), config, [], { classification: cls(), verifyDepth: 'gates' });
    expect(p).toContain('## Anti-cheat rules (machine-checked');
    for (const needle of [
      '.skip',
      '.only',
      '.todo',
      'xit',
      'weakening pre-existing tests',
      'package.json',
      '--passWithNoTests',
      'tautological or assertion-less tests',
      '@ts-ignore',
      'eslint-disable',
      'broad try-catch',
      '/tdd-loop §Anti-cheat',
    ]) {
      expect(p, needle).toContain(needle);
    }
    expect(p).toContain('the audit FAILS the task on any of these');
    expect(p).toContain('editing test / lint / typecheck config');
  });

  it('acknowledges touches-config / modifies-tests when the task allows them', () => {
    const p = buildSubagentPrompt(task('T1', 'x'), config, [], {
      classification: cls({ allowsConfigChange: true, allowsTestEdits: true }),
      verifyDepth: 'gates',
    });
    expect(p).toContain('(this task allows config edits)');
    expect(p).toContain('(this task allows editing pre-existing tests)');
  });

  it('wiring requirement with the FULLAUTO_WIRING block format (all three line forms)', () => {
    const p = buildSubagentPrompt(task('T1', 'x'), config, [], { classification: cls(), verifyDepth: 'gates' });
    expect(p).toContain('## Wiring requirement (machine-checked)');
    expect(p).toContain('imported, rendered, mounted or registered by PRODUCTION code in THIS task');
    expect(p).toContain('   FULLAUTO_WIRING:');
    expect(p).toContain('   - <new file>[#symbol] -> <consumer file>[:line]');
    expect(p).toContain('   - <new file> -> (wired by T###)');
    expect(p).toContain('   - <new file> -> (entrypoint:');
    expect(p).toContain('`fullauto audit` checks entrypoint claims against its pattern list');
  });

  it('fixed boilerplate stays compact (≤ 2.5k chars outside the task-specific sections)', () => {
    const p = buildSubagentPrompt(task('T1', 'x', 'y'), config, [], { classification: cls(), verifyDepth: 'gates' });
    // Everything that is the same for every task: rules, scope, anti-cheat,
    // wiring template, DEFER protocol. The depth / TDD sections vary by
    // classification and are excluded.
    const fixed = ['## Scope', '## Rules', '## Anti-cheat rules', '## Wiring requirement', '## DEFER protocol']
      .map((h) => sectionOf(p, h))
      .join('\n');
    expect(fixed.length).toBeLessThanOrEqual(2600);
  });

  it('wired-by task is told its artifacts may stay unreferenced; the wiring task is told what it owes', () => {
    const creator = buildSubagentPrompt(task('T4', 'Create LoginForm'), config, [], {
      classification: cls({ wiredBy: 'T5' }),
      verifyDepth: 'gates',
    });
    expect(creator).toContain('`- wired by: T5`');
    expect(creator).toContain('-> (wired by T5)');

    const pending: PendingWiring[] = [
      { artifactPath: 'src/components/LoginForm.tsx', createdBy: 'T4', wiredBy: 'T5' },
      { artifactPath: 'src/other.ts', createdBy: 'T1', wiredBy: 'T9' },
    ];
    const wirer = buildSubagentPrompt(task('T5', 'Render LoginForm'), config, [], {
      classification: cls(),
      verifyDepth: 'gates',
      pendingWiring: pending,
    });
    expect(wirer).toContain('### Artifacts from earlier tasks that THIS task must wire');
    expect(wirer).toContain('  - src/components/LoginForm.tsx (created by T4)');
    expect(wirer).not.toContain('src/other.ts');
  });
});

describe('buildSubagentPrompt — existing sections are kept', () => {
  it('keeps the placeholder-env and prior-attempt blocks and the DEFER protocol', () => {
    const t = task('T1', 'Implement billing', '', {
      attempts: [
        {
          passNumber: 1,
          startedAt: 'now',
          finishedAt: 'now',
          gateResults: [],
          deferReason: 'audit_failed',
          deferDetail: 'Post-task audit BLOCKED this attempt (1 BLOCK / 0 WARN). Findings, BLOCK first:\n- [BLOCK] orphan-code src/x.ts — nothing imports it',
        },
      ],
    });
    const p = buildSubagentPrompt(t, config, ['STRIPE_SECRET_KEY'], { classification: cls(), verifyDepth: 'light' });
    expect(p).toContain('## Placeholder credentials (auto mode)');
    expect(p).toContain('STRIPE_SECRET_KEY=FULLAUTO_PLACEHOLDER_STRIPE_SECRET_KEY');
    expect(p).toContain('## Prior attempt context (this task was deferred in pass 1)');
    expect(p).toContain('orphan-code src/x.ts');
    expect(p).toContain('## DEFER protocol');
    expect(p).toContain('FULLAUTO_RESULT: DEFER <one-line cause> | unmet: <requirement bullet or file:line>');
    expect(p).toContain('### Classification');
  });

  it('placeholder block: fake/adapter first, DEFER only when the live call is the deliverable, no bypass branch', () => {
    const p = buildSubagentPrompt(task('T1', 'Charge a card'), config, ['STRIPE_SECRET_KEY'], { classification: cls(), verifyDepth: 'gates' });
    expect(p).toContain('wire the call through a fake / adapter / fixture');
    expect(p).toContain('DEFER only when the task body says the live call itself is the deliverable');
    expect(p).not.toContain('starts with FULLAUTO_PLACEHOLDER_, skip');
  });

  it('rules: single test instruction, prerequisite triage with ASSUMED:, expected gate outcome, fullauto audit pre-check, scope line', () => {
    const p = buildSubagentPrompt(task('T1', 'x'), config, [], { classification: cls(), verifyDepth: 'gates' });
    expect(p).toContain('## Scope');
    expect(p).toContain('Read anything. Write only: the files this task names, the production files that must import / render / register them, and tests.');
    expect(p).not.toContain('Do not read or modify files unrelated');
    expect(p).toContain('The "TDD protocol" section below is the ONLY test instruction');
    expect(p).not.toContain('Tests are part of your task scope');
    expect(p).toContain('emit the DEFER marker with `unmet: <what>`');
    expect(p).toContain('`ASSUMED: <what you built and why>`');
    expect(p).toContain("a red task's test gate is expected to FAIL");
    expect(p).toContain('run `fullauto audit` before finishing and fix every BLOCK on files you touched');
    // The DEFER format is defined exactly once and referenced from the verify section.
    expect(p.split('FULLAUTO_RESULT: DEFER <one-line cause>').length - 1).toBe(1);
    const light = buildSubagentPrompt(task('T1', 'x'), config, [], { classification: cls(), verifyDepth: 'light' });
    expect(sectionOf(light, '## Verification depth')).toContain('the DEFER protocol below');
  });

  it('single-task TDD: e2e unless another task covers it', () => {
    const p = buildSubagentPrompt(task('T1', 'Implement pricing'), config, [], { classification: cls(), verifyDepth: 'gates' });
    expect(p).toContain('unless the task body says e2e is covered by another task (`covered by T###` / `e2e: T###`)');
  });

  it('lists the other unfinished tasks (titles only, capped) so the implementer can triage a missing prerequisite', () => {
    const others = Array.from({ length: OTHER_TASKS_CAP * 2 }, (_, i) => ({
      id: `T${String(i + 2).padStart(3, '0')}`,
      title: `Sibling ${i + 2}`,
      status: (i % 3 === 0 ? 'done' : i % 3 === 1 ? 'pending' : 'deferred') as Task['status'],
    }));
    const p = buildSubagentPrompt(task('T001', 'x'), config, [], { classification: cls(), verifyDepth: 'gates', otherTasks: [{ id: 'T001', title: 'x', status: 'in_progress' }, ...others] });
    const section = sectionOf(p, '## Other tasks in this run');
    expect(section).toContain('not yours to implement');
    expect(section).toContain('  - T003 [pending] Sibling 3');
    expect(section).toContain('  - T004 [deferred] Sibling 4');
    expect(section).not.toMatch(/T002 \[/); // done → omitted
    expect(section).not.toContain('T001 [in_progress]'); // self → omitted
    const unfinished = others.filter((o) => o.status !== 'done').length;
    expect(section.split('\n').filter((l) => l.startsWith('  - T')).length).toBe(Math.min(OTHER_TASKS_CAP, unfinished));
    expect(section).toContain(`…and ${unfinished - OTHER_TASKS_CAP} more`);
    // No list at all when nothing is unfinished.
    expect(buildSubagentPrompt(task('T001', 'x'), config, [], { classification: cls(), verifyDepth: 'gates', otherTasks: [] })).not.toContain('## Other tasks in this run');
  });

  it('picks the previous FINISHED attempt when a fresh in-flight attempt was already pushed', () => {
    // Mirrors processOneTask: the new attempt is pushed BEFORE the prompt is
    // built, so "last element" is empty; the block must come from the
    // finished, deferred attempt before it.
    const t = task('T1', 'Implement billing', '', {
      attempts: [
        {
          passNumber: 1,
          startedAt: 'a',
          finishedAt: 'b',
          gateResults: [],
          deferReason: 'gate_failed',
          deferDetail: 'Gate "test" failed (exit 1). Captured output below\n\n```\nboom-output\n```',
        },
        { passNumber: 2, startedAt: 'c', gateResults: [] }, // in-flight, no deferDetail
      ],
    });
    const p = buildSubagentPrompt(t, config, [], { classification: cls(), verifyDepth: 'gates' });
    expect(p).toContain('## Prior attempt context (this task was deferred in pass 1)');
    expect(p).toContain('boom-output');
    expect(p).toContain('Gate "test" failed (exit 1)');
  });

  it('renders audit findings of the previous attempt when they are not already in deferDetail', () => {
    const t = task('T1', 'Failing tests for login', '', {
      attempts: [
        {
          passNumber: 1,
          startedAt: 'a',
          finishedAt: 'b',
          gateResults: [],
          deferReason: 'tdd_red_expected',
          deferDetail: 'This is a TDD red task but the test gate PASSED',
          audit: {
            findings: [{ check: 'unused-export', severity: 'warn', message: 'helper `foo` is never imported', path: 'src/foo.ts' }],
            blocked: false,
            changed: { added: 1, modified: 0, deleted: 0 },
          },
        },
        { passNumber: 2, startedAt: 'c', gateResults: [] },
      ],
    });
    const p = buildSubagentPrompt(t, config, [], { classification: cls({ kind: 'test', tdd: 'red' }), verifyDepth: 'gates' });
    expect(p).toContain('Audit findings from that attempt:');
    expect(p).toContain('unused-export');
    expect(p).toContain('src/foo.ts');
  });

  it('renders no prior-attempt block on a first attempt', () => {
    const t = task('T1', 'x', '', { attempts: [{ passNumber: 1, startedAt: 'a', gateResults: [] }] });
    expect(buildSubagentPrompt(t, config, [], { classification: cls(), verifyDepth: 'gates' })).not.toContain('## Prior attempt context');
  });

  it('parseSubagentVerdict still reads the last DEFER marker', () => {
    expect(parseSubagentVerdict('FULLAUTO_RESULT: DEFER a\nFULLAUTO_RESULT: DEFER b')).toEqual({
      kind: 'defer',
      deferReason: 'b',
    });
    expect(parseSubagentVerdict('FULLAUTO_TDD: red=2 green=0').kind).toBe('no_defer');
  });
});

describe('enhance / verify prompts', () => {
  it('enhance prompt threads the depth into /verify-loop and carries anti-cheat + wiring', () => {
    const t = task('ENHANCE-all', 'vibe-enhance pass', '- T1: x', { kind: 'enhance' });
    const p = buildEnhanceSubagentPrompt(t, config, { classification: cls({ kind: 'enhance' }), verifyDepth: 'light' });
    expect(p).toContain('# vibe-enhance pass');
    expect(p).toContain('pass `depth=light cycles=3`');
    expect(p).toContain('## Anti-cheat rules');
    expect(p).toContain('FULLAUTO_WIRING:');
    expect(p).toContain('## DEFER protocol');
    const g = buildEnhanceSubagentPrompt(t, config, { classification: cls({ kind: 'enhance' }), verifyDepth: 'gates' });
    expect(g).toContain('skip that step');
  });

  it('enhance prompt passes the remaining budget, the FULLAUTO_ENHANCE line, and the product brief when present', () => {
    const t = task('ENHANCE-all', 'vibe-enhance pass', '- T1: x', { kind: 'enhance' });
    const p = buildEnhanceSubagentPrompt(t, config, { classification: cls({ kind: 'enhance' }), verifyDepth: 'light', enhanceBudgetRemaining: 2 });
    expect(p).toContain('invoke it with `budget=2`');
    expect(p).toContain('the run-level default is 3');
    expect(p).not.toContain('FIT-BREAK');
    expect(p).toContain('FULLAUTO_ENHANCE: applied=<n> optional=<n> promote=<F ids|none>');
    expect(p).not.toContain('## Product brief:');
    const zero = buildEnhanceSubagentPrompt(t, config, { classification: cls({ kind: 'enhance' }), verifyDepth: 'light', enhanceBudgetRemaining: 0 });
    expect(zero).toContain('`budget=0` — apply NOTHING');
    const withBrief = buildEnhanceSubagentPrompt(t, config, { classification: cls({ kind: 'enhance' }), verifyDepth: 'light', productBriefPath: '/p/.fullauto/product.md' });
    expect(withBrief).toContain('## Product brief: /p/.fullauto/product.md');
    expect(withBrief).toContain('Read it FIRST');
    expect(withBrief).toContain('list it under `promote=` in the FULLAUTO_ENHANCE line');
    expect(withBrief).not.toContain('enhance-log');
    expect(withBrief).not.toContain('S-sized');
  });

  it('parseEnhanceResult reads the last FULLAUTO_ENHANCE line', () => {
    expect(parseEnhanceResult('nothing here')).toBeUndefined();
    expect(parseEnhanceResult('FULLAUTO_ENHANCE: applied=1 optional=2 promote=none')).toEqual({ applied: 1, optional: 2, promote: [] });
    expect(parseEnhanceResult('FULLAUTO_ENHANCE: applied=0 optional=0 promote=F003\n  FULLAUTO_ENHANCE: applied=2 optional=1 promote=F004,f010,bogus')).toEqual({
      applied: 2,
      optional: 1,
      promote: ['F004', 'F010'],
    });
  });

  it('verify prompt runs one full /verify-loop over the combined diff', () => {
    const t = task('VERIFY-auth', 'feature verification', '- T1: login\n- T2: logout', { kind: 'verify', feature: 'Auth' });
    const p = buildVerifySubagentPrompt(t, config, { classification: cls({ kind: 'enhance' }) });
    expect(p).toContain('# Feature verification pass');
    expect(p).toContain('feature group "Auth"');
    expect(p).toContain('Run /verify-loop depth=full cycles=3 over the combined diff of these tasks');
    expect(p).toContain('- T1: login');
    expect(p).toContain('FULLAUTO_RESULT: DEFER');
  });
});

describe('synthetic prompts — implicit group label and rollback notice', () => {
  it('names the implicit group after the file\'s structure: cross-cutting tasks in a grouped ([USx] / h2) run, the whole run otherwise', () => {
    const t = task('ENHANCE-all', 'vibe-enhance pass', '- T1: x', { kind: 'enhance' });
    expect(featureScopeLabel(t, {})).toBe('the entire run (no feature headings present)');
    expect(featureScopeLabel(t, { groupedRun: true })).toBe('the cross-cutting tasks that carry no feature label (Setup / Foundational / Polish)');
    expect(featureScopeLabel(task('ENHANCE-us1', 'x', '', { kind: 'enhance', feature: 'US1' }), { groupedRun: true })).toBe('feature group "US1"');
    const grouped = buildEnhanceSubagentPrompt(t, config, { classification: cls({ kind: 'enhance' }), groupedRun: true });
    expect(grouped).toContain('Just-completed: the cross-cutting tasks that carry no feature label (Setup / Foundational / Polish).');
    expect(grouped).not.toContain('no feature headings present');
    const verify = buildVerifySubagentPrompt(task('VERIFY-all', 'x', '- T1: x', { kind: 'verify' }), config, { groupedRun: true });
    expect(verify).toContain('Just-completed: the cross-cutting tasks that carry no feature label (Setup / Foundational / Polish).');
  });

  it('a rolled-back previous attempt adds the patch pointer to the prior-attempt block (implementer, enhance and verify prompts)', () => {
    const attempts: Task['attempts'] = [
      {
        passNumber: 1,
        startedAt: 't',
        finishedAt: 't',
        gateResults: [],
        deferReason: 'gate_failed',
        deferDetail: 'Gate "test" failed (exit 1).',
        rollback: { patchPath: '/p/.fullauto/logs/T001-attempt1.patch', files: 3, restored: 1, deleted: 2 },
      },
      // Synthetic promotion: no rollback of its own, must not hide the earlier one.
      { passNumber: 2, startedAt: 't', finishedAt: 't', gateResults: [], deferReason: 'gate_failed', deferDetail: 'Promoted to failed after orchestrator exit: Gate "test" failed (exit 1).' },
      { passNumber: 3, startedAt: 't', gateResults: [] },
    ];
    const t = task('T001', 'Add helper', 'Add helper', { attempts });
    expect(previousRollback(t)?.patchPath).toBe('/p/.fullauto/logs/T001-attempt1.patch');
    const lines = rollbackNoticeLines(t).join('\n');
    expect(lines).toContain("Your previous attempt's changes were rolled back (3 file(s): 1 restored, 2 removed); the diff is saved at /p/.fullauto/logs/T001-attempt1.patch");
    expect(lines).toContain('`git apply /p/.fullauto/logs/T001-attempt1.patch`');
    expect(lines).toContain('add `--3way` if it does not apply cleanly');

    const impl = buildSubagentPrompt(t, config);
    const block = sectionOf(impl, '## Prior attempt context');
    expect(block).toContain('Gate "test" failed (exit 1).');
    expect(block).toContain("Your previous attempt's changes were rolled back");
    expect(block).toContain('Treat this as a HINT, not a verdict.');

    const enhance = buildEnhanceSubagentPrompt(task('ENHANCE-all', 'vibe-enhance pass', '- T1: x', { kind: 'enhance', attempts }), config, { classification: cls({ kind: 'enhance' }) });
    expect(enhance).toContain('## Prior attempt context (this task was deferred in pass 2)');
    expect(enhance).toContain("Your previous attempt's changes were rolled back");
    const verify = buildVerifySubagentPrompt(task('VERIFY-all', 'x', '- T1: x', { kind: 'verify', attempts }), config);
    expect(verify).toContain("Your previous attempt's changes were rolled back");

    // No rollback record → no notice, no dangling sentence.
    const clean = task('T002', 'Add helper', 'Add helper', { attempts: [attempts[1], attempts[2]] });
    expect(rollbackNoticeLines(clean)).toEqual([]);
    expect(buildSubagentPrompt(clean, config)).not.toContain('rolled back');
    // A rollback that changed nothing is not worth a notice either.
    const empty = task('T003', 'x', 'x', { attempts: [{ ...attempts[0], rollback: { files: 0, restored: 0, deleted: 0 } }] });
    expect(rollbackNoticeLines(empty)).toEqual([]);
  });
});

describe('buildPlannerPrompt', () => {
  const p = buildPlannerPrompt('build login', '/tmp/tasks.md');

  it('requires TDD red/green pairing and e2e for entry points', () => {
    expect(p).toContain('## Test coverage — TDD pairing (REQUIRED)');
    expect(p).not.toContain('TDD-style is preferred');
    expect(p).toContain('emit a RED/GREEN pair');
    expect(p).toContain('`- tdd: red`');
    expect(p).toContain('`- tests: T-test`');
    expect(p).toContain('exercises the REAL entry point');
  });

  it('documents wiring, risk and every marker', () => {
    expect(p).toContain('## Wiring (REQUIRED)');
    expect(p).toContain('`- wired by: T###`');
    expect(p).toContain('`- risk: high`');
    for (const marker of [
      '- kind: test|impl|config|docs',
      '- risk: low|medium|high',
      '- tdd: red|green|none',
      '- level: unit|integration|e2e',
      '- tests: T###',
      '- no test: <reason>',
      '- touches-config: <reason>',
      '- modifies-tests: <reason>',
      '- wired by: T###',
    ]) {
      expect(p, marker).toContain(marker);
    }
  });

  it('example shows a config task and a red/green pair with the markers in use', () => {
    expect(p).toMatch(/- \[ \] T001 Set up vitest[^\n]*\n\s+- kind: config\n\s+- touches-config: adds test runner/);
    expect(p).toMatch(/- \[ \] T002 Write failing integration test[^\n]*\n\s+- tdd: red\n\s+- level: integration\n\s+- wired by: T003/);
    expect(p).toMatch(/- \[ \] T003 Implement POST \/login[^\n]*\(depends on T002\)\n\s+- tests: T002/);
    expect(p).toMatch(/- wired by: T005/);
  });

  it('red test tasks must name the task that wires their stub', () => {
    expect(p).toContain('The red task MUST carry `- wired by: T###`');
    expect(p).not.toContain('no `- wired by:` marker is needed');
  });

  it('without a product brief there is no product context and the first line must be a task', () => {
    expect(p).not.toContain('## Product context');
    expect(p).toContain('the first line to start with `- [ ]`');
  });

  it('with a product brief: inlines the context and the consistency rules; with a round: selection rules, cap and header', () => {
    const plain = buildPlannerPrompt('build login', '/tmp/tasks.md', { context: '# Product: Notes\n## Backlog\n- [P1] F001 Create note', productPath: '/p/.fullauto/product.md' });
    expect(plain).toContain('## Product context');
    expect(plain).toContain('product brief at /p/.fullauto/product.md');
    expect(plain).toContain('- [P1] F001 Create note');
    expect(plain).toContain('non-goals are off-limits');
    expect(plain).toContain('## Feature: <F00x> <feature title>');
    expect(plain).not.toContain('selection rules');
    expect(plain).toContain('Aim for 3–20 tasks total');

    const round = buildPlannerPrompt('round 2', '/tmp/tasks.md', { context: 'ctx', productPath: '/p/.fullauto/product.md', round: 2, maxTasks: 8 });
    expect(round).toContain('### Round 2 selection rules (evolve mode)');
    expect(round).toContain('At most 8 tasks in total for this round');
    expect(round).not.toContain('Aim for 3–20 tasks total');
    expect(round).toContain('<!-- fullauto:round=2 items=F001,F004 -->');
    expect(round).toContain('FULLY usable when its tasks finish');
    expect(round).toContain('never a slice of one');
    expect(round).toContain('Skip items whose Feature map status is `done` or `rejected`');
    expect(round).toContain('The first line of the file must be the round header');
  });

  it('keeps the manual prerequisites / assumptions / output protocol sections', () => {
    expect(p).toContain('## Manual prerequisites section (REQUIRED)');
    expect(p).toContain('<!-- fullauto:prerequisites -->');
    expect(p).toContain('## Assumptions section');
    expect(p).toContain('## Output protocol');
  });
});
