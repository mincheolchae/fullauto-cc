---
name: tdd-loop
description: Red → green → refactor with machine-checkable evidence — write the failing test first, RUN it and paste the failing summary line, implement the minimum, run again, refactor under green, end with `FULLAUTO_TDD:` evidence. Picks the test level (unit / integration / e2e through the real entry point), uses the project runner as-is, and is the canonical home of the anti-cheat rules the fullauto audit enforces; red / green task modes. TRIGGER — "TDD", "tdd로", "테스트 먼저", "테스트부터", "실패하는 테스트", "test first", `/tdd-loop`, a fullauto `## TDD protocol`. SKIP for config / docs / styling tasks.
user-invocable: true
allowed-tools:
  - Bash(npm *)
  - Bash(npx *)
  - Bash(pnpm *)
  - Bash(yarn *)
  - Bash(node *)
  - Bash(pytest*)
  - Bash(python *)
  - Bash(uv *)
  - Bash(go *)
  - Bash(cargo *)
  - Bash(make *)
  - Bash(test *)
  - Bash(ls *)
  - Bash(cat *)
  - Bash(git status*)
  - Bash(git diff*)
  - Bash(git grep*)
  - Bash(git ls-files*)
  - Read
  - Edit
  - Write
  - Grep
---

# /tdd-loop — Red → Green → Refactor with evidence

The failing run is the proof the test is real: a test that failed before the code existed and passed after, reported in one line the fullauto orchestrator cross-checks against the gate output and the tree diff.

## Arguments

```
/tdd-loop [mode=single|red|green] [level=unit|integration|e2e] <what to build>
```

