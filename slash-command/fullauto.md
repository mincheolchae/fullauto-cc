---
description: Full-auto build for Claude Code. Pass a tasks-file path to execute it, or pass a natural-language description to auto-decompose into tasks first. Examples — /fullauto tasks.md     OR     /fullauto implement user CRUD endpoints with tests
allowed-tools:
  - Bash(fullauto:*)
  - Bash(node *fullauto-cc/dist/cli.js*)
  - Bash(test *)
  - Bash(ls *)
  - Bash(cat *)
  - Read
---

# /fullauto — One-shot full-auto build

Two modes, dispatched automatically by the bash block below:

| You typed | Mode | What happens |
|---|---|---|
| `/fullauto path/to/tasks.md` | **run mode** | Parses the file, runs the orchestrator. |
| `/fullauto implement user CRUD endpoints` | **auto mode** | First spawns a planner subagent to decompose the description into `.fullauto/auto-tasks.md`, then runs the orchestrator on it. |

Both modes use the same per-task pipeline: each task runs in a fresh `claude -p` subagent (with `/verify-loop`, `/tdd-loop`, `/wiring-audit` available), then the verification gates (typecheck / test / lint / e2e by default — whatever `.fullauto/config.json` lists) run, then a **deterministic audit** diffs the working tree before/after the task — orphan code (new file / component / route that nothing in production imports, renders, or mounts; an unused import does not count), unused exports, wiring-manifest claims, test integrity (skipped / deleted / weakened / assertion-less / tautological tests), gate-config tampering (`package.json` scripts, `vitest.config.*`, `tsconfig`, eslint, pytest config, `.fullauto/config.json`, ...), test-count monotonicity, TDD red/green consistency, and verify-evidence (the `VERIFY_LOOP_RESULT:` line when review was required). Gates + audit decide `done` vs `deferred`; a deferred attempt's changes are rolled back (saved as `.fullauto/logs/<id>-attempt<N>.patch`) and the audit's findings are fed into the next pass's prompt. Deferred tasks retry on later passes; anything still unresolved is reported with reasons and log paths, and `fullauto retry [ids]` re-queues failed tasks after you fix the cause.

Append `--verify <mode>` to choose how much LLM review each task gets (see "Verify modes" below), and `--vibe-enhance` to layer on a proactive table-stakes / UX / trend improvement pass — see "Vibe-enhance modes" below.

The third mode, `fullauto evolve "<concept>"` (concept → product brief → plan / run / assess rounds), is a multi-hour unattended loop and is run from a terminal rather than through this slash command — see the README section "실행 모드".

## Verify modes

`--verify <adaptive|full|gates-only|feature>` overrides `verifyMode` in `.fullauto/config.json` (default `adaptive`). The mode decides the `/verify-loop` depth each task's subagent is told to use:

| Mode | Per-task depth | When to use |
|---|---|---|
| `adaptive` (default) | classified per task: config / docs / test tasks and low-risk tasks → `gates` (no reviewers); medium risk → `light` (2 reviewers); high risk (auth, payments, schema, migrations, webhooks, ...) → `full` (3 reviewers, + design for UI / public-API files); a retry whose previous attempt already passed review clean and only failed a gate / audit drops to `gates` | almost always |
| `full` | every task → `full` | small, high-stakes task lists where cost is irrelevant |
| `gates-only` | every task → `gates`; no reviewer subagents at all, deterministic gates + audit only | fast iteration, CI smoke, or when the project has strong tests |
| `feature` | every task → `gates`, plus one synthetic `VERIFY-<feature>` task at `full` after each feature group (Speckit `[USx]` story or h2 heading) | long task lists where per-task review is redundant but a per-story review is wanted |

`verifyMaxCycles` in the config (default 2) caps the fix-and-re-review cycles inside each `/verify-loop` run; cycle 2+ only re-spawns the reviewer dimensions that raised BLOCKs.

## Dispatch heuristic

The first whitespace-separated token of `$ARGUMENTS` is checked:

- **Looks like a path** (exists on disk, OR ends in `.md`, OR contains a `/`) → run mode. The token must point at a real file or the bash block errors out instead of guessing.
- **Anything else** → auto mode (the entire `$ARGUMENTS` is the description).

