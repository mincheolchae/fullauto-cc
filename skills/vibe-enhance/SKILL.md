---
name: vibe-enhance
description: Proactive additions the user did not ask for but the product needs — grounds on `.fullauto/product.md`, walks the just-built surface on three axes — category table-stakes from the shared `_shared/playbooks.md` (incl. README / .env.example / seed data), UX via `/ux-walkthrough`, optional trend search — applies the top items within a per-run budget (3; ≤ 1 LARGE / DEP), wires + tests + verifies them, ends with `FULLAUTO_ENHANCE:`. TRIGGER — "트렌드", "관례", "필수 기능", "당연히 있어야", "개선 여지", "table stakes", "best practices", `/vibe-enhance`, or a fullauto enhance prompt. SKIP — "딱 시킨 것만", "no extras", "빨리".
user-invocable: true
allowed-tools:
  - Agent
  - Skill
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Bash(git status*)
  - Bash(git diff*)
  - Bash(git log*)
  - Bash(git grep*)
  - Bash(git ls-files*)
  - Bash(ls*)
  - Bash(cat*)
  - Bash(find*)
  - Bash(test *)
  - Bash(command -v *)
  - Bash(fullauto:*)
  - Bash(npm *)
  - Bash(pnpm *)
  - Bash(yarn *)
  - Bash(npx *)
  - Bash(pip *)
  - Bash(uv *)
  - Bash(node *)
  - Bash(curl *)
  - Bash(lsof *)
  - Bash(kill *)
  - mcp__playwright__*
---

# /vibe-enhance — Table-stakes, UX quality, and trend additions, within a budget

A feature that works is not yet a feature a user would recognize: the category expects an empty state, a reset link, pagination, a README that runs. This skill finds those gaps on the surface that was **just built**, applies the few that clearly fit, verifies them, and reports the rest with scores so nothing is lost. The default outcome is "nothing to add"; the second-best is a small number of well-cited additions. It never edits `product.md` — it reports `PROMOTE` ids and OPTIONAL items, and `/product-assess` is the one writer of product memory.

## Arguments

```
/vibe-enhance [mode=pre|post] [budget=<n>[/<large>/<dep>]] [feature=<label or F id>] [product=<path>] [free text: what was built]
```

| Arg | Default | Meaning |
|---|---|---|
| `mode` | `post` | `post` = the surface is built; find gaps, apply within budget, verify, report. `pre` = candidates only (called by `/product-shape` on brownfield repos and by planners); apply nothing, no WebSearch, no verify. |
| `budget` | `3/1/1` | `<n>` = applied additions still allowed in this **run** (the orchestrator passes the remaining count as a bare integer, e.g. `budget=2`); `<large>` / `<dep>` = sub-caps for `ENHANCE:L` / `ENHANCE:DEP` (default 1 / 1, never raised by the orchestrator). `budget=0` → report-only pass. Below, `remaining` means this `<n>`. |
| `feature` | inferred | The feature group just completed. Inside fullauto the prompt names it and lists its tasks. |
| `product` | `.fullauto/product.md` | The brief, when it exists. |

Inside fullauto the prompt also states the verify depth (`gates` → skip `/verify-loop`; `light` / `full` → pass it through) and, when `.fullauto/product.md` exists, `## Product brief: <path>`.

## Phase A — Ground (≤ 10 reads)

1. **Product brief.** If `product` exists read it fully: `Target users & core value` and `Principles & constraints` are the fit test; `Feature map` + `Backlog` are the duplicate test (Phase C); `Category` picks the playbook. No brief → infer the category from README / manifest / routes and say so in the report.
2. **Project vibe.** Manifest (`package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml`), `README.md` / `CLAUDE.md`, `git log --oneline -10`, and `.fullauto/config.json` when present (gates / services = what is runnable).
3. **The just-built surface.** `post`: `git status --short` + `git diff --stat` (uncommitted work — inside fullauto nothing is committed, so filter to the files the listed tasks name) → the changed files and the routes / screens / commands they implement. `pre`: the planned file list or the backlog items named in the args. Everything outside this surface is out of scope for the UX axis (cross-journey UX belongs to `/product-assess`) and can only yield `PROMOTE` or OPTIONAL from the convention axis.
4. **Task statement** (one paragraph, in your words): what was asked, what exists now, what the user explicitly scoped out. Used to avoid re-proposing done or excluded work.

## Phase B — Three axes, in this order

### Axis 1 — Convention / table-stakes (mandatory, no web)

