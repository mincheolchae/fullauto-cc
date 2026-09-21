---
name: product-assess
description: End-of-round judgment for `fullauto evolve` — reconciles the feature map from the round tasks.md + `.fullauto/state.json` (done only when all tasks are done with green gates and no audit BLOCK), verifies usability via `/ux-walkthrough` or a code-level trace, scores 0–100 on five dimensions, re-prioritizes the backlog, appends the round log, and ends with the `FULLAUTO_ASSESS:` line. Sole writer of product.md updates. TRIGGER — "라운드 평가", "제품 상태 점검", "어디까지 됐나", "assess the round", "score the product", `/product-assess`, or an evolve assess prompt. SKIP when no `.fullauto/product.md` exists.
user-invocable: true
allowed-tools:
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Skill
  - mcp__playwright__*
  - Bash(cat*)
  - Bash(ls*)
  - Bash(tail *)
  - Bash(test *)
  - Bash(date *)
  - Bash(git log*)
  - Bash(git status*)
  - Bash(git diff*)
  - Bash(git grep*)
  - Bash(git ls-files*)
  - Bash(curl *)
  - Bash(lsof *)
  - Bash(kill *)
  - Bash(npm run *)
  - Bash(npx playwright*)
  - Bash(node *)
---

# /product-assess — Did the round make the product better, and what is next?

The orchestrator knows which tasks finished; it does not know whether the product became usable. This skill turns a round's mechanical result (state.json) into product judgment: which features are really done, whether a user can complete the loop, a score with evidence, and a re-ordered backlog. It is the **only** writer of `product.md` after `/product-shape` — `/vibe-enhance` reports `PROMOTE` ids and never edits the brief; `rejected` is only ever set here. The last line of the output is a machine line the orchestrator parses; everything above it is for the human who reads the round log later.

## Arguments

```
/product-assess [product=<path>] [tasks=<path>] [state=<path>] [round=<n>] [ux=auto|on|off]
```

| Arg | Default | Meaning |
|---|---|---|
| `product` | `.fullauto/product.md` | The brief to update. |
| `tasks` | round header's file: `.fullauto/rounds/<r>/tasks.md`, else `.fullauto/tasks.md` | The round's task list (with `<!-- fullauto:round=<r> items=... -->` first line). |
| `state` | `.fullauto/state.json` | Orchestrator state for the round just run. |
| `round` | parsed from the tasks file header | Round number for the log entry. |
| `ux` | `auto` | `auto` = run `/ux-walkthrough` when it detects a runnable surface (it no-ops cleanly otherwise); `on` = force; `off` = code-level trace only. |

Missing `product` → print `product-assess: no product brief at <path> — run /product-shape first` and stop (no `FULLAUTO_ASSESS:` line). Missing `state` or `tasks` → treat the round as "0 tasks ran", reconcile nothing, still score and emit the verdict line.

## Step A — Reconcile the feature map (mechanical facts first)

1. **Round scope.** Read the first line of the tasks file: `<!-- fullauto:round=<r> items=F001,F004 -->`. The `items` ids are what this round promised. Group the task lines under each `## Feature: F00x <title>` heading → the tasks per feature. Tasks under no `F`-heading (setup, polish, `## Manual Prerequisites`) are round-level: they belong to no feature but a failure is noted in the round log.

2. **Task results.** Read `state.json`. Fields you use: `tasks[]` → `id`, `title`, `status` (`pending | in_progress | done | deferred | failed`), `kind` (`user | enhance | verify`), `feature` (heading text), `attempts[]`; last attempt = `attempts[attempts.length - 1]` → `deferReason` (`gate_failed | audit_failed | verify_loop_blocks_remaining | subagent_error | depends_on_unfinished_task | tdd_red_expected | unknown`), `deferDetail` (free text: the `FULLAUTO_RESULT: DEFER` payload with `unmet:` / `warn:` hints, or rendered audit bullets), `gateResults[]` → `name`, `passed`, `note`, `audit.findings[]` → `check`, `severity` (`block | warn | info`), `message`, `path`, `tdd` → `phase`, `failing`, `passed`, `subagentLogPath`. Top level: `redTests[]` (red TDD sets never turned green — each has `taskId`), `pendingWiring[]` (artifacts still orphaned — `artifactPath`, `wiredBy`), `placeholderEnvs[]`.