This means `/fullauto tasks.md --verbose` (existing file) is run mode, but `/fullauto implement the auth flow` is auto mode. If you want auto mode for something that *looks* path-y, write a sentence: `/fullauto build the file uploader`.

Put the file path or description FIRST, flags after. `/fullauto --vibe-enhance tasks.md` would mis-dispatch to auto mode (the leading flag is the first token); `/fullauto tasks.md --vibe-enhance` and `/fullauto tasks.md --verify full` work.

## Speckit pipeline (spec-kit 1.0.8+)

```
/speckit-specify ...
/speckit-plan ...
/speckit-tasks                          # writes specs/<feature>/tasks.md
/fullauto specs/<feature>/tasks.md      # instead of /speckit-implement
```

Spec-kit 1.0 installs its commands as skills under `.claude/skills/speckit-*/` and they are invoked with hyphens (`/speckit-tasks`). Projects initialized with an older spec-kit still have the dotted forms (`/speckit.tasks`) — those work the same; only the names differ. The `tasks.md` line grammar is unchanged (`- [ ] T001 [P] [US1] Description (depends on T000)`, IDs may exceed three digits), and fullauto reads it as-is. If you installed the bundled spec-kit extension (`specify extension add --dev /path/to/fullauto-cc/extensions/fullauto`), `/speckit-fullauto-run` does the same thing from inside the spec-kit flow and is offered automatically after `/speckit-tasks`.

## Vibe-enhance modes

Both run-mode and auto-mode accept `--vibe-enhance`, which layers a proactive improvement pass on top of the normal per-task pipeline. The pass is implemented by the `/vibe-enhance` skill — a fresh researcher subagent (with WebSearch) compares the just-completed work against latest trends, applies scoped FIT-BREAK / ENHANCE additions, and routes those additions through `/verify-loop` for verification. The pass enforces "no-op is a valid outcome" — if nothing's worth adding, the run continues without scope creep.

| Form | Granularity | Example |
|---|---|---|
| `/fullauto tasks.md --vibe-enhance` | **Per-feature**, auto-detected from the file. | `/fullauto sprint-tasks.md --vibe-enhance` |
| `/fullauto <description> --vibe-enhance` | **End-of-run** — one pass after all planned tasks finish. The auto-planner produces flat tasks, so the whole description is one implicit feature. | `/fullauto build a chat app with rooms --vibe-enhance` |

### How the parser detects feature boundaries

Two formats, auto-detected per file:

- **Speckit format** — any task line with a `[USx]` label (e.g. `- [ ] T012 [P] [US1] ...`) switches the parser into Speckit mode. Each user story is one feature; tasks without a `[USx]` label (Setup / Foundational / Polish phases) form one implicit group that fires its enhance pass after all of them complete. h2 headings are ignored in this mode because Speckit's `## Phase N: ...` covers categories beyond features.
- **Hand-written format** — if no `[USx]` labels are present anywhere, h2 headings (`## Auth flow` or `## Feature: Auth flow`) become feature boundaries.

If neither labels nor h2 headings are present, the whole file is one feature → one enhance pass at the end.

Each enhance pass is a synthetic task (ID prefix `ENHANCE-`) that goes through the same gate pipeline as user tasks. If gates fail (e.g. the addition broke a test), the pass defers and is retried in pass 2. Failures don't roll back the user-task work that came before — only the additions are at risk.

## Execute

```bash
test -f .fullauto/config.json || fullauto init

# Pull the first token to decide mode. Use shell parameter expansion rather
# than `awk` so we don't need to assume awk is installed in unusual envs.
first="${ARGUMENTS%% *}"

if [ -z "$first" ]; then
  echo "Usage: /fullauto <tasks-file>     OR     /fullauto <description>" >&2
  exit 2
fi

case "$first" in
  *.md|*/*)
    if [ -f "$first" ]; then
      fullauto run $ARGUMENTS
    else
      echo "Error: '$first' looks like a file path but doesn't exist." >&2
      echo "If you meant a natural-language description, rephrase as a sentence (no '/' or '.md' in the first word)." >&2
      exit 2
    fi
    ;;
  *)
    if [ -f "$first" ]; then
      # First word is bare and matches an existing file (e.g. "tasks" if file
      # `tasks` exists). Treat as run.
      fullauto run $ARGUMENTS
    else
      fullauto auto $ARGUMENTS
    fi
    ;;
esac
```

