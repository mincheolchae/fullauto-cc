import { describe, it, expect } from 'vitest';
import {
  classifyTask,
  depthFor,
  effectiveVerifyMode,
  parseTaskMarkers,
  canonicalTaskId,
  describeClassification,
} from '../src/task-class.js';
import { RunConfig, type Task } from '../src/types.js';

function task(id: string, title: string, body = '', extra: Partial<Task> = {}): Task {
  return {
    id,
    title,
    // Mirror the parser: an empty body is stored as the title.
    body: body || title,
    dependencies: [],
    status: 'pending',
    attempts: [],
    kind: 'user',
    ...extra,
  };
}

describe('parseTaskMarkers', () => {
  it('parses every marker kind, case-insensitively, at any indentation', () => {
    const m = parseTaskMarkers(
      [
        '  - Kind: Test',
        '  - risk: HIGH',
        '  - TDD: red',
        '  - tests: T3, T004',
        '  - no test: presentational only',
        '  - touches-config: adds vitest',
        '  - modifies-tests: signature change',
        '  - wired by: t7',
        '  - level: Integration',
        '  - note: this is free text, not a marker',
      ].join('\n')
    );
    expect(m.kind).toBe('test');
    expect(m.risk).toBe('high');
    expect(m.tdd).toBe('red');
    expect(m.tests).toEqual(['T003', 'T004']);
    expect(m.noTestReason).toBe('presentational only');
    expect(m.touchesConfig).toBe('adds vitest');
    expect(m.modifiesTests).toBe('signature change');
    expect(m.wiredBy).toBe('T007');
    expect(m.level).toBe('integration');
    expect(m.ignored).toEqual([]);
  });

  it('records unrecognized marker values instead of guessing', () => {
    const m = parseTaskMarkers('- kind: feature\n- risk: scary\n- tests: none');
    expect(m.kind).toBeUndefined();
    expect(m.risk).toBeUndefined();
    expect(m.ignored).toEqual(['kind: feature', 'risk: scary', 'tests: none']);
  });

  it('canonicalizes ids the same way the parser does', () => {
    expect(canonicalTaskId('T1')).toBe('T001');
    expect(canonicalTaskId('12')).toBe('T012');
    expect(canonicalTaskId('T1000')).toBe('T1000');
    expect(canonicalTaskId('step3')).toBeUndefined();
  });
});

