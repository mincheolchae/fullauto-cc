---
name: verify-loop
description: Verified implementation loop with adaptive depth — runs the project gates and `fullauto audit` (orphans, unwired components, skipped / weakened tests, edited gate config) BEFORE any LLM review, then spawns fresh-context reviewers sized to the change — `gates` (none), `light` (code + requirements), `full` (correctness incl. wiring, security, requirements, + design for UI / public API); fixes BLOCKs, re-reviews only their dimensions, ends with `VERIFY_LOOP_RESULT:`. TRIGGER — `/verify-loop`, a fullauto prompt saying `invoke /verify-loop`, "verify loop", "review loop", "리뷰 받으면서", "self-review".
user-invocable: true
allowed-tools:
  - Agent
  - Skill
  - Bash(fullauto:*)
  - Bash(git status*)
  - Bash(git diff*)
  - Bash(git log*)
  - Bash(git grep*)
  - Bash(git ls-files*)
  - Bash(npm *)
  - Bash(npx *)
  - Bash(pnpm *)
  - Bash(yarn *)
  - Bash(pytest*)
  - Bash(python *)
  - Bash(uv *)
  - Bash(go *)
  - Bash(cargo *)
  - Bash(make *)
  - Bash(test *)
  - Bash(command -v *)
  - Read
  - Edit
  - Write
  - Grep
---

# /verify-loop — Verified implementation loop (adaptive depth)

Deterministic checks first (gates + `fullauto audit`), LLM review only where it adds signal, sized to the change.

## Arguments

```
/verify-loop [depth=gates|light|full] [cycles=N] [free text: what to verify]
```

| Arg | Default | Meaning |
|---|---|---|
| `depth` | inferred (manual) / stated (fullauto) | `gates` = gates + audit + one self-review, no reviewers. `light` = 2 reviewers (code, requirements). `full` = 3 (correctness incl. wiring, security, requirements) + design when UI / public-API files changed. |
| `cycles` | `2` | Max fix-and-re-verify cycles. Cycle 1 is the initial review; each further cycle re-spawns only the dimensions that raised BLOCKs. |

**Inside fullauto the prompt's depth and `verifyMaxCycles` are binding.** Never skip, downgrade, or escalate them; `Verification depth: gates` means do not invoke this skill at all. Start at Phase B.2 — the implementation is already done.

**Manual invocation without `depth=`** — infer once: `git diff --stat` + `git status --short`; a risk keyword in paths / title / requirements (`auth|login|logout|password|token|session|oauth|jwt|payment|billing|stripe|checkout|webhook|migration|schema|permission|rbac|role|secret|crypto|encrypt|upload|middleware|security|admin|delete|destroy|public api|rate.?limit`) → `full`; < 40 changed lines and no keyword → `gates`; else `light`. State it in one line. Manual invocation is also the only place "too small to bother" applies: for 1–2 line edits, doc-only, or typo fixes say `이 정도 변경은 verify-loop 비용이 과합니다 — 그냥 진행하겠습니다` and proceed without the loop.

## Cost model

Reviewer spawns per cycle: `gates` 0 · `light` 2 · `full` 3 (4 with design); cycle 2+ re-spawns only BLOCK-raising dimensions. Gates + `fullauto audit` run first every cycle, so an orphan file or a `.skip` is fixed for free before any reviewer sees the diff.

## The loop

```
B implement (manual) → intent + requirements + wiring manifest
C gates → fullauto audit  (every cycle; fix BLOCKs here first)
D spawn reviewers for the depth, in ONE message → E triage
   BLOCK → F fix → C → re-spawn only BLOCK dimensions (≤ cycles)
   clean → G report + VERIFY_LOOP_RESULT (+ DEFER marker after the cap, inside fullauto)
```

## Phase B — Implement + intent + requirements + wiring manifest

1. **Implement** (manual invocation only) with `Edit` / `Write`. Behavior changes follow `/tdd-loop` (failing test first, real runner) — the audit's test-count check expects new tests for behavior tasks.