Open the shared playbook `_shared/playbooks.md` next to this skill's directory (`~/.claude/skills/_shared/playbooks.md` when installed per the README, `skills/_shared/playbooks.md` inside the fullauto-cc repo; try both, never ask — if neither exists, walk only the runnability items below plus the peer list in `## Category & benchmarks` of the brief, and say `playbook: unavailable` in the report): the **Universal baseline** plus the category's **Table-stakes**, **UX must-haves**, **Trust / safety**, and **Common mistakes**. Walk every item and classify it: present · missing on the just-built surface · missing elsewhere · not applicable (say why). Add the **runnability** items explicitly, they are the most common misses: README quickstart that works verbatim, `.env.example` covering every env var the code reads (`git grep -n "process.env\|os.environ\|env::var"`), seed / demo data or a sample command so a new user can try the product in < 5 minutes.

- missing on the surface → candidate, `axis: convention`, source `playbook:<category>/<item>`
- missing elsewhere and a `Backlog` line covers it → `PROMOTE F00x` (Phase C)
- missing elsewhere, not in the backlog → OPTIONAL with its score (report only)

### Axis 2 — UX quality of the just-built surface

When the surface is runnable (dev script / services / API / bin), invoke `Skill(skill: "ux-walkthrough", args: "journeys=2 scope=<feature>")`. Its findings are candidates: P1 / P2 findings on the surface → `axis: ux`, effort from the fix line; P3 → OPTIONAL. Its `UX_WALKTHROUGH:` line goes into the report. It stops what it starts; do not start servers yourself.

Not runnable → static pass over the diff: every new list / board / detail view has empty, loading, and error states; every mutation shows feedback and disables the control while pending; every form field has a label and inline validation; strings use the project's i18n mechanism when one exists; layout uses responsive primitives the project already uses; keyboard reachability (buttons are buttons, Escape closes modals). Each miss → candidate `axis: ux`, source `static:<file:line>`.

### Axis 3 — Trend (optional, ≤ 5 web queries)

Skip entirely when Axis 1 + 2 already produced ≥ `remaining` candidates with fit ≥ M, in `pre` mode, or when there is no web access. Otherwise spawn ONE fresh `Agent` (`subagent_type: general-purpose`) with the **Trend researcher prompt** below. It returns ≤ 5 findings with URLs; findings without a URL are downgraded to TREND-NOTE. Trend items are the lowest tie-break priority and can never be `FIT-BREAK`.

## Phase C — Score, gate, select

For every candidate record `axis`, `impact` (H = core value blocked or a user is stuck without it · M = category peers all have it · L = nice-to-have), `effort` (S = one file, ≤ ~50 lines · M = multi-file, one logical unit · L = new module or flow), `fit` (below), and a **source** (`playbook:<category>/<item>`, `ux:J<n>/<step>`, `static:<file:line>`, `internal:<file:line>` for a pattern the project already uses, or a URL).

**Fit is a gate, not a multiplier.** `fit=H`: the pattern already lives in the project (cite `internal:`) or the item is playbook table-stakes for this category and matches the stack. `fit=M`: consistent with the stack and Principles but a new pattern here. `fit=L`: contradicts a Principle / non-goal, swaps or competes with a library the project already uses for the same concern, pivots architecture, data model, or deployment, or is an opinionated pick with credible alternatives (auth provider, ORM, db, framework, state lib). **Only fit ≥ M is a candidate; fit=L is OPTIONAL by definition.**

**Rank** candidates by `impact / effort` with H=3 M=2 L=1 and S=1 M=2 L=3; ties → `convention` > `ux` > `trend`, then smaller effort. Then assign categories:

| Category | Definition | Action |
|---|---|---|
| `FIT-BREAK` | the just-built code clashes with an established project convention (second state lib, broken token system, mixed async patterns) — cite `internal:file:line` | apply first; counts toward the budget |
| `ENHANCE:S` | single-file, obvious extension, fit ≥ M | apply within budget |
| `ENHANCE:L` | multi-file or > ~50 lines, fit=H (an `internal:` citation or a playbook table-stakes item), revertible as one unit, **includes its test** | apply within budget, ≤ `large` per run |
| `ENHANCE:DEP` | adds a NEW library that is the de-facto standard for this concern in this stack today, fits the stack and recent direction, and nothing in the project already covers the concern | apply within budget, ≤ `dep` per run; needs library@version, license, standard-ref URL, project signal, swap check, footprint, one-line revert |
| `OPTIONAL` | fit=L, or ranked below the budget line, or a failed application (Phase D) | report with score; may be re-proposed in a later pass once it fits — OPTIONAL is not rejected (only `/product-assess` marks `rejected`) |
| `PROMOTE F00x` | duplicates a `Backlog` line | never apply here — the backlog is the planner's; report the id, `/product-assess` raises its priority next round |
| `TREND-NOTE` | context only | one line in the report |