describe('classifyTask — kind', () => {
  it('markers win over heuristics', () => {
    const t = task('T001', 'Write unit tests for pricing', '- kind: impl');
    const cls = classifyTask(t, [t]);
    expect(cls.kind).toBe('impl');
    expect(cls.rationale).toContain('kind=impl (marker)');
  });

  it('detects test tasks from the title', () => {
    for (const title of [
      'Contract test for POST /login in tests/contract/login.test.ts',
      'Write integration tests for the checkout service',
      'Add spec for parser edge cases',
      'Cover pricing.spec.ts edge cases',
    ]) {
      const t = task('T001', title);
      const cls = classifyTask(t, [t]);
      expect(cls.kind, title).toBe('test');
      expect(cls.rationale.some((r) => r.startsWith('kind=test (heuristic'))).toBe(true);
    }
  });

  it('"set up the test runner" is config, not test', () => {
    const t = task('T001', 'Set up vitest test runner');
    const cls = classifyTask(t, [t]);
    expect(cls.kind).toBe('config');
    expect(cls.risk).toBe('low');
  });

  it('"implement X with tests" is an impl task carrying its own tests', () => {
    const t = task('T001', 'Implement POST /users handler with tests');
    expect(classifyTask(t, [t]).kind).toBe('impl');
  });

  it('a paired-test sentence naming the test file by path stays impl (regression: real smoke test)', () => {
    // Exactly the phrasing this project's own test-pairing policy teaches
    // authors to write — the production deliverable ("a pure function") and
    // its paired test file are named in the same sentence. Caught live
    // while smoke-testing against a real Claude subagent, not invented.
    const t = task(
      'T003',
      "Add a pure function `sum(a, b)` in `src/mathutils.mjs` that returns `a + b`, export it, import and call it once from `src/index.mjs`, and add a unit test in `test/mathutils.test.mjs` covering at least one positive-number case and one negative-number case."
    );
    const cls = classifyTask(t, [t]);
    expect(cls.kind).toBe('impl');
  });

  it('a genuinely test-only task is not swept up by the wider addon pattern', () => {
    // TESTS_AS_ADDON_RE only recognizes a fixed level-word list
    // (unit/integration/e2e/end-to-end/contract) between the article and
    // "test(s)" — "regression test" doesn't fit that shape, so this stays
    // classified as a test task rather than being suppressed to impl.
    const t = task('T001', 'Cover the pricing edge cases and add a regression test in test/pricing.spec.ts');
    expect(classifyTask(t, [t]).kind).toBe('test');
  });

  it('a `- tests:` delegation makes a test-mentioning task impl', () => {
    const red = task('T001', 'Contract tests for login');
    const t = task('T002', 'Implement login endpoint', '- acceptance: contract tests in T001 pass\n- tests: T001');
    const cls = classifyTask(t, [red, t]);
    expect(cls.kind).toBe('impl');
    expect(cls.testsDelegatedTo).toBe('T001');
  });

  it('a verb-led title ignores "test" mentions in the body', () => {
    const t = task('T002', 'Implement login endpoint', '- must keep existing tests passing');
    expect(classifyTask(t, [t]).kind).toBe('impl');
  });

  it('a verb-less title lets the body decide', () => {
    const t = task('T002', 'Login endpoint', '- write a contract test hitting POST /login and assert 200');
    expect(classifyTask(t, [t]).kind).toBe('test');
  });

  it('detects config and docs tasks', () => {
    expect(classifyTask(task('T1', 'Add dependency zod to package.json'), []).kind).toBe('config');
    expect(classifyTask(task('T1', 'Configure eslint and tsconfig paths'), []).kind).toBe('config');
    expect(classifyTask(task('T1', 'Update README with usage docs'), []).kind).toBe('docs');
    // "docs" + a code-y noun is an impl task (JSDoc on a function), not docs.
    expect(classifyTask(task('T1', 'Add JSDoc comments to the pricing function'), []).kind).toBe('impl');
  });

  it('enhance and verify synthetic tasks classify as enhance', () => {
    expect(classifyTask(task('ENHANCE-all', 'vibe-enhance pass', '', { kind: 'enhance' }), []).kind).toBe('enhance');
    expect(classifyTask(task('VERIFY-all', 'feature verification', '', { kind: 'verify' }), []).kind).toBe('enhance');
  });
});

describe('classifyTask — risk', () => {
  it('marker wins', () => {
    const t = task('T1', 'Implement login', '- risk: low');
    expect(classifyTask(t, [t]).risk).toBe('low');
  });

  it('high-risk keywords in title or body → high, with the matched word in rationale', () => {
    const t = task('T1', 'Implement session refresh', '- rotates the jwt on every request');
    const cls = classifyTask(t, [t]);
    expect(cls.risk).toBe('high');
    expect(cls.rationale.some((r) => /risk=high \(heuristic: matched "(session|jwt)"\)/.test(r))).toBe(true);
  });

  it('config/docs default to low, typo/rename titles are low, everything else medium', () => {
    expect(classifyTask(task('T1', 'Install prettier'), []).risk).toBe('low');
    expect(classifyTask(task('T1', 'Fix typo in error message'), []).risk).toBe('low');
    expect(classifyTask(task('T1', 'Implement pricing calculator'), []).risk).toBe('medium');
  });

  it('marker lines never feed the risk heuristic', () => {
    // `- risk: ...` is stripped before matching; "role" would otherwise be
    // a high-risk hit here.
    const t = task('T1', 'Implement pricing calculator', '- level: unit');
    expect(classifyTask(t, [t]).risk).toBe('medium');
  });
});

