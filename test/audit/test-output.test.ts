import { describe, expect, it } from 'vitest';
import { parseTestOutput, stripAnsi } from '../../src/audit/test-output.js';
import { VITEST_FAIL_1_OF_4, VITEST_PASS_4 } from './_helpers.js';

describe('parseTestOutput', () => {
  it('strips ANSI codes before parsing', () => {
    const colored = '\u001b[32m      Tests  \u001b[1m4 passed\u001b[22m (4)\u001b[39m\n';
    expect(stripAnsi(colored)).toBe('      Tests  4 passed (4)\n');
    expect(parseTestOutput(colored)).toMatchObject({ runner: 'vitest', passed: 4, failed: 0 });
  });

  it('returns unknown for empty / unrecognized output', () => {
    expect(parseTestOutput('')).toEqual({ runner: 'unknown', passed: 0, failed: 0, skipped: 0, failingFiles: [] });
    expect(parseTestOutput('Compiled successfully.\nDone in 2.1s')).toMatchObject({ runner: 'unknown' });
  });

  describe('vitest', () => {
    it('parses the all-pass summary', () => {
      expect(parseTestOutput(VITEST_PASS_4)).toEqual({ runner: 'vitest', passed: 4, failed: 0, skipped: 0, failingFiles: [] });
    });

    it('parses failures and attributes failing files from ❯ and FAIL lines', () => {
      const r = parseTestOutput(VITEST_FAIL_1_OF_4);
      expect(r).toMatchObject({ runner: 'vitest', passed: 3, failed: 1, skipped: 0 });
      expect(r.failingFiles).toEqual(['test/x.test.ts']);
    });

    it('counts skipped and todo', () => {
      const out = ' Test Files  1 passed (1)\n      Tests  4 passed | 2 skipped | 1 todo (7)\n';
      expect(parseTestOutput(out)).toMatchObject({ runner: 'vitest', passed: 4, failed: 0, skipped: 3 });
    });

    it('handles a file that failed to load (0 tests) and suite-level FAIL lines', () => {
      const out = [
        ' RUN  v5.0.1 /p',
        ' ❯ test/broken.test.ts (0 test)',
        ' FAIL  test/broken.test.ts [ test/broken.test.ts ]',
        'Error: Cannot find module',
        ' Test Files  1 failed (1)',
        '      Tests  no tests',
      ].join('\n');
      const r = parseTestOutput(out);
      expect(r.runner).toBe('vitest');
      expect(r.failingFiles).toEqual(['test/broken.test.ts']);
    });

    it('takes the last Tests summary when several are printed', () => {
      const out = '      Tests  1 failed (1)\n...\n      Tests  2 passed (2)\n';
      expect(parseTestOutput(out)).toMatchObject({ passed: 2, failed: 0 });
    });
  });

  describe('jest', () => {
    it('parses the summary and FAIL file lines', () => {
      const out = [
        'PASS src/a.test.ts',
        'FAIL src/x.test.ts',
        '  ● suite › name',
        '    expect(received).toBe(expected)',
        '',
        'Test Suites: 1 failed, 1 passed, 2 total',
        'Tests:       1 failed, 3 passed, 4 total',
        'Snapshots:   0 total',
        'Time:        1.2 s',
      ].join('\n');
      expect(parseTestOutput(out)).toEqual({ runner: 'jest', passed: 3, failed: 1, skipped: 0, failingFiles: ['src/x.test.ts'] });
    });

    it('counts skipped + todo', () => {
      const out = 'Tests:       2 skipped, 1 todo, 3 passed, 6 total\n';
      expect(parseTestOutput(out)).toMatchObject({ runner: 'jest', passed: 3, failed: 0, skipped: 3 });
    });

    it('is not confused by vitest-like lines in test names', () => {
      const out = 'PASS src/vitest-compat.test.ts\nTests:       2 passed, 2 total\n';
      expect(parseTestOutput(out).runner).toBe('jest');
    });
  });

  describe('pytest', () => {
    it('parses failures with FAILED lines', () => {
      const out = [
        '============================= test session starts ==============================',
        'collected 4 items',
        '',
        'tests/test_x.py .F..                                                     [100%]',
        '',
        '=================================== FAILURES ===================================',
        '=========================== short test summary info ============================',
        'FAILED tests/test_x.py::test_y - AssertionError: assert 1 == 2',
        '========================= 1 failed, 3 passed in 0.5s ==========================',
      ].join('\n');
      expect(parseTestOutput(out)).toEqual({ runner: 'pytest', passed: 3, failed: 1, skipped: 0, failingFiles: ['tests/test_x.py'] });
    });

    it('parses all-pass with skipped and warnings', () => {
      const out = '==================== 4 passed, 1 skipped, 2 warnings in 0.12s ====================\n';
      expect(parseTestOutput(out)).toMatchObject({ runner: 'pytest', passed: 4, failed: 0, skipped: 1, failingFiles: [] });
    });

    it('counts errors as failures and attributes ERROR lines', () => {
      const out = 'ERROR tests/test_db.py::test_conn - RuntimeError\n===== 1 error, 2 passed in 0.3s =====\n';
      expect(parseTestOutput(out)).toMatchObject({ runner: 'pytest', failed: 1, passed: 2, failingFiles: ['tests/test_db.py'] });
    });
  });

  describe('go test', () => {
    it('parses verbose output with --- FAIL and package FAIL lines', () => {
      const out = [
        '=== RUN   TestX',
        '--- FAIL: TestX (0.00s)',
        '    x_test.go:12: expected 2, got 1',
        '=== RUN   TestY',
        '--- PASS: TestY (0.00s)',
        '=== RUN   TestZ',
        '--- SKIP: TestZ (0.00s)',
        'FAIL',
        'FAIL\tgithub.com/x/pkg\t0.1s',
        'ok  \tgithub.com/x/other\t0.02s',
      ].join('\n');
      expect(parseTestOutput(out)).toEqual({ runner: 'go', passed: 1, failed: 1, skipped: 1, failingFiles: ['github.com/x/pkg'] });
    });

    it('falls back to package counts without -v', () => {
      const out = 'ok  \tgithub.com/x/a\t0.01s\nok  \tgithub.com/x/b\t(cached)\n?   \tgithub.com/x/c\t[no test files]\n';
      expect(parseTestOutput(out)).toEqual({ runner: 'go', passed: 2, failed: 0, skipped: 0, failingFiles: [] });
    });

    it('treats build failures as failing packages', () => {
      const out = '# github.com/x/pkg\n./a.go:3:1: syntax error\nFAIL\tgithub.com/x/pkg [build failed]\n';
      expect(parseTestOutput(out)).toMatchObject({ runner: 'go', failed: 1, failingFiles: ['github.com/x/pkg'] });
    });
  });

  describe('cargo test', () => {
    it('parses the result line and failing test names', () => {
      const out = [
        'running 4 tests',
        'test tests::a ... ok',
        'test tests::b ... FAILED',
        'test tests::c ... ok',
        'test tests::d ... ignored',
        '',
        'failures:',
        '    tests::b',
        '',
        'test result: FAILED. 3 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s',
      ].join('\n');
      expect(parseTestOutput(out)).toEqual({ runner: 'cargo', passed: 3, failed: 1, skipped: 1, failingFiles: ['tests::b'] });
    });

    it('sums multiple targets', () => {
      const out = 'test result: ok. 5 passed; 0 failed; 0 ignored\n\ntest result: ok. 2 passed; 0 failed; 1 ignored\n';
      expect(parseTestOutput(out)).toMatchObject({ runner: 'cargo', passed: 7, failed: 0, skipped: 1 });
    });
  });

  describe('mocha', () => {
    it('parses passing / failing / pending', () => {
      const out = [
        '  suite',
        '    ✓ works',
        '    1) fails',
        '',
        '  3 passing (20ms)',
        '  2 pending',
        '  1 failing',
        '',
        '  1) suite fails:',
        '     AssertionError: expected 1 to equal 2',
        '      at Context.<anonymous> (test/x.test.js:12:5)',
      ].join('\n');
      expect(parseTestOutput(out)).toEqual({ runner: 'mocha', passed: 3, failed: 1, skipped: 2, failingFiles: ['test/x.test.js'] });
    });
  });

  describe('playwright', () => {
    it('parses the list reporter summary and attributes failing specs', () => {
      const out = [
        '',
        'Running 3 tests using 1 worker',
        '',
        '  ✓  1 [chromium] › e2e/home.spec.ts:3:5 › has title (1.2s)',
        '  ✘  2 [chromium] › e2e/login.spec.ts:5:1 › login works (800ms)',
        '  -  3 [chromium] › e2e/skip.spec.ts:5:1 › later',
        '',
        '  1) [chromium] › e2e/login.spec.ts:5:1 › login works ───────────────────',
        '',
        '    Error: expect(received).toBe(expected) // Object.is equality',
        '',
        '  1 failed',
        '    [chromium] › e2e/login.spec.ts:5:1 › login works ────',
        '  1 skipped',
        '  1 passed (2.3s)',
      ].join('\n');
      expect(parseTestOutput(out)).toEqual({ runner: 'playwright', passed: 1, failed: 1, skipped: 1, failingFiles: ['e2e/login.spec.ts'] });
      expect(parseTestOutput('Running 2 tests using 2 workers\n\n  2 passed (1.0s)\n')).toMatchObject({ runner: 'playwright', passed: 2, failed: 0, failingFiles: [] });
      // a bare "N passed" line without any playwright signature is not playwright
      expect(parseTestOutput('3 passed\n').runner).toBe('unknown');
    });
  });

  describe('cypress', () => {
    /**
     * Built from Cypress's documented `cypress run` default-reporter format
     * (two spec files, each ending in a bordered "(Results)" box), NOT
     * verified against a real `cypress run` in this sandbox — the
     * downloaded Cypress.app's Electron framework comes through with its
     * internal symlinks flattened/broken here, so the binary cannot start
     * (`dyld: Library not loaded`). See the WHY comment on `parseCypress`
     * in src/audit/test-output.ts for the same note.
     */
    it('sums Passing/Failing/Pending/Skipped across per-spec (Results) boxes and attributes failing specs via Spec Ran:', () => {
      const out = [
        'Running:  cypress/e2e/login.cy.js                                              (1 of 2)',
        '',
        '',
        '  Login',
        '    ✓ logs in successfully (450ms)',
        '',
        '',
        '  1 passing (500ms)',
        '',
        '',
        '  (Results)',
        '',
        '  ┌────────────────────────────────────────────────────────────────┐',
        '  │ Tests:        1                                                 │',
        '  │ Passing:      1                                                 │',
        '  │ Failing:      0                                                 │',
        '  │ Pending:      0                                                 │',
        '  │ Skipped:      0                                                 │',
        '  │ Screenshots:  0                                                 │',
        '  │ Video:        false                                             │',
        '  │ Duration:     0 seconds                                         │',
        '  │ Spec Ran:     cypress/e2e/login.cy.js                           │',
        '  └────────────────────────────────────────────────────────────────┘',
        '',
        '',
        'Running:  cypress/e2e/signup.cy.js                                             (2 of 2)',
        '',
        '',
        '  Signup',
        '    ✓ shows the form (300ms)',
        '    1) rejects a duplicate email',
        '    2) requires a password',
        '',
        '',
        '  1 passing (900ms)',
        '  2 failing',
        '',
        '  1) Signup rejects a duplicate email:',
        '     AssertionError: expected 400 to equal 200',
        '      at Context.<anonymous> (cypress/e2e/signup.cy.js:12:5)',
        '',
        '  2) Signup requires a password:',
        '     AssertionError: expected 400 to equal 200',
        '      at Context.<anonymous> (cypress/e2e/signup.cy.js:20:5)',
        '',
        '',
        '  (Results)',
        '',
        '  ┌────────────────────────────────────────────────────────────────┐',
        '  │ Tests:        3                                                 │',
        '  │ Passing:      1                                                 │',
        '  │ Failing:      2                                                 │',
        '  │ Pending:      0                                                 │',
        '  │ Skipped:      0                                                 │',
        '  │ Screenshots:  2                                                 │',
        '  │ Video:        false                                             │',
        '  │ Duration:     0 seconds                                         │',
        '  │ Spec Ran:     cypress/e2e/signup.cy.js                          │',
        '  └────────────────────────────────────────────────────────────────┘',
        '',
        '',
        '====================================================================================================',
        '',
        '  (Run Finished)',
        '',
        '',
        '       Spec                                              Tests  Passing  Failing  Pending  Skipped',
        '  ┌────────────────────────────────────────────────────────────────────────────────────────────┐',
        '  │ ✔  login.cy.js                             00:01        1        1        -        -        - │',
        '  │ ✖  signup.cy.js                             00:01        3        1        2        -        - │',
        '  └────────────────────────────────────────────────────────────────────────────────────────────┘',
        '    ✖  1 of 2 failed (50%)                      00:02        4        2        2        -        -',
        '',
      ].join('\n');
      expect(parseTestOutput(out)).toEqual({
        runner: 'cypress',
        passed: 2,
        failed: 2,
        skipped: 0,
        failingFiles: ['cypress/e2e/signup.cy.js'],
      });
    });

    it('a fully-passing single-spec run parses cleanly with no failing files', () => {
      const out = [
        'Running:  cypress/e2e/home.cy.js                                               (1 of 1)',
        '',
        '  Home',
        '    ✓ loads (100ms)',
        '',
        '  1 passing (100ms)',
        '',
        '  (Results)',
        '  ┌────────────────────────────────────────────────────────────────┐',
        '  │ Tests:        1                                                 │',
        '  │ Passing:      1                                                 │',
        '  │ Failing:      0                                                 │',
        '  │ Pending:      0                                                 │',
        '  │ Skipped:      0                                                 │',
        '  │ Spec Ran:     cypress/e2e/home.cy.js                            │',
        '  └────────────────────────────────────────────────────────────────┘',
      ].join('\n');
      expect(parseTestOutput(out)).toEqual({ runner: 'cypress', passed: 1, failed: 0, skipped: 0, failingFiles: [] });
    });

    it('is tried BEFORE mocha in the OR-chain, so a cypress run is never misparsed as bare mocha', () => {
      // Cypress's per-spec output includes ordinary mocha-style "N passing"/
      // "N failing" progress lines; without cypress-first ordering those
      // would satisfy `parseMocha` and the (Results) box would be ignored.
      const out = [
        '  1 passing (500ms)',
        '  1 failing',
        '  (Results)',
        '  │ Tests:        2                                                 │',
        '  │ Passing:      1                                                 │',
        '  │ Failing:      1                                                 │',
        '  │ Pending:      0                                                 │',
        '  │ Skipped:      0                                                 │',
        '  │ Spec Ran:     cypress/e2e/x.cy.js                               │',
      ].join('\n');
      expect(parseTestOutput(out).runner).toBe('cypress');
    });
  });

  describe('node:test', () => {
    it('parses TAP output', () => {
      const out = [
        'TAP version 13',
        '# Subtest: /home/u/proj/test/a.test.js',
        'not ok 1 - /home/u/proj/test/a.test.js',
        '  ---',
        '  duration_ms: 12',
        '  ...',
        'ok 2 - /home/u/proj/test/b.test.js',
        '1..2',
        '# tests 4',
        '# suites 0',
        '# pass 3',
        '# fail 1',
        '# cancelled 0',
        '# skipped 0',
        '# todo 0',
        '# duration_ms 30',
      ].join('\n');
      expect(parseTestOutput(out, { projectDir: '/home/u/proj' })).toEqual({
        runner: 'node-test',
        passed: 3,
        failed: 1,
        skipped: 0,
        failingFiles: ['test/a.test.js'],
      });
    });

    it('parses the spec reporter', () => {
      const out = '✔ adds (1ms)\n✖ subtracts (2ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ skipped 0\nℹ todo 0\n';
      expect(parseTestOutput(out)).toMatchObject({ runner: 'node-test', passed: 1, failed: 1 });
    });

    it('attributes assertion failures from the default spec reporter (Node ≥ 20, piped) via "test at <file>:line"', () => {
      // Captured verbatim from `node --test 'test/*.test.mjs' 2>&1 | cat` on Node 25 (temp path generalized).
      const out = [
        '✖ mul (1.291292ms)',
        '✔ ok (0.089042ms)',
        'ℹ tests 2',
        'ℹ suites 0',
        'ℹ pass 1',
        'ℹ fail 1',
        'ℹ cancelled 0',
        'ℹ skipped 0',
        'ℹ todo 0',
        'ℹ duration_ms 89.153708',
        '',
        '✖ failing tests:',
        '',
        'test at test/red.test.mjs:3:1',
        '✖ mul (1.291292ms)',
        '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
        '  ',
        '  6 !== 7',
        '  ',
        '      at TestContext.<anonymous> (file:///home/u/proj/test/red.test.mjs:4:10)',
        '      at Test.runInAsyncScope (node:async_hooks:226:14)',
        '      at Test.run (node:internal/test_runner/test:1201:25)',
        '  {',
        "    generatedMessage: true,",
        "    code: 'ERR_ASSERTION',",
        '  }',
      ].join('\n');
      expect(parseTestOutput(out, { projectDir: '/home/u/proj' })).toEqual({
        runner: 'node-test',
        passed: 1,
        failed: 1,
        skipped: 0,
        failingFiles: ['test/red.test.mjs'],
      });
      // TAP for the same run (`--test-reporter=tap`): `location:` line carries the absolute path.
      const tap = [
        'TAP version 13',
        '# Subtest: mul',
        'not ok 1 - mul',
        '  ---',
        '  duration_ms: 1.310625',
        "  type: 'test'",
        "  location: '/home/u/proj/test/red.test.mjs:3:1'",
        "  failureType: 'testCodeFailure'",
        '  ...',
        '# Subtest: ok',
        'ok 2 - ok',
        '1..2',
        '# tests 2',
        '# pass 1',
        '# fail 1',
        '# cancelled 0',
        '# skipped 0',
        '# todo 0',
      ].join('\n');
      expect(parseTestOutput(tap, { projectDir: '/home/u/proj' })).toMatchObject({ runner: 'node-test', failed: 1, failingFiles: ['test/red.test.mjs'] });
    });
  });
});