After the bash block exits, summarize the final report to the user — note any deferred / failed tasks (with their `deferReason`: `gate_failed`, `audit_failed`, `tdd_red_expected`, `verify_loop_blocks_remaining`, `subagent_error`, ...), where their logs live (`.fullauto/logs/<task-id>-attempt<N>.log`, plus the rolled-back diff at `.fullauto/logs/<task-id>-attempt<N>.patch`), and that `fullauto retry <ids>` re-queues them once the cause is fixed. Also surface the report's "Preflight warnings", "Audit findings (WARN) needing human review", "TDD red tests never turned green", "Wiring promises never fulfilled", and `FULLAUTO_TEST_CHANGE` notices — those are the items a human must look at even when every task is `done`. The CLI exits 1 when any task is unresolved, 0 only when all are `done`.

## Standalone audit

```
fullauto audit                    # HEAD vs working tree
fullauto audit --base main        # whole branch vs main
fullauto audit --json             # machine-readable
```

Runs the tree-based subset of the deterministic checks the orchestrator runs after every task — `orphan-code` / `unused-export` / `test-integrity` / `gate-integrity` — against the current working tree, without running any task. The checks that need a subagent transcript, gate output or run state (`wiring-manifest`, `test-count`, `tdd-red` / `tdd-green`, `pending-wiring`, `verify-evidence`) only run inside the orchestrator. Exit 1 on any BLOCK (2 if `--base` does not resolve; a non-git directory is reported as skipped). This is what the `/wiring-audit` skill calls, what `/verify-loop` runs as its pre-check before spawning reviewers, and what every implementer subagent is told to run before finishing.

## Notes

- Auto mode writes the planner output to `.fullauto/auto-tasks.md`. You can review/edit that file and re-run with `fullauto run .fullauto/auto-tasks.md` if you want to adjust the breakdown before execution.
- The planner never stops to ask the user for clarification — fullauto is unattended by design. Underspecified parts are resolved autonomously from project signals (README/CLAUDE.md, package manifest, recent git log) and current domain conventions; non-obvious calls are recorded in an `## Assumptions` section at the bottom of the tasks file. Skim that section after the run to review the planner's judgment.
- If `.fullauto/state.json` already exists from a prior run (crashed or in-progress), `fullauto run` and `fullauto auto` both auto-resume from it — re-issuing `/fullauto` after a crash continues from where you stopped. Pass `--force` to discard and start fresh. Tasks that ended `failed` are not retried by a resume; use `fullauto retry [ids]` (or `fullauto resume --retry-failed`) after fixing the cause.
- A deferred attempt's changes are rolled back to the task's starting tree (`rollbackOnDefer`, default on) so one broken task cannot cascade into `gate_failed` for every task after it; the diff is kept as a `.patch` next to the log and the retry prompt points at it.
- The orchestrator runs `claude -p` itself for each task — those run with `bypassPermissions` permission mode (so no tool call can stall on a permission dialog during a headless run) and inherit the user's existing skills (including `/verify-loop`, `/tdd-loop`, `/wiring-audit`) automatically.
- Behavior tasks are expected to follow TDD. The planner pairs each behavior task with a red test task (`- tdd: red`) and an impl task (`- tests: T###`); a red task's test gate is expected to fail and its files are quarantined until the green task lands. A green task must not edit the red tests except via `FULLAUTO_TEST_CHANGE: <file> — <reason>` (flagged for human review). Hand-written tasks.md files can use the same markers; without them, single-task TDD (`/tdd-loop`) is prompt-enforced and backstopped by the audit's test-count check.
- Manual prerequisites (env vars, CLI logins, billing setup, etc.) declared by the planner are surfaced before the run starts, with `[ENV]` items cross-checked against the current shell. Inside Claude Code the Bash environment is non-interactive, so the orchestrator prints the checklist and proceeds — surface it to the user yourself if any `[ENV]` items show `✗ NOT SET` so they know what to export before re-running.