describe('classifyTask — TDD pairing', () => {
  it('impl task with `- tests: T###` is green for that red test task; the test task is red', () => {
    const red = task('T001', 'Write failing integration test for POST /login', '- tdd: red\n- level: integration');
    const green = task('T002', 'Implement POST /login handler', '- tests: T001', { dependencies: ['T001'] });
    const all = [red, green];
    const r = classifyTask(red, all);
    const g = classifyTask(green, all);
    expect(r.kind).toBe('test');
    expect(r.tdd).toBe('red');
    expect(r.greenTaskIds).toEqual(['T002']);
    expect(g.kind).toBe('impl');
    expect(g.tdd).toBe('green');
    expect(g.redTaskIds).toEqual(['T001']);
    expect(g.testsDelegatedTo).toBe('T001');
    expect(g.rationale).toContain('tdd=green (tests delegated to red task T001)');
  });

  it('pairing is inferred from `(depends on T-test)` without any markers', () => {
    const red = task('T001', 'Contract test for GET /users');
    const green = task('T002', 'Implement GET /users endpoint', '', { dependencies: ['T001'] });
    const all = [red, green];
    expect(classifyTask(red, all).tdd).toBe('red');
    expect(classifyTask(green, all).tdd).toBe('green');
    expect(classifyTask(green, all).redTaskIds).toEqual(['T001']);
  });

  it('a test task is red only when paired', () => {
    const lone = task('T001', 'Add regression tests for the date parser');
    const cls = classifyTask(lone, [lone]);
    expect(cls.tdd).toBe('none');
    expect(cls.rationale).toContain('tdd=none (test task not paired with an impl task)');
  });

  it('a test task depended on by another TEST task is not red', () => {
    const t1 = task('T001', 'Unit tests for parser');
    const t2 = task('T002', 'Integration tests for parser', '', { dependencies: ['T001'] });
    expect(classifyTask(t1, [t1, t2]).tdd).toBe('none');
  });

  it('`- tdd: red` marker makes an unpaired test task red', () => {
    const t = task('T001', 'Write failing tests for pricing', '- tdd: red');
    expect(classifyTask(t, [t]).tdd).toBe('red');
    expect(classifyTask(t, [t]).greenTaskIds).toEqual([]);
  });

  it('`- tdd: none` on a test task cancels pairing for its impl task too', () => {
    const red = task('T001', 'Tests for pricing', '- tdd: none');
    const impl = task('T002', 'Implement pricing', '- tests: T001', { dependencies: ['T001'] });
    expect(classifyTask(red, [red, impl]).tdd).toBe('none');
    const g = classifyTask(impl, [red, impl]);
    expect(g.tdd).toBe('none');
    expect(g.redTaskIds).toEqual([]);
  });

  it('impl task with no pairing is single-task TDD (none) and depends on impl deps stay none', () => {
    const a = task('T001', 'Implement pricing');
    const b = task('T002', 'Implement checkout', '', { dependencies: ['T001'] });
    expect(classifyTask(b, [a, b]).tdd).toBe('none');
    expect(classifyTask(b, [a, b]).rationale).toContain('tdd=none (single-task TDD, prompt-enforced)');
  });

  it('config/docs tasks are never red or green', () => {
    const red = task('T001', 'Contract test for X');
    const cfg = task('T002', 'Set up CI workflow', '', { dependencies: ['T001'] });
    expect(classifyTask(cfg, [red, cfg]).tdd).toBe('none');
    // and because T002 is config, T001 is NOT red (no impl task depends on it)
    expect(classifyTask(red, [red, cfg]).tdd).toBe('none');
  });

  it('collects allowsConfigChange / allowsTestEdits / wiredBy / noTestReason', () => {
    const t = task(
      'T004',
      'Create LoginForm component',
      '- wired by: T005\n- no test: presentational\n- touches-config: adds storybook\n- modifies-tests: updates snapshot'
    );
    const cls = classifyTask(t, [t, task('T005', 'Mount LoginForm on the login page')]);
    expect(cls.wiredBy).toBe('T005');
    expect(cls.noTestReason).toBe('presentational');
    expect(cls.allowsConfigChange).toBe(true);
    expect(cls.allowsTestEdits).toBe(true);
    expect(cls.rationale).toContain('wired by T005 (marker)');
  });
});