3. **Feature status rule** — apply per feature id in `items`, in this order, first match wins:
   - No `## Feature: F00x` group in the tasks file → `deferred`, note `deferred: not planned this round`.
   - Any `kind: user` task in the group has status ≠ `done` → `deferred`, note `deferred: <n>/<m> tasks done; <TaskId> <deferReason> — <first line of deferDetail>`.
   - A `kind: verify` task for this group (`VERIFY-<feature>`) exists and is not `done` → `deferred`, note `deferred: feature verify pass left BLOCKs — <first unmet:>`.
   - Any task in the group has a `redTests` entry (`redTests[].taskId` in the group) or a `pendingWiring` entry created by a task in the group → `deferred`, note `deferred: red tests never green (<taskId>)` / `deferred: orphan <artifactPath> awaiting <wiredBy>`.
   - The last attempt of any group task has `audit.findings` with `severity: block` or a `gateResults[].passed === false` without a `note` → `deferred`, note `deferred: <check or gate> — <message>`.
   - Otherwise → `done`; keep the existing note (the acceptance line) unchanged.
   A `kind: enhance` task that failed never blocks a feature; record it in the round log line instead.

4. **Enhance signals.** For every `kind: enhance` task, `tail -80 <subagentLogPath>` and take the last `FULLAUTO_ENHANCE: applied=<n> optional=<n> promote=<ids|none>` line. Collect `applied` totals and the `promote` ids for Step D. No line → `applied=0`. Also collect the OPTIONAL lines it reported — lines matching `^- \[(convention|ux|trend)\] .+ — impact:[HML] effort:[SML] — .+$` between the last `**OPTIONAL**` marker and the next `**` heading; those with `impact:H` and axis `convention` or `ux` are **lift candidates** for Step D.1a (vibe-enhance never writes the brief; this is how its product-wide findings reach memory).

5. **Write the feature-map cells** for the round's ids: `status` as decided, `round` = this round number, `note` as decided. Features not in `items` are untouched. A feature `done` in an earlier round that a UX P1 finding (Step B) breaks becomes `deferred` with note `defect: <J/step> <observed>`.

## Step B — Verify usability, not existence

`ux=on`, or `ux=auto`: invoke `Skill(skill: "ux-walkthrough", args: "journeys=4")`. It picks journeys from the feature map, starts and stops its own server, and ends with `UX_WALKTHROUGH: surface=<web|api|cli|none> journeys=<n> findings=<n> p1=<n> p2=<n> p3=<n> screenshots=<dir|none>`. Keep its findings table and task lines — Step D consumes them.

`surface=none` (or `ux=off`): do a **code-level journey trace** for the MVP loop and for every feature marked `done` this round. For each leg — onboard (entry route / first screen / first command), core action (the mutation or the main command), visible result (read-back, render, or output) — cite `file:line` evidence that (a) the entry exists and is registered / routed, (b) the handler performs the action and persists, (c) the result is read back and rendered / printed, (d) one test exercises the real entry point (`git grep -n` for the route / command in `test/`, `tests/`, `e2e/`). Table: `| leg | evidence (file:line) | test | status ✓/✗ |`. A leg with no evidence is a P1 finding in the same shape as a walkthrough row: `P1 | <feature>/<leg> | <what is missing> | <expected> | <fix task line>`.

## Step C — Score (0–100, five dimensions × 0–20)

Use the nearest anchor; pick a value between anchors only with explicit evidence, and write one evidence line per dimension citing task ids, finding ids, or file paths.

| Dimension | 0 | 10 | 20 |
|---|---|---|---|
| **Completeness vs MVP** | no round-1 feature is `done` | about half the MVP features are `done`, or the loop completes only with a workaround | every round-1 feature `done` and onboard → core action → visible result completes |
| **Usability** | server does not start, or a P1 on the core loop, or no evidence the loop can be walked | loop completes with ≥ 1 P2 on a core journey (missing feedback, dead end, confusing error) | loop completes with 0 P1 / P2 on core journeys and ≤ 2 P3 overall |
| **Robustness** | gates red, an audit BLOCK outstanding, `redTests` non-empty, or `pendingWiring` non-empty | gates green but a core journey lacks an entry-point test, or > 3 audit WARNs, or an error state missing on a core view | gates green, every core journey has an entry-point test, ≤ 3 audit WARNs, error states on every core view |
| **Polish** | no empty states, mobile layout broken, or unlabeled controls on the core form | empty / loading states on core views but mobile or a11y gaps found | empty / loading / error on all views, mobile re-walk clean, a11y basics pass, copy consistent |
| **Release readiness** | no README quickstart, or env vars read with no `.env.example` | README + `.env.example` present but no CI workflow or no deploy config | README quickstart matches the code, `.env.example` complete (compare with `git grep -n "process.env\|os.environ\|env::var"`), CI runs the gates, deploy config present |