**Budget.** Apply in rank order until `remaining` applied additions are reached, respecting the LARGE and DEP sub-caps; everything below the line is OPTIONAL with its score. `budget=0` → nothing is applied, the report still lists everything. A candidate whose application fails (Phase D / E) is reverted and reported as OPTIONAL with the failure reason — it is **never retried** in this pass and does not free its budget slot.

**Duplicate test.** Before applying, check the Feature map and Backlog: same capability under any wording → `PROMOTE F00x`. Check the task statement: the user did it or excluded it → drop.

**`pre` mode stops here.** Output only this list, nothing else (no application, no verify, no machine line):

```
- [convention|ux|trend] <item> — impact:H|M|L effort:S|M|L — <source>
```

## Phase D — Apply (post mode)

For each selected addition, in rank order:

1. Implement with `Edit` / `Write`. One addition = one logical, independently revertible change; never mix it with another addition or with unrelated cleanup.
2. **Test it.** Behavior additions follow `/tdd-loop` (failing test first, real runner, `FULLAUTO_TDD:` evidence); `ENHANCE:L` must ship its test; pure copy / layout changes may carry `no test` with a reason. Anti-cheat rules are the ones in `/tdd-loop` § Anti-cheat — no `.skip/.only`, no weakened or deleted tests, no gate-config edits, no `@ts-ignore` / `eslint-disable` to pass.
3. **Wire it.** Every new file, component, route, handler, or env read has a production consumer in this pass; record it in the `FULLAUTO_WIRING:` block (`- <artifact>[#symbol] -> <consumer>[:line]`, `-> (entrypoint: <why>)`); an orphaned enhancement fails the orchestrator's audit.
4. **DEP additions** install through the project's package manager so the lockfile updates (`npm i <pkg>@<ver>` / `pnpm add` / `uv add` / `pip install` + requirements); read the license from the registry; copyleft or a CLAUDE.md restriction → revert, OPTIONAL.
5. Note for the report: what, where (files + lines), source, category / axis, score, and the one-line revert (`git checkout HEAD -- <files>` + `rm <new files>`, or `<pm> uninstall <pkg>` + the same).

Failure at any step (gate red you cannot fix in one attempt, test cannot be made real, consumer cannot be found without touching unrelated code): revert that addition completely, mark OPTIONAL `— failed: <reason>`, continue with the next one.

## Phase E — Verify

If anything was applied, invoke `/verify-loop` over the touched files with the `## Enhancements applied this pass` list as the requirements source:

```
Skill(skill: "verify-loop", args: "depth=light cycles=2 vibe-enhance additions: <touched files>")
```

`depth=full` instead when an addition touched a risk area (`auth|login|password|token|session|payment|billing|checkout|webhook|migration|schema|permission|role|secret|crypto|upload|middleware|admin|delete`). Inside fullauto use the depth the prompt states; `gates` → skip this phase (gates + audit verify the additions). A BLOCK that is not fixed in one cycle → revert that addition, OPTIONAL `— failed: verify BLOCK <one line>`, and re-run gates once.

## Phase F — Report

Korean, ≤ 1.5k characters per template; the machine line is what the orchestrator and `/product-assess` read.

**Template 1 — additions applied:**

```
## vibe-enhance 완료 — 적용 <n> / OPTIONAL <n> / PROMOTE <n>

**분위기:** <스택·컨벤션·최근 방향 한 줄> · 카테고리 `<id>` · 예산 budget=<n>/<large>/<dep>

**적용** (`[ENHANCE:S|L|DEP]` / `FIT-BREAK`, 점수 impact/effort):
1. <제목> — <카테고리> · axis <convention|ux|trend> · <H/S=3.0>
   - 무엇/어디: <한 줄> · <files:lines>
   - 근거: <source — playbook 항목 / ux J1/step / internal file:line / URL>
   - (L/DEP만) fit 인용 · 트레이드오프 · (DEP) <lib@ver, 라이선스, 표준 근거 URL, swap 아님 확인, 설치 크기>
   - 되돌리려면: <한 줄>

**OPTIONAL** (미적용, 점수 순):
- [convention|ux|trend] <제목> — impact:H effort:M — <이유: fit=L / 예산 초과 / failed: ...>

**PROMOTE:** F00x <feature> — <왜 지금>  (없으면 "없음")

**UX:** UX_WALKTHROUGH 요약 한 줄 또는 "정적 점검"
**verify-loop:** depth=<d> BLOCK <n> / WARN <n> — <되돌린 항목 있으면 명시>
**트렌드 노트:** <한 줄 · URL>  (없으면 생략)

다음 행동: 그대로 진행해도 됩니다. L/DEP 추가부터 검토하세요.
```