describe('depthFor / effectiveVerifyMode', () => {
  const cfg = (over: Partial<RunConfig> = {}) => ({ ...RunConfig.parse({}), ...over });
  const cls = (kind: 'impl' | 'test' | 'config' | 'docs' | 'enhance', risk: 'low' | 'medium' | 'high') =>
    ({
      kind,
      risk,
      tdd: 'none' as const,
      redTaskIds: [],
      greenTaskIds: [],
      allowsConfigChange: false,
      allowsTestEdits: false,
      rationale: [],
    });

  it('adaptive routes by kind then risk', () => {
    expect(depthFor(cls('config', 'high'), cfg())).toBe('gates');
    expect(depthFor(cls('docs', 'medium'), cfg())).toBe('gates');
    expect(depthFor(cls('test', 'high'), cfg())).toBe('gates');
    expect(depthFor(cls('impl', 'low'), cfg())).toBe('gates');
    expect(depthFor(cls('impl', 'medium'), cfg())).toBe('light');
    expect(depthFor(cls('impl', 'high'), cfg())).toBe('full');
    expect(depthFor(cls('enhance', 'high'), cfg())).toBe('light');
  });

  it('full / gates-only / feature override classification', () => {
    expect(depthFor(cls('docs', 'low'), cfg({ verifyMode: 'full' }))).toBe('full');
    expect(depthFor(cls('impl', 'high'), cfg({ verifyMode: 'gates-only' }))).toBe('gates');
    expect(depthFor(cls('impl', 'high'), cfg({ verifyMode: 'feature' }))).toBe('gates');
  });

  it('useVerifyLoop:false collapses to gates-only', () => {
    expect(effectiveVerifyMode(cfg({ useVerifyLoop: false, verifyMode: 'full' }))).toBe('gates-only');
    expect(depthFor(cls('impl', 'high'), cfg({ useVerifyLoop: false, verifyMode: 'full' }))).toBe('gates');
    expect(effectiveVerifyMode(cfg())).toBe('adaptive');
  });

  it('describeClassification is a compact one-liner', () => {
    expect(describeClassification({ ...cls('impl', 'high'), tdd: 'green', redTaskIds: ['T001'] })).toBe(
      'impl · high · tdd=green(T001)'
    );
  });
});