`score = sum`. Print the five values and the total before Step D.

## Step D — Re-prioritize the backlog

Rebuild `## Backlog` from the feature map, then apply these rules in order:

1. **UX defects become work.** Each walkthrough / trace **P1** finding on a feature → that feature is `deferred` (Step A.5) and its backlog line moves to the top of P1 with `<why now>` = `P1 defect: <J/step> <observed>`. Each **P2** finding → a new feature-map row with the next free id (`F` + three digits, never reuse), `feature` = the fix title from the finding's task line, status `planned`, round `-`, note = the `re-walk acceptance` line; backlog `[P2] ... — impact:M effort:S|M — P2 defect: <J/step>`. **P3** findings fold into one umbrella row per round (`Polish pass: <n> P3 fixes from round <r>`, `[P3] ... — impact:L effort:S`) or are dropped when the cap binds.
   1a. **Lift candidates** from Step A.4: for each (max 3 per round), if no feature-map row — `done`, `planned`, `deferred`, or `rejected` — already covers the same capability under any wording, add a row with the next free id, status `planned`, round `-`, note = the reason clause, and a backlog line `[P2] F0nn <title> — impact:H effort:<from the line> — enhance round <r>: <axis> gap`. Duplicates and `rejected` matches are skipped silently.
2. **Deferred features go first inside their priority**, `<why now>` = the deferral reason. A feature deferred in **two consecutive rounds** for a reason outside autonomy (missing credentials, paid service, external account, a scope-changing product decision) → status `rejected`, note `needs human: <what>`, and a Decisions bullet `- Parked <F id> <feature> — needs human (<what>): <rationale>`. Deferred twice for a technical reason stays P1 with `<why now>` = `third attempt: <last unmet:>`.
3. **Depth before breadth.** While any MVP feature is not `done` or any core journey carries a P1 / P2, no P3 item may be in `next=`, and no new breadth row (new surface unrelated to the MVP loop) is added this round.
4. **PROMOTE.** Each `promote=` id from Step A.4 rises one level (P3 → P2, P2 → P1; never above P1) with `<why now>` = `promoted by vibe-enhance round <r>: <one clause>`. Unknown ids are ignored with a round-log note.
5. **Never re-add `rejected`; never write a backlog line for a `done` row.** A regression on a done feature is expressed as `deferred` (rule 1), not as a new row.
6. **Cap 25.** Merge small P3 rows into the umbrella row first; if still > 25, park the lowest rows (lowest priority, then lowest impact, then highest effort): status stays `planned`, `round` = `-`, note = `parked: backlog cap (round <r>)`, and they get **no** backlog line. Parked rows are re-listed automatically when the cap frees up.
7. **Order**: P1 → P2 → P3; inside a block impact H → L, then effort S → L. Every line matches `- [P1] F001 <feature> — impact:H effort:M — <why now>` with `<feature>` identical to the feature-map cell.

## Step E — Append the round log

Append one entry at the end of `## Round log` (never edit earlier entries):

```
### Round <r> — <YYYY-MM-DD>
- shipped: F001 <feature>, F002 <feature> (<done>/<planned> planned); deferred: F003 (<reason, ≤ 10 words>), F004 (not planned this round)
- tasks: <done> done / <deferred> deferred / <failed> failed; enhance: <applied> applied, promote <ids|none>, lifted <new F ids|none>; round-level failures: <TaskId reason | none>
- ux: surface=<web|api|cli|none> journeys=<n> findings=<n> (p1=<n> p2=<n> p3=<n>) → <screenshot dir | code-level trace>
- score: <total> (completeness <n> / usability <n> / robustness <n> / polish <n> / release <n>)
- verdict: <continue|ship|stop> — next: <F ids|none> — <reason>
```