`mode` — `single` (default: red and green in one task) · `red` (tests + stubs only; must fail) · `green` (implement against a prior red task's read-only tests); fullauto sets it from `- tdd: red` / `- tdd: green`. `level` — force a level; otherwise use the table below.

## The loop

```
0. detect the runner · 1. RED: test + compile-only stubs, run, must FAIL → `RED: <line>` · 2. GREEN: smallest change, run, must PASS → `GREEN: <line>` · 3. REFACTOR under green, full suite once · 4. FULLAUTO_TDD: red=<n> green=<n>
```

## Step 0 — Detect the runner

Use what the project has (a documented test command in `CLAUDE.md` / README wins). Iterate on one file; run the whole suite once at the end.

| Signal | One file | Red line looks like |
|---|---|---|
| `vitest` dep / `vitest.config.*` | `npx vitest run <file>` | `Tests  1 failed \| 3 passed` |
| `jest` dep / `jest.config.*` | `npx jest <file>` | `Tests: 1 failed, 3 passed, 4 total` |
| `mocha` dep / `.mocharc*` | `npx mocha <file>` | `1 failing` |
| `"test": "node --test"` | `node --test <file>` | `# fail 1` |
| `pytest.ini` / `[tool.pytest]` / `conftest.py` | `pytest <file> -x` | `FAILED tests/x.py::test_y` |
| `go.mod` + `*_test.go` | `go test ./<pkg>/ -run TestX` | `--- FAIL: TestX` |
| `Cargo.toml` + `#[test]` | `cargo test <name>` | `test result: FAILED. 1 failed` |
| `playwright.config.*` / `cypress.config.*` | `npx playwright test <file>` / `npx cypress run --spec <file>` | `1 failed` |
| `supertest` dep | HTTP tests through the app, via the unit runner | as above |

**No runner at all.** If the task body allows config (`- kind: config` or `- touches-config: <reason>`), add the minimal runner for the stack (`vitest` + `test` script; `pytest` in `pyproject.toml`), say `touches-config: adds test runner` in your final message, and continue. Otherwise end with `FULLAUTO_RESULT: DEFER no test runner configured | unmet: test runner (needs a config task with touches-config)`.

**Confirm the runner runs something.** `No test files found` / `collected 0 items` / 0 tests is not green — put the file where the runner discovers it (`test/`, `tests/`, `__tests__/`, `*.test.ts`, `*_test.go`, `test_*.py`).

## Choosing the test level

The lowest level that exercises the real behavior; add a higher one when the change crosses a boundary the lower cannot see.

| The change is … | Level | Through |
|---|---|---|
| pure logic (function, class, parser, validation) | **unit** | direct call to the export; no I/O; mock only true externals |
| anything crossing I/O (db, fs, network, queue, cache, clock) | **integration** | the real boundary in disposable form — temp SQLite, `tmpdir()`, local test server, fake queue with the same interface; the code under test is real |
| an HTTP endpoint / route / webhook | **e2e (HTTP)** | `supertest` / `fetch` against `app.listen(0)`, `TestClient`, `httptest` — through router and middleware |
| a CLI command | **e2e (CLI)** | spawn the binary in a temp dir; assert exit code + stdout / stderr + files |
| a UI user journey | **e2e (browser)** | the project's Playwright / Cypress against a dev build |
| a bug fix | where the bug was observable | the failing test IS the reproduction |

Every new or changed public entry point (HTTP route, CLI command, core journey) gets one test through the real entry point — handler-only tests do not count.

## Step 1 — RED

1. One behavior per test, named after it (`rejects duplicate email`), with at least one real assertion.
2. Add only the stubs needed to compile / import — the exported signature throwing `not implemented` (`NotImplementedError`, `panic`, `todo!()`). **No logic**: typecheck passes while test fails.
3. Run the file; it must fail **for the right reason** (the assertion or the throw), not a syntax error or a missing module.
4. Paste the failing summary line prefixed `RED:`.

A test that passes first time means the behavior already exists (say so; in fullauto → `- tdd: none`), the test is tautological, or it hits the wrong unit. Never go GREEN from a test that never failed.

## Step 2 — GREEN, Step 3 — REFACTOR

GREEN: the smallest change that passes the red test — not the next three behaviors; run the file; paste `GREEN: <line>`. Still failing → fix the implementation, not the test (changing a test must be stated — see green mode). REFACTOR under green only: rename, extract, dedupe, tighten types; re-run the file after each refactor and the full suite once before finishing. A failure elsewhere is your regression — fix it, never skip it.

## Step 4 — Evidence line

End with `FULLAUTO_TDD: red=<n failing> green=<n passing>` on its own line — `red` = tests observed failing across RED runs, `green` = tests passing in the final full run of the files you touched (`mode=red` → `green=0`; `mode=green` → `red=0`). The orchestrator's verdict comes from the gate output and the tree diff; this line is what humans and `/verify-loop` reviewers read, so the numbers must be the ones the runner printed.

## Modes used by fullauto

**`mode=red`** (`- tdd: red`): tests only, plus minimal type-level stubs; tests **must fail at runtime**. Do not implement, skip, xfail, or comment out; do not touch other tasks' tests. Success = typecheck / lint / build green, test gate red, every failing test in a file this task added (they become a quarantined red set). Deferred when the gate passed (`tdd-red` BLOCK: impl already exists → `- tdd: none`, or tautological test), no test file was added, or the failing files are not yours. A stub nothing imports yet needs `- wired by: T###` in the task body. End with `FULLAUTO_TDD: red=<n> green=0`, the `RED:` line(s), and a `FULLAUTO_WIRING:` block listing each new test file and stub.

**`mode=green`** (`- tdd: green`, `- tests: T###`, or `(depends on <red task>)`): the red tests are the contract — read them first, implement until they pass, never edit them (changed hash, deleted, or still failing = `tdd-green` BLOCK). A genuinely wrong red test: fix it minimally and emit `FULLAUTO_TEST_CHANGE: <path/to/test.file> — <reason>` on its own line at column 0, one per file (BLOCK → WARN kept for human review). End with `FULLAUTO_TDD: red=0 green=<n>`.

**`mode=single`** (`- tdd: none`, kind=impl): red and green in one task, one behavior at a time; the test-count check (passed tests must increase) is the backstop.

## Anti-cheat rules (canonical list — mirrored by the orchestrator's tree diff)

Other skills reference this section; the orchestrator diffs the tree and fails the task on any of them:

1. **No `.skip` / `.only` / `.todo` / `xit` / `xdescribe` / `xtest` / `fit` / `fdescribe`, `@pytest.mark.skip` / `xfail`, `pytest.skip()`, `unittest.skip`, `t.Skip()`, `#[ignore]`, `@Ignore`, `@Disabled`, `--passWithNoTests`** introduced by you.
2. **No deleting or weakening tests** — fewer test blocks or assertions in a pre-existing test file is a BLOCK unless the task says `- modifies-tests:`.
3. **No touching gate config** — `package.json` gate scripts (`test`, `typecheck`, `lint`, `build`, `test:e2e`), `vitest.config.*`, `jest.config.*`, `tsconfig*.json`, `.eslintrc*` / `eslint.config.*`, `biome.json`, `pytest.ini`, `pyproject.toml`, `setup.cfg`, `tox.ini`, `Makefile`, `playwright.config.*`, `cypress.config.*`, `.fullauto/config.json`, `.github/workflows/*` — unless the task is `- kind: config` or says `- touches-config: <reason>`.
4. **No tautologies** — `expect(true).toBe(true)`, `assert True`, `assert 1 == 1`, a test block with zero assertions.
5. **No `@ts-ignore` / `@ts-expect-error` / `eslint-disable` / `# type: ignore` / `#[allow(...)]`** added to make a gate pass.
6. **No swallowing failures** — no `try { expect(...) } catch {}` or `.catch(() => {})` around assertions, no widening the accepted range until the wrong answer fits.
7. **Never mock the unit under test** — mock a dependency, never `vi.mock` / `jest.mock` / `monkeypatch` the module the test is named after.
8. **No hard-coding the expected output** in the implementation.
9. **Green tasks don't edit red tests** except via `FULLAUTO_TEST_CHANGE: <file> — <reason>`.
10. **The failing run must be real** — paste what the runner printed, never write `RED:` from memory.

## Final message shape

```
RED: <failing summary line>            (one per red run)
GREEN: <passing summary line>          (one per green run)
<what was implemented, 2–5 lines> · <test level(s) and why, 1 line>
FULLAUTO_TEST_CHANGE: <file> — <reason>   (green mode, only if you had to)
FULLAUTO_TDD: red=<n> green=<n>
```

Inside fullauto `/verify-loop` runs after this loop; keep the `FULLAUTO_TDD:` line so the orchestrator and reviewers see it.