describe('shared attribution helpers (test-output.ts)', () => {
  it('normalizePath is the one normalizer (re-exported by patterns.ts)', async () => {
    const { normalizePath } = await import('../../src/audit/test-output.js');
    const patterns = await import('../../src/audit/patterns.js');
    expect(patterns.normalizePath).toBe(normalizePath);
    expect(normalizePath('.\\src\\a.ts')).toBe('src/a.ts');
    expect(normalizePath('/src//a.ts')).toBe('src/a.ts');
    expect(normalizePath('././x')).toBe('x');
  });

  it('failureMatchesFile covers the union of the orchestrator and audit semantics (paths, go packages, cargo names)', async () => {
    const { failureMatchesFile, failureMatchesFiles } = await import('../../src/audit/test-output.js');
    const tdd = await import('../../src/audit/tdd.js');
    expect(tdd.failureMatchesFiles).toBe(failureMatchesFiles);
    expect(failureMatchesFile('packages/web/test/x.test.ts', 'test/x.test.ts', 'jest')).toBe(true);
    expect(failureMatchesFile('test/x.test.ts', 'packages/web/test/x.test.ts', 'jest')).toBe(true);
    expect(failureMatchesFile('test/xx.test.ts', 'test/x.test.ts', 'jest')).toBe(false);
    expect(failureMatchesFile('example.com/mod/pkg/auth', 'pkg/auth/login_test.go', 'go')).toBe(true);
    expect(failureMatchesFile('example.com/mod/pkg/auth', 'pkg/billing/x_test.go', 'go')).toBe(false);
    expect(failureMatchesFile('example.com/mod', 'main_test.go', 'go')).toBe(false);
    expect(failureMatchesFile('tests::auth::login', 'tests/auth.rs', 'cargo')).toBe(true); // ordered segments (orchestrator rule)
    expect(failureMatchesFile('pricing::tests::a', 'src/pricing.rs', 'cargo')).toBe(true); // module name (audit rule)
    expect(failureMatchesFile('billing::tests::a', 'src/pricing.rs', 'cargo')).toBe(false);
    expect(failureMatchesFile('', 'x', 'jest')).toBe(false);
  });
});