`<YYYY-MM-DD>` from `date +%F`. Decisions bullets from Step D.2 (and any `needs human` blocker from Step F) are appended to `## Decisions` in the same edit.

**Safe rewrite.** Only these parts of `product.md` change: feature-map cells (`status`, `round`, `note`) and new rows, the whole `## Backlog` section, appended `## Decisions` bullets, one appended `## Round log` entry. `Concept`, `Target users & core value`, `Category & benchmarks`, `Principles & constraints` are never edited. Before writing, re-check: line 1 `# Product:`, line 2 `<!-- fullauto:product v1 -->`, the eight `##` titles unchanged and in order, table header `| id | feature | status | round | note |`, every backlog line matching `^- \[P[123]\] F\d{3} .+ — impact:[HML] effort:[SML] — .+$`, ≥ 1 backlog line, no `|` inside cells. The orchestrator validates after you and restores the pre-assess copy on failure — a restored brief loses this round's learning, so a broken rewrite is the worst outcome of this skill.

## Step F — Verdict and the machine line

Decide in this order, first match wins:

- **`stop`** when the next increment cannot be built inside autonomy: every remaining P1 needs something a person must provide (credentials, a paid service, an external account, a legal / scope decision that changes the concept), or the same P1 set was deferred in two consecutive rounds with 0 done tasks for an environmental reason. Append `- <blocker> — needs human (<what to provide>): <rationale>` to `## Decisions`. `next=none`.
- **`ship`** when all four hold: every round-1 (MVP) feature is `done`; usability is confirmed (walkthrough with `surface≠none` and 0 P1 on core journeys, or — when nothing is runnable — a code-level trace with an entry-point test per leg); no `[P1]` line remains after Step D; `score ≥ 80`. `next=none`.
- **`continue`** otherwise. `next=` = the first backlog ids in Step D order: every P1 (up to 6); if fewer than 4 P1s, fill from P2 up to 4 total; P3 only when there is no P1 / P2 at all (cap 4). Comma-separated, no spaces. Set the feature-map `round` cell of every id in `next=` to `<r+1>` (the planner may still drop the tail to fit `maxTasksPerRound`; assess re-evaluates next round).

`reason=` is one clause ≤ 120 chars, no newlines, no `|`. The last line of your output — nothing after it, not even a blank line of prose — is:

```
FULLAUTO_ASSESS: verdict=<continue|ship|stop> score=<0-100> next=<F001,F004|none> reason=<one line>
```

The parser takes the last such line and treats a missing line as `continue` with an unknown score, so a forgotten line silently costs a round.

## Output shape

```
## product-assess — Round <r>

feature map: F001 done · F002 done · F003 deferred (gate_failed T007: test/checkin.test.ts 1 failing) · F004 deferred (not planned)
ux: surface=web journeys=3 findings=3 (p1=1 p2=1 p3=1)   [or: code-level trace — 3 legs ✓, 0 ✗]
score: 62 — completeness 10 (2/4 MVP done: state T003, T005) / usability 10 (P2 J1/empty state) / robustness 12 (gates green; no e2e for check-in: git grep) / polish 10 (mobile row wrap J1) / release 20 (README, .env.example, ci.yml, vercel.json)
backlog: 11 lines (P1 3 / P2 5 / P3 3), promoted F005 → P1, new F010 (P2 defect), parked 0
decisions added: 0
round log: appended Round 2

FULLAUTO_ASSESS: verdict=continue score=62 next=F003,F001,F010 reason=MVP loop incomplete: check-in 500 on second submit and F003 gate red
```

## Rules

- **Facts before judgment.** Step A uses only state.json and the tasks file; never infer "done" from the diff or the code. A task that is `done` in state but whose feature fails the walkthrough is a `deferred` feature with a defect note — the task record stays as it is.
- **Evidence per score line.** No dimension value without a citation; when you cannot find evidence, use the lower anchor.
- **Never ask, never stall.** Ambiguity about a feature's state resolves to `deferred` with the observed reason; ambiguity about priority resolves by the Step D rules; unattended means no questions.
- **One writer.** `/vibe-enhance` and `/ux-walkthrough` report; this skill edits the brief. Their outputs are inputs here, never merged by them.
- **The `FULLAUTO_ASSESS:` line is last, always,** even on a round with 0 tasks or a failed walkthrough.
- **No decorative emojis;** ✓ ✗ are fine.