2. **Intent statement** (1–3 lines): what it is for, and every deliberate "looks wrong" choice fresh eyes would flag ("endpoint intentionally public — signup precedes auth context"). Fed to every reviewer every cycle. Nothing intentional → `No surprises — the code looks how it works.`

3. **Requirements statement** — what was asked, verbatim. Sources in priority order: the tasks-file task line + sub-bullets (orchestrator marker bullets are quoted but listed as `marker — not a requirement`); a linked spec / ticket; the user's literal ask; none → `No explicit requirements — Requirements reviewer skipped this cycle.` (never invent criteria).

   **Product brief as a requirements source.** If `.fullauto/product.md` exists and the task maps to a feature id (`F\d{3}` in the task title or body, its `## Feature: F00x` heading, or the `<!-- fullauto:round=… items=… -->` header), quote that feature's `## Feature map` row (the `note` cell is the acceptance line) and its `## Backlog` entry under `### From product brief (F00x)` as additional requirement bullets; the Requirements reviewer treats them like sub-bullets.

   **Prior attempt context** (fullauto retry): quote every `unmet:` line at the top under `### Carried over from prior pass`, every `warn:` under `### Carried-over WARN signals`, and rendered audit bullets (`orphan-code: …`) under `### Carried-over audit findings`.

   ```
   ## Requirements (verbatim from <source>)
   <quoted text — never summarized, never edited later>

   ## Implementer's coverage notes (optional)
   - <bullet> — <covered at file:line> | <deferred — reason> | <interpreted as: X — reason: source> | <marker — not a requirement>

   ## Enhancements applied this pass (only after /vibe-enhance)
   - [ENHANCE:S|L|DEP] <one line> — <file:line> — source: <playbook item | internal file:line | URL>
   ```

4. **Wiring manifest** — for every file, export, component, route, handler, env read, flag, or migration ADDED, its production consumer, in the block the orchestrator parses (last `FULLAUTO_WIRING:` header + the `- ` bullets after it; `<left> -> <right>`; a parenthesized right side is an unverified note; repo-relative paths, no spaces, no trailing comments):

   ```
   FULLAUTO_WIRING:
   - <new file>[#symbol] -> <consumer file>[:line]
   - <new file> -> (entrypoint: <framework-addressed — why>)
   - <new file> -> (wired by T###)
   - (no new artifacts)
   ```

   One bullet per artifact; `- (no new artifacts)` alone when nothing was added. A consumer is an import / JSX render / route or handler registration / DI binding / `mod x;` in **production** code (tests do not count). `(wired by T###)` is valid only when the task body says `- wired by: T###`; otherwise wire the artifact now.

## Phase C — Deterministic floor (every cycle)