describe('classifyTask — reviewer scenarios (synthetic tasks, dangling references, implied wiring)', () => {
  it('a synthetic ENHANCE-/VERIFY- task never inherits markers from the user-task bodies embedded in its body', () => {
    const body = '- T003: Contract tests for login\n  - tdd: red\n  - level: integration\n- T004: Implement login\n  - tests: T003\n  - touches-config: adds vitest\n  - modifies-tests: snapshot\n  - wired by: T005\n  - no test: whatever';
    for (const kind of ['enhance', 'verify'] as const) {
      const t = task('ENHANCE-auth', 'vibe-enhance pass for auth', body, { kind, dependencies: ['T003', 'T004'] });
      const cls = classifyTask(t, [t, task('T003', 'Contract tests for login', '- tdd: red'), task('T004', 'Implement login', '- tests: T003')]);
      expect(cls).toMatchObject({ kind: 'enhance', risk: 'medium', tdd: 'none', redTaskIds: [], greenTaskIds: [], allowsConfigChange: false, allowsTestEdits: false });
      expect(cls.testsDelegatedTo).toBeUndefined();
      expect(cls.wiredBy).toBeUndefined();
      expect(cls.noTestReason).toBeUndefined();
      expect(cls.rationale.join('\n')).toMatch(/synthetic/);
    }
  });

  it('markers nested deeper than two spaces are body text, not markers', () => {
    const m = parseTaskMarkers('- kind: impl\n  - risk: high\n    - tdd: red\n\t- level: e2e\n      - touches-config: nope');
    expect(m.kind).toBe('impl');
    expect(m.risk).toBe('high');
    expect(m.tdd).toBeUndefined();
    expect(m.level).toBe('e2e');
    expect(m.touchesConfig).toBeUndefined();
    // repro from the reviewer: an impl task body that quotes another task's markers under a sub-bullet
    const t = task('T009', 'Implement thing', '- note: mirrors T003\n    - tdd: red\n    - tests: T003');
    const cls = classifyTask(t, [t, task('T003', 'Tests for thing', '- tdd: red')]);
    expect(cls.tdd).toBe('none');
    expect(cls.testsDelegatedTo).toBeUndefined();
  });

  it('`- tests: T999` naming a task that does not exist is ignored: the task stays a behavior task', () => {
    const t = task('T002', 'Implement pricing', '- tests: T999');
    const cls = classifyTask(t, [t]);
    expect(cls.testsDelegatedTo).toBeUndefined();
    expect(cls.tdd).toBe('none');
    expect(cls.rationale).toContain('tests: T999 ignored — no such task; this task must carry its own tests');
    // a mix keeps the valid reference
    const red = task('T001', 'Tests for pricing', '- tdd: red');
    const mixed = classifyTask(task('T002', 'Implement pricing', '- tests: T999, T001'), [red, task('T002', 'Implement pricing', '- tests: T999, T001')]);
    expect(mixed.testsDelegatedTo).toBe('T001');
    expect(mixed.tdd).toBe('green');
  });

  it('`- wired by:` is kept only when the target exists and is still open; otherwise this task must wire it', () => {
    const t = task('T004', 'Create LoginForm component', '- wired by: T999');
    const missing = classifyTask(t, [t]);
    expect(missing.wiredBy).toBeUndefined();
    expect(missing.rationale).toContain('wired by: T999 ignored — no such task; wire the artifact in this task');

    const done = classifyTask(task('T004', 'Create LoginForm component', '- wired by: T005'), [t, task('T005', 'Mount it', '', { status: 'done' })]);
    expect(done.wiredBy).toBeUndefined();
    expect(done.rationale.join('\n')).toContain('wired by: T005 ignored — that task is already done');

    const failed = classifyTask(task('T004', 'Create LoginForm component', '- wired by: T005'), [t, task('T005', 'Mount it', '', { status: 'failed' })]);
    expect(failed.wiredBy).toBeUndefined();

    const open = classifyTask(task('T004', 'Create LoginForm component', '- wired by: T005'), [t, task('T005', 'Mount it', '', { status: 'deferred' })]);
    expect(open.wiredBy).toBe('T005');
  });

  it('implied red-stub wiring: sole green task → it; several → the LAST in file order; explicit marker wins', () => {
    const red = task('T001', 'Contract tests for checkout');
    const service = task('T002', 'Implement checkout service', '', { dependencies: ['T001'] });
    const route = task('T003', 'Implement checkout route', '', { dependencies: ['T001'] });
    const page = task('T004', 'Implement checkout page', '', { dependencies: ['T001'] });

    const sole = classifyTask(red, [red, service]);
    expect(sole.wiredBy).toBe('T002');
    expect(sole.rationale.join('\n')).toContain('sole green task');

    const several = classifyTask(red, [red, service, route, page]);
    expect(several.greenTaskIds).toEqual(['T002', 'T003', 'T004']);
    expect(several.wiredBy).toBe('T004');
    expect(several.rationale.join('\n')).toMatch(/last of 3 green tasks T002, T003, T004 in file order/);

    // file order, not id order
    const reordered = classifyTask(red, [red, page, route, service]);
    expect(reordered.wiredBy).toBe('T002');

    // an already-done green task is skipped as a wiring target
    const partly = classifyTask(red, [red, service, route, { ...page, status: 'done' }]);
    expect(partly.wiredBy).toBe('T003');

    // explicit marker overrides the implication
    const explicit = classifyTask(task('T001', 'Contract tests for checkout', '- wired by: T002'), [red, service, route, page]);
    expect(explicit.wiredBy).toBe('T002');
    expect(explicit.rationale).toContain('wired by T002 (marker)');

    // no green task → no implied wiring
    expect(classifyTask(task('T001', 'Contract tests for checkout', '- tdd: red'), [red]).wiredBy).toBeUndefined();
  });
});
