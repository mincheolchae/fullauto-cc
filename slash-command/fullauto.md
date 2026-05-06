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

Both modes use the same per-task pipeline: each task runs in a fresh `claude -p` subagent (with `/verify-loop` available), then verification gates (typecheck/test/lint) decide `done` vs `deferred`. Deferred tasks retry on a second pass; anything still unresolved is reported with reasons and log paths.

Append `--vibe-enhance` to either form to layer on a proactive trend-check + improvement pass — see "Vibe-enhance modes" below.

## Dispatch heuristic

The first whitespace-separated token of `$ARGUMENTS` is checked:

- **Looks like a path** (exists on disk, OR ends in `.md`, OR contains a `/`) → run mode. The token must point at a real file or the bash block errors out instead of guessing.
- **Anything else** → auto mode (the entire `$ARGUMENTS` is the description).

This means `/fullauto tasks.md --verbose` (existing file) is run mode, but `/fullauto implement the auth flow` is auto mode. If you want auto mode for something that *looks* path-y, write a sentence: `/fullauto build the file uploader`.

Put the file path or description FIRST, flags after. `/fullauto --vibe-enhance tasks.md` would mis-dispatch to auto mode (the leading flag is the first token); `/fullauto tasks.md --vibe-enhance` works.

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

After the bash block exits, summarize the final report to the user — note any deferred / failed tasks and where their logs live (`.fullauto/logs/<task-id>-attempt<N>.log`) so the user can investigate.

## Notes

- Auto mode writes the planner output to `.fullauto/auto-tasks.md`. You can review/edit that file and re-run with `fullauto run .fullauto/auto-tasks.md` if you want to adjust the breakdown before execution.
- The planner never stops to ask the user for clarification — fullauto is unattended by design. Underspecified parts are resolved autonomously from project signals (README/CLAUDE.md, package manifest, recent git log) and current domain conventions; non-obvious calls are recorded in an `## Assumptions` section at the bottom of the tasks file. Skim that section after the run to review the planner's judgment.
- If `.fullauto/state.json` already exists from a prior run (crashed or in-progress), `fullauto run` and `fullauto auto` both auto-resume from it — re-issuing `/fullauto` after a crash continues from where you stopped. Pass `--force` to discard and start fresh.
- The orchestrator runs `claude -p` itself for each task — those run with `bypassPermissions` permission mode (so no tool call can stall on a permission dialog during a headless run) and inherit the user's existing skills (including `/verify-loop`) automatically.
- Manual prerequisites (env vars, CLI logins, billing setup, etc.) declared by the planner are surfaced before the run starts, with `[ENV]` items cross-checked against the current shell. Inside Claude Code the Bash environment is non-interactive, so the orchestrator prints the checklist and proceeds — surface it to the user yourself if any `[ENV]` items show `✗ NOT SET` so they know what to export before re-running.
