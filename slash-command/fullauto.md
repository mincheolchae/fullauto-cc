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

Both modes use the same per-task pipeline: each task runs in a fresh `claude -p` subagent (with `/review-loop` available), then verification gates (typecheck/test/lint) decide `done` vs `deferred`. Deferred tasks retry on a second pass; anything still unresolved is reported with reasons and log paths.

## Dispatch heuristic

The first whitespace-separated token of `$ARGUMENTS` is checked:

- **Looks like a path** (exists on disk, OR ends in `.md`, OR contains a `/`) → run mode. The token must point at a real file or the bash block errors out instead of guessing.
- **Anything else** → auto mode (the entire `$ARGUMENTS` is the description).

This means `/fullauto tasks.md --verbose` (existing file) is run mode, but `/fullauto implement the auth flow` is auto mode. If you want auto mode for something that *looks* path-y, write a sentence: `/fullauto build the file uploader`.

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
- If the planner is too unsure to decompose, it writes `AMBIGUOUS: <one specific question>` into the output file and the orchestrator surfaces the question. Re-issue `/fullauto` with a more detailed description.
- If `.fullauto/state.json` already exists from a prior run (crashed or in-progress), `fullauto run` and `fullauto auto` both auto-resume from it — re-issuing `/fullauto` after a crash continues from where you stopped. Pass `--force` to discard and start fresh.
- The orchestrator runs `claude -p` itself for each task — those run with `acceptEdits` permission mode and inherit the user's existing skills (including `/review-loop`) automatically.