1. **Detect gates**, first hit wins: `CLAUDE.md` / `AGENTS.md` verify command → `package.json` scripts (`typecheck`, `test`, `lint`) → `pytest -x` → `go vet ./... && go test ./...` → `cargo check && cargo test` → `make check` / `make test`. None → `No verification commands detected — review-only mode.`; never fake a gate.
2. **Run** typecheck → test → lint; bail on the first failure. **Inside fullauto** the orchestrator re-runs EVERY configured gate (lint included) the moment you exit and hands a failure back as retry context, so do not duplicate that work: cycle 1 runs typecheck → test only (skip lint); cycle 2+ re-runs typecheck plus just the test files the fixes touched or cover (the full suite only when a fix changed shared code you cannot scope). Read results, not logs: a pass is its one summary line, a failure its first failing assertions.
3. **Triage.** Red and plausibly yours → fix and re-run (cap 3 attempts per cycle, then stop and surface it). Red in a file you did not touch (check `git diff`; never stash — inside fullauto the tree holds other tasks' uncommitted work) → `INFO: pre-existing failure in <gate>`, continue. A **red TDD task** (`- tdd: red`) must fail the test gate: typecheck / lint / build green, every failing test in a file this task added → `test ✗ (expected — red task)`.
4. **Audit** — `command -v fullauto >/dev/null 2>&1 && fullauto audit` (absent → skip silently). It diffs HEAD against the working tree, exit 1 on BLOCK: `orphan-code`, `unused-export` (WARN), `test-integrity`, `gate-integrity` (see `/wiring-audit` for the check table). The orchestrator's post-task audit additionally checks your `FULLAUTO_WIRING` claims, test counts vs baseline, and TDD red / green — treat the manifest as if it will be checked. Act on every BLOCK anchored to a file you changed; list BLOCKs on files you did not touch under INFO; fix, re-run gates + audit, then spawn reviewers. Never "fix" an audit BLOCK by deleting the artifact, the test, or the manifest line (`/tdd-loop` § Anti-cheat: no skip / weaken / delete tests, no gate-config edits, no `@ts-ignore` / `eslint-disable`).
5. **`depth=gates` stops here**: one self-review pass over each changed file, re-run gates once if you edited anything, then Phase G.

## Phase D — Reviewers (parallel, sized to depth)

1. **Review surface**: changed files (`git status --short`, `git diff --stat`) plus the consumers named in the manifest. Reviewers do not read the repo.
2. **Spawn the set for this depth in ONE message** (`Agent`, `subagent_type: general-purpose`, read-only, fresh context), each with the **common header** + exactly one **focus block** below. `light`: `code` + `requirements`. `full`: `correctness` (includes the wiring lens — `fullauto audit` already settled orphans and entrypoint claims, so no separate integration reviewer), `security` (skip only for pure styling / docs), `requirements`, plus `design` when the diff touches UI files (`.tsx/.jsx/.vue/.svelte`, `.css`, component / page dirs) or public-API surfaces (package entry points, OpenAPI / routes, published types).
3. Merge findings, deduping identical file:line + reason.

### The two lenses

**Wired** = a non-test consumer references the artifact on an executed path (`git grep -n` on basename, alias forms, directory-index form, exported symbols). Unused import, unrendered component, unregistered handler, env / flag read that nothing branches on, migration without a model change → BLOCK. `(entrypoint: …)` claims are pre-validated by `fullauto audit`; reviewers judge execution paths only. `- wired by: T###` → INFO.

**A test counts** only when it calls the real unit, asserts on behavior, covers the specific bullet, and — for a route / CLI command / journey — goes through the real entry point (details in the `requirements` focus block).

## Phase E — Triage

| Severity | Definition | Loop behavior |
|---|---|---|
| **BLOCK** | real bug, security hole, broken behavior, contract violation, data-loss risk, untested critical path, unwired artifact / unregistered handler / unrendered component, missing or wrong-shape required feature, acceptance bullet without a real test; `REGRESSION:` prefix for a prior BLOCK not actually fixed | another fix-and-verify cycle |
| **WARN** | smell, fragile pattern, unlikely edge case, unused non-component export, out-of-scope addition, cosmetic spec drift | reported, not auto-fixed |
| **INFO** | style, nitpick, intent- or coverage-covered finding, audit BLOCK on a file outside this task, wiring deferred by `- wired by:` | reported briefly or omitted |

Borderline → WARN, **except requirements and wiring gaps, which stay BLOCK.** A BLOCK your intent or coverage notes already address → INFO; if it recurs, sharpen the statement (the only mid-loop edit to intent / coverage notes; the quoted requirements are never edited).

**Ambiguous spec — no AMBIGUOUS path.** Pick a reading (project signal → README / CLAUDE.md → domain convention → smallest-blast-radius default), record `interpreted as: X — reason: <source>` in coverage notes, proceed; a sound note demotes the finding to INFO, a bullet that keeps returning rides the cycle cap → DEFER path, never a user prompt. Disagree with the spec → implement it and add an INFO, or record `interpreted as:`; decide in cycle 1.

## Phase F — Fix + targeted re-verify (cycle 2 … `cycles`)

Say in one line what is being fixed. Fix BLOCKs only — no WARN cleanup, never by deleting / skipping / weakening a test, editing gate config, `@ts-ignore`, or dropping a requirement bullet. Update the wiring manifest if a fix added or wired an artifact. Build `{PRIOR_BLOCKS}` (one per BLOCK: `- [BLOCK at <file:line>] (<dimension>) <description>` + `fix applied: <one line>`), goto Phase C, then re-spawn ONLY the dimensions that raised a BLOCK — plus any dimension whose surface gained files outside the BLOCK set.

**After the cycle cap** with BLOCKs remaining: stop; never raise `cycles` yourself. **Manual invocation only:** list the remaining BLOCKs with the last fix attempt and ask the user how to proceed. **Inside fullauto:** emit one marker, column 0, one line — every remaining BLOCK as `unmet:` in priority order, up to 5 meaningful WARNs as `warn:` (the parser takes the last `^FULLAUTO_RESULT:\s*DEFER` line and carries everything after `DEFER` into the next pass's `## Prior attempt context`):

```
FULLAUTO_RESULT: DEFER <one-line cause> | unmet: <verbatim bullet or file:line> | unmet: <next> | warn: <unfixed WARN> | last-attempt: <what the last fix tried>
```

## Phase G — Final report

```
## verify-loop 완료 (depth=<d>, <n> 사이클)

**게이트:** typecheck ✓ / test ✓ / lint ✓   (test ✗ "<한 줄>" — pre-existing | expected — red task)
**audit:** BLOCK 0 / WARN <n>   (또는 skipped — fullauto not on PATH)
**wiring:** <n>개 artifact consumer 확인   (또는 <artifact> → T###에서 wiring 예정)
**요구사항:** 전부 충족 | 부분 충족 (n/m) — <미충족 한 줄씩> | 검증 안 됨
**BLOCK:** 모두 해결 (n건)   (또는 미해결 n건 — 사이클 cap)
**WARN (n건):** - <설명> · <file:line>
**INFO (n건):** - <설명>

다음 행동: <한 줄>

VERIFY_LOOP_RESULT: depth=<d> cycles=<n> block=<n> warn=<n>
```

`VERIFY_LOOP_RESULT:` is mandatory and last in the report (before any `FULLAUTO_RESULT:` marker): `cycles` run, `block` still open, `warn` reported. Inside fullauto also end with the `FULLAUTO_WIRING:` block (updated for fixes) and, when `/tdd-loop` ran, `FULLAUTO_TDD: red=<n> green=<n>`.

## Reviewer prompt template

Send each reviewer the **common header** with `{INTENT}`, `{REQUIREMENTS}`, `{WIRING}`, `{FILES}` (and `{PRIOR_BLOCKS}` on cycle 2+) filled, followed by exactly ONE focus block.

**Common header**

```
You are a code reviewer with fresh eyes. You have NOT seen the implementation conversation; judge only the code in front of you and the statements below.

## Implementer's intent
{INTENT}
A finding already covered here is INFO ("addressed in intent"), never BLOCK.

## Requirements (source of truth for what was asked)
{REQUIREMENTS}
Marker bullets (`- kind:` `- risk:` `- tdd:` `- level:` `- tests:` `- no test:` `- touches-config:` `- modifies-tests:` `- wired by:`) are metadata, but `- wired by: T###`, `- tests: T###` and `- no test: <reason>` change what counts as missing. If the block says requirements were skipped, treat them as absent.

## Wiring manifest (where each new artifact is consumed)
{WIRING}

## Files
{FILES} — read each fully before judging; do not read beyond them and their named consumers.

## Prior cycle (cycle 2+ only)
{PRIOR_BLOCKS}
Verify each claimed fix FIRST: still present, papered over, moved, or "fixed" by deleting / skipping / weakening a test or editing config → BLOCK prefixed `REGRESSION:`. Fixed → silence.

## Output — for every finding, exactly:
  [BLOCK|WARN|INFO] <one line>
  └ file:line — <why this is a real problem, not a preference>
Requirements findings add   └ spec: "<quoted bullet>"
Wiring findings add         └ expected consumer: <where production code should reference it>
Then one line: "Found N BLOCK / N WARN / N INFO." or "No findings — clean for this dimension."
BLOCK = real bug, security hole, broken behavior, contract violation, data loss, untested critical path, unwired artifact, missing / wrong-shape required feature, acceptance bullet without a real test. WARN = real concern, code probably works. INFO = nitpick, alternative, intent-covered.

Rules: read-only; cite file:line for every finding; do not speculate about code you cannot see (INFO and move on); do not pad; do not repeat a finding under two severities; do not invent requirements — if the spec is silent the implementer's choice stands; unattended run — never ask the user to resolve ambiguity, judge the `interpreted as:` note instead (sound → INFO).
```

**Focus blocks** (append one)

```
## Focus: code   (light depth — correctness + security + integration on the diff only)
Bugs, broken behavior, missing edge cases, contract violations, error-handling gaps; validation / authz / secrets / injection wherever the diff touches them; and for every manifest line open the consumer and confirm the artifact is imported AND used on an executed path (unwired, unregistered, unrendered, or read-but-never-consumed = BLOCK). Entrypoint claims were pre-validated by `fullauto audit`; judge execution, not path patterns.
```

```
## Focus: correctness
Bugs, broken behavior, missing edge cases, type / contract violations, error-handling gaps, race conditions, and critical paths with no test (BLOCK even when gates pass). Wiring lens: for every manifest line open the consumer and confirm the artifact is imported AND used on an executed path — no consumer, test-only consumer, unregistered handler, unrendered component, env / flag never branched on, migration without a model change (or vice versa) = BLOCK; entrypoint claims were pre-validated by `fullauto audit`, judge execution, not path patterns; `- wired by: T###` → INFO. Stay in your lane; note security observations as INFO.
```

```
## Focus: security
Input validation, auth / authz boundaries, secrets handling, injection vectors, unsafe deserialization, missing rate limits, data exposure in errors or logs. A security hole is BLOCK regardless of test status.
```

```
## Focus: requirements
1. For every requirement bullet (including `### From product brief` and carried-over `unmet:` bullets) locate its implementation; not implemented and not explicitly deferred in coverage notes → BLOCK.
2. Check the shape — path, name, verb + route, response shape, parameters, behavior; mismatches others depend on → BLOCK, cosmetic → WARN.
3. Every user-visible acceptance bullet must be exercised by a test → else BLOCK.
4. Test quality: the test imports and calls the REAL unit (mocked unit = BLOCK); asserts on outputs / state / effects, not only on mocks called (= BLOCK); covers the specific bullet; for a route / CLI command / journey at least one test goes through the real entry point (handler-only = BLOCK); `.skip/.only/.todo`, swallowed assertions, tautologies, `@ts-ignore` / `eslint-disable` added to pass = BLOCK.
5. Code the requirements did not ask for: listed under `## Enhancements applied this pass` or marked `[ENHANCE:…]` → legitimate; otherwise WARN.
6. Never flag style or implementation-detail choices unless they contradict a bullet. A bullet with an `interpreted as:` note → judge the reasoning; sound → INFO.
```

```
## Focus: design
UI: a11y (labels, names, focus, contrast), layout at 390 px and 1280 px, theme tokens, i18n keys, empty / loading / error states. Public API: naming consistency, backward compatibility, coupling and abstraction level. Missing state on a new data view = BLOCK; naming = WARN.
```

## Rules

- **Depth is decided once** — bound by the prompt inside fullauto, inferred once manually; never escalated mid-loop (say in the report if the change outgrew the depth).
- **Deterministic checks every cycle, before reviewers;** `fullauto audit` absent → silent skip.
- **Reviewers are fresh, read-only agents,** spawned in one message per cycle, never resumed. `cycles` is a cap, not a target.
- **Statements are refined, not duplicated;** the quoted requirements are never edited; the manifest is updated whenever an artifact is added or wired.
- **Never close a gap by deleting the requirement, the artifact, or the test, and never cheat a gate** (`/tdd-loop` § Anti-cheat) — the orchestrator's audit diffs the tree and defers the task.
- **Don't auto-fix WARN / INFO; don't paste reviewer output** — summarize. `VERIFY_LOOP_RESULT:` appears verbatim.
