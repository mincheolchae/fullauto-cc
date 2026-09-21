---
description: "Run the fullauto verified implementation loop over the current feature's tasks.md (replaces /speckit-implement)"
---

# Full Auto Run

Drive the current feature's `tasks.md` to completion with **fullauto-cc**
instead of the single-session `/speckit-implement` walk: one fresh `claude -p`
subagent per task, deterministic gates (typecheck / test / lint) plus a
deterministic post-task audit (orphan code, test integrity, gate-config
tampering, TDD red/green), adaptive `/verify-loop` depth per task, and a
resumable `.fullauto/state.json` queue.

## User Input

```text
$ARGUMENTS
```

Extra flags in the user input are forwarded verbatim to `fullauto run`
(for example `--verbose`, `--vibe-enhance`, `--force`, `--verify full`).
If the input contains `--verify <mode>`, that value wins over the default
`--verify adaptive` below.

## Prerequisites

1. `fullauto` must be on PATH. Check with `command -v fullauto`. If it is
   missing, stop and tell the user to install fullauto-cc first:

   ```bash
   git clone https://github.com/mincheolchae/fullauto-cc.git
   cd fullauto-cc && npm install && npm run build && npm link
   ```

2. `tasks.md` must exist for the active feature. If it does not, stop and
   tell the user to run __SPECKIT_COMMAND_TASKS__ first.

## Steps

1. **Resolve the feature directory.** Run from the repository root:

   ```bash
   .specify/scripts/bash/check-prerequisites.sh --json --require-tasks
   ```

   Parse `FEATURE_DIR` from the JSON output. All later paths are absolute
   under `FEATURE_DIR`. If the script reports that `tasks.md` is missing,
   stop (see Prerequisites).

2. **Ensure fullauto is initialized in this project.**

   ```bash
   test -f .fullauto/config.json || fullauto init
   ```

   If `fullauto init` just ran, tell the user in one line that
   `.fullauto/config.json` was created with default gates
   (`npm run typecheck` / `npm test` / `npm run lint` / `npm run test:e2e`,
   each `--if-present`, plus the Convex service and codegen gate of the
   default `convex` preset) and that they should review the `gates` array
   so it matches this project's stack (pytest / go test / cargo test / ...;
   `fullauto init --backend none` for a plain typecheck/test/lint/e2e set).
   Do not wait for confirmation — fullauto is unattended by design — but do
   surface the note.

3. **Run the loop.**

   ```bash
   fullauto run "$FEATURE_DIR/tasks.md" --verify adaptive
   ```

   (Append the user's extra flags after `--verify adaptive`; a later
   `--verify` flag from the user overrides the default.)

   The orchestrator prints the Manual Prerequisites checklist first (env
   vars marked ✓ / ✗ against the current shell), then a per-task line as
   each task finishes. Let it run to completion; it is resumable — if the
   session is interrupted, re-running this command resumes from
   `.fullauto/state.json`.

4. **Summarize the result.** Read `.fullauto/state.json` and report:

   - Counts: `done` / `deferred` / `failed` / `pending`.
   - For every task that is not `done`: its ID, title, `deferReason`
     (`gate_failed`, `audit_failed`, `tdd_red_expected`,
     `verify_loop_blocks_remaining`, `subagent_error`, ...), the last
     attempt's `deferDetail` (this is where audit findings and `unmet:`
     requirement bullets live), the log path
     `.fullauto/logs/<task-id>-attempt<N>.log`, and the rolled-back diff
     `.fullauto/logs/<task-id>-attempt<N>.patch` when present.
   - Any "Preflight warnings", "Audit findings (WARN) needing human review",
     "TDD red tests never turned green", "Wiring promises never fulfilled",
     or `FULLAUTO_TEST_CHANGE` notices from the final report — these are
     the items a human must look at.
   - Which `[ENV]` prerequisites showed ✗ NOT SET, if any.
   - The next step: `fullauto retry <ids>` re-queues `failed` tasks after
     the cause is fixed (a plain resume does not retry them); `fullauto run
     --force` starts over after editing `tasks.md`.

   Keep the summary short. The user runs this command to avoid reading
   subagent transcripts; point them to the log files instead of pasting them.

5. **Do not mark tasks `[X]` in `tasks.md` yourself.** fullauto keeps its
   own state in `.fullauto/state.json`; gates and the audit decide `done`,
   not a checkbox. If the user wants `tasks.md` checkboxes updated, they can
   do so after reviewing the report.

## Notes

- `--verify adaptive` picks verification depth per task from its
  classification (config/docs/test tasks and low-risk tasks get gates only;
  medium risk gets a light 2-reviewer loop; high-risk tasks such as auth /
  payments / schema / migrations get the full reviewer set). Use
  `--verify full` for the old "every task gets the full loop" behavior, or
  `--verify gates-only` to skip LLM review entirely.
- Every task is also audited deterministically after its gates run: new
  code that nothing in production imports / renders / mounts is a BLOCK,
  so are skipped / deleted / weakened tests, edited test or lint config
  (unless the task says `- touches-config:`), a TDD red task whose tests
  unexpectedly pass, and a `light` / `full` task that ends without a
  `VERIFY_LOOP_RESULT:` line. The findings are fed back into the next
  pass's prompt automatically, and the deferred attempt's changes are
  rolled back so later tasks are not dragged down by them.
- Speckit `tasks.md` is consumed as-is: `- [ ] T001 [P] [US1] ...` lines,
  `(depends on T000)` notes, and IDs beyond three digits all parse. fullauto
  additionally understands indented sub-bullets such as `- tdd: red`,
  `- tests: T###`, `- wired by: T###`, `- kind: config`,
  `- touches-config: <reason>` — see the fullauto-cc README for the marker
  reference.