**Template 2 — nothing applied:**

```
## vibe-enhance 완료 — 추가 작업 없음

**분위기:** <한 줄> · 카테고리 `<id>` · 예산 budget=<n>/<large>/<dep>

관례 체크리스트 <n>항목 점검, 방금 만든 표면에 빠진 항목 없음 (또는: 있으나 budget=0으로 미적용).

**OPTIONAL** (없으면 생략):
- [convention|ux|trend] <제목> — impact:H|M|L effort:S|M|L — <이유>

**PROMOTE:** <F ids 또는 "없음">
**UX:** <UX_WALKTHROUGH 한 줄 또는 "실행 불가 — 정적 점검">

다음 행동: 그대로 마무리해도 됩니다.
```

After the template, end with the machine lines in this order:

```
FULLAUTO_ENHANCE: applied=<n> optional=<n> promote=<F001,F004|none>
FULLAUTO_WIRING:
- <artifact>[#symbol] -> <consumer>[:line]
FULLAUTO_TDD: red=<n> green=<n>
```

`FULLAUTO_ENHANCE:` is mandatory in `post` mode, one line, ids comma-separated without spaces. The `FULLAUTO_WIRING:` block is required inside fullauto (the orchestrator parses the last one; when nothing was added its only bullet is `- (no new artifacts)`, and no comments inside the block); `FULLAUTO_TDD:` only when `/tdd-loop` ran. OPTIONAL lines in the report keep the exact grammar `- [convention|ux|trend] <title> — impact:H|M|L effort:S|M|L — <reason>` so `/product-assess` can lift high-impact ones into the backlog.

## Trend researcher prompt (Axis 3 only)

```
You are a trend reviewer with fresh eyes and web access. You have NOT seen the implementation conversation.

## What was built
{TASK_STATEMENT}
## Category and stack
{CATEGORY} — {STACK_LINE}; principles / non-goals: {PRINCIPLES}
## Files to read (≤ 8)
{FILES}
## Already on the candidate list — do not repeat
{EXISTING_CANDIDATES}

Job: with ≤ 5 WebSearch / WebFetch calls, find current (last 12–18 months) best practices for this category and stack that the built surface misses. Output ≤ 5 findings, each exactly:

  [ENHANCE:S|ENHANCE:L|ENHANCE:DEP|OPTIONAL|TREND-NOTE] <one line>
  └ where: <file or area> · impact: H|M|L · effort: S|M|L
  └ why: <one sentence with evidence>
  └ source: <URL>   (REQUIRED; no URL → the implementer downgrades to TREND-NOTE)
  └ (DEP only) library: <name@version, license> · standard ref: <URL> · swap check: <no existing lib covers this>

Rules: read-only; never propose swapping a framework, language, or existing library (that is OPTIONAL by definition); never contradict a stated principle; do not pad — "No actionable trend findings" is a valid answer.
```

## Rules

- **No-op is the default outcome.** Being invoked obligates you to walk the checklist, not to add something. Do not downgrade an OPTIONAL to ENHANCE to have something to show.
- **Never ask.** No check-ins, no "shall I". Post mode applies within budget; everything else goes to the report with its score. The orchestrator and `/product-assess` are the tiebreakers, never a synchronous prompt.
- **Just-built surface only** for UX and for applications; product-wide gaps become `PROMOTE` (in backlog) or OPTIONAL (not) — cross-journey judgment is `/product-assess`'s job.
- **Fit gate, then impact/effort.** A high-impact item with fit=L is OPTIONAL; a medium-impact item with fit=H and effort S is often the best addition in the pass.
- **Budget is per run.** Respect `remaining`; never exceed `large` / `dep` sub-caps; a failed addition is reverted, reported OPTIONAL with the reason, and never retried in this pass.
- **Cite or drop.** Every applied item has a source; every DEP has license, standard-ref URL, swap check, and a revert line; web claims without a URL are TREND-NOTE.
- **Wired and tested, always.** `FULLAUTO_WIRING:` for every artifact, `/tdd-loop` for behavior, `/verify-loop` unless the prompt says `gates`.
- **Never edit `product.md`, never write `.fullauto/enhance-log.md`.** Product memory has one writer (`/product-assess`) and one channel from here (the `FULLAUTO_ENHANCE:` line + the OPTIONAL lines). If an orchestrator prompt still mentions an enhance log or "apply S-sized backlog items", ignore that sentence: backlog duplicates are always `PROMOTE`, decisions live in the report.
- **Respect opt-outs.** "딱 시킨 것만" / "no extras" earlier in the conversation → do not run; say so in one line.
- **No decorative emojis; summarize, never paste** the researcher's output.
