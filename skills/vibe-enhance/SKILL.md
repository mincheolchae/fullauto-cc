---
name: vibe-enhance
description: Proactive project-fit + trend-check skill. Before or after a task, spawns an independent researcher subagent (fresh context, WebSearch enabled) that (1) absorbs the project's vibe — stack, conventions, recent direction — (2) compares the current or planned work against latest industry trends and best practices, and (3) recommends additions or refinements the user did NOT explicitly ask for but would meaningfully improve the product. The implementer (you) applies the high-value recommendations, then chains the additions through `/verify-loop` for verification. TRIGGER when the user signals they want trend-aware or above-and-beyond work — phrases like "트렌드", "최신 트렌드", "분위기에 맞나", "프로젝트와 어울리게", "더 나은 서비스", "한 단계 위로", "개선 여지", "벤치마크", "industry standard", "best practices", "above and beyond", "proactive enhance", or when the user explicitly invokes `/vibe-enhance`. Also TRIGGER when delivering a feature where the user has expressed interest in product polish (launch, demo, public release). SKIP for trivial edits, exploratory/throwaway code, when the user says "딱 시킨 것만", "scope 최소", "no extras", "빨리", "quickly", or when the user has explicitly opted out of scope expansion.
user-invocable: true
allowed-tools:
  - Agent
  - Bash(git status*)
  - Bash(git diff*)
  - Bash(git log*)
  - Bash(ls*)
  - Bash(find*)
  - Read
  - Edit
  - Write
  - Grep
  - Skill
---

# /vibe-enhance — 프로젝트 분위기 점검 & 트렌드 기반 능동 개선

A loop where a fresh researcher subagent — equipped with WebSearch — reads the project, absorbs its vibe, compares current work against the latest industry direction, and proposes high-value additions. You (the implementer) apply the proposals that are clearly worth it, then verify the new work through `/verify-loop`.

## When this skill is active

- You are the **implementer**.
- The researcher is a **separate `Agent` invocation** (`subagent_type: general-purpose`) with web access. It starts fresh with no knowledge of the user's framing or your reasoning.
- This skill is **proactive** — it intentionally suggests work outside the user's literal request. The user invoking this skill is the implicit approval to consider scope expansion. You still gate larger additions through a user check-in.

## Phase A — Decide timing & capture task statement

Determine whether you're running:

- **Pre-work**: the plan or scope is on the table but no code is written yet. The researcher reviews the plan + project, suggests scope adjustments before you start.
- **Post-work**: the change is implemented (compiles, runs). The researcher reviews the diff + project, suggests follow-up additions.

If unclear, ask the user once — pre vs. post changes what the researcher reads.

Write a one-paragraph **task statement** in your own words: what the user asked for, and what's already done. The researcher needs this to avoid re-suggesting work you have already done or that the user has explicitly scoped out.

## Phase B — Snapshot the project vibe

Before spawning the researcher, identify the surface that defines this project's vibe. Do not paste the full files — just enumerate file paths the researcher should read:

- **Stack signals**: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `composer.json`, `Gemfile`, etc. (whichever apply). Framework + version matter.
- **Conventions**: top-level `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, any `docs/` index file.
- **Direction signals**: `git log --oneline -20` to see recent themes; `git diff --stat HEAD~5..HEAD` to see where the team has been spending energy lately.
- **Surface of the change**: `git status -s` + `git diff --stat` for post-work; the planned file list for pre-work.

Cap this list to ~10 file pointers. Do not exceed — the researcher's job is to form a vibe model, not read the whole repo.

## Phase C — Spawn the researcher

Spawn **one** researcher Agent with `subagent_type: general-purpose` in a single message. Single-agent on purpose — research is correlated, parallelism here just produces overlapping suggestions.

Pass the **Researcher Prompt Template** (below), filling in:

- `{TASK_STATEMENT}` — your one-paragraph summary
- `{TIMING}` — `pre-work` or `post-work`
- `{PROJECT_FILES}` — the ~10 file pointers from Phase B
- `{CHANGE_SURFACE}` — the changed files (post-work) or planned file list (pre-work)

The researcher returns a categorized suggestion list with web sources cited.

## Phase D — Triage suggestions

The researcher tags every suggestion with one of four categories. Researchers fed WebSearch tend to bias toward novelty — you have the final say on category and on whether to act.

| Category | Definition | Default action |
|---|---|---|
| **FIT-BREAK** | The current change clashes with the project's established conventions or stack — e.g., introducing a second state library, breaking the design token system, mixing async patterns inconsistently | Apply unless the user explicitly chose the divergence |
| **ENHANCE** | A concrete, scoped addition that clearly improves the product — a11y pass, missing loading state, observability hook, sensible default, modern pattern the rest of the project already uses elsewhere. Bounded scope (≤ ~50 lines, ≤ 2 files, no new dependency). | Apply directly. No pre-apply confirmation. |
| **OPTIONAL** | Real value but exceeds the ENHANCE scope ceiling — bigger refactor, new dependency, new infra, design overhaul, or a change the project may have intentionally opted out of | Report only. Never auto-apply. |
| **TREND-NOTE** | Industry trend worth knowing but not actionable here — context only | Mention briefly in final report |

Filter aggressively. The bar is **"clearly fits THIS project as it exists today."** When borderline between ENHANCE and OPTIONAL, lean OPTIONAL — the user is the tiebreaker for scope expansion.

## Phase E — Apply (or do nothing)

**Default outcome is "no additions."** This skill exists to *consider* proactive work, not to *guarantee* it. Most well-scoped tasks in a healthy project will produce zero FIT-BREAKs and zero ENHANCEs — that is a successful run, not a failure.

If after triage there are **no FIT-BREAKs and no ENHANCEs to apply**: skip directly to Phase G with the no-op report. Do not invent work to justify the skill invocation. Do not downgrade an OPTIONAL item to ENHANCE just to have something to ship.

Otherwise, for each FIT-BREAK and ENHANCE you decide to apply:

1. Apply with `Edit` / `Write`. No mid-flight confirmation prompts — the user invoked this skill knowing it adds work. Trust the triage and proceed.
2. Keep each addition independently revertible — discrete, scoped edits, never mixed with unrelated changes. The user must be able to revert any single addition cleanly from the report alone.
3. Do not bundle OPTIONAL items into this step. Those go to the final report only — OPTIONAL is the bucket for changes too large or opinionated for the implicit approval this skill carries.

The accountability for unrequested work happens in Phase G (thorough report) and Phase F (verify-loop), not in a pre-apply prompt.

## Phase F — Verify additions via /verify-loop

The whole point of this skill is to add work the user did not explicitly ask for. That added work must clear a higher correctness bar than work the user already saw in conversation, because they have not yet seen it.

After Phase E completes, **invoke `/verify-loop`** on the additions:

```
Skill(skill: "verify-loop", args: "vibe-enhance가 방금 추가한 작업 검증: <touched files>")
```

Pass the list of files touched in Phase E. The verify-loop will run fresh-eyes correctness/security review and surface any BLOCKs.

If verify-loop flags BLOCKs you cannot resolve cleanly within one fix cycle, **revert that specific addition** rather than shipping a half-fixed proactive change. Proactive work that introduces bugs is worse than no proactive work.

If you applied no additions in Phase E, skip Phase F.

## Phase G — Final report

The user did not see these additions while you applied them, so the report is the only place they get to review your judgment. Be thorough enough that they can decide to keep, tweak, or revert each item without rereading the diff.

Pick the matching template.

**Template 1 — additions were applied:**

```
## vibe-enhance 완료

🎯 프로젝트 분위기: <한 줄 요약 — 스택, 컨벤션, 최근 방향>

✅ 적용한 추가 작업 (n개):

1. <제목>
   - 무엇을: <한 줄>
   - 어디에: <file:line 또는 file 범위>
   - 왜: <근거 한 줄 — 무엇이 좋아지는지>
   - 출처: <web URL 또는 "internal: <file:line>에서 이미 같은 패턴 사용">
   - 카테고리: FIT-BREAK | ENHANCE
   - 되돌리려면: <한 줄 — "<file>의 <함수/블록> 제거" 정도>

2. ...

📋 OPTIONAL — 적용하지 않음, 사용자 판단 필요 (n개):

1. <제목>
   - 무엇을: <한 줄>
   - 왜 OPTIONAL: <스코프가 큼 / 의도적 opt-out 가능성 / 의견이 갈릴 변경>
   - 출처: <URL>

🔭 트렌드 노트 (참고만, n개):
- <한 줄> · <source URL>

🛡️ verify-loop 결과: <BLOCK n / WARN n / INFO n>
- <BLOCK이 있었다면 어떻게 처리했는지 — 수정 / 해당 추가만 revert>

다음 행동: <권장 조치 1줄, 또는 "그대로 마무리해도 됩니다. 마음에 들지 않으면 위 '되돌리려면' 줄 참고하세요.">
```

**Template 2 — no additions (no-op run):**

```
## vibe-enhance 완료 — 추가 작업 없음

🎯 프로젝트 분위기: <한 줄 요약>

현재 작업이 프로젝트 컨벤션과 최신 트렌드 모두에 부합합니다. 추가할 만한 변경이 없어 그대로 두었습니다.

📋 OPTIONAL (사용자 판단용, n개):
- <한 줄 설명>     ← 없으면 이 섹션 자체를 생략

🔭 트렌드 노트 (참고만, n개):
- <한 줄> · <source URL>     ← 없으면 이 섹션 자체를 생략

다음 행동: 그대로 마무리해도 됩니다.
```

Do not paste researcher output verbatim. Summarize. The user invoked this skill to get curated additions or a clean bill of health, not a research transcript.

## Researcher Prompt Template

When spawning the researcher Agent, use this structure (fill `{...}`):

```
You are a project-fit and trend-research reviewer with fresh eyes. You have NOT seen the implementation conversation. Do not assume the implementer's intent.

## Task statement (what was asked / what was done)
{TASK_STATEMENT}

## Timing
{TIMING}  — "pre-work" (review the plan, before code is written) or "post-work" (review the diff, after code is written).

## Project files defining the vibe
{PROJECT_FILES}  — read each one in full to understand stack, conventions, and recent direction. At minimum cover the top-level README and/or CLAUDE.md, the package manifest, and one representative file from the change's neighborhood.

## Surface of the current change
{CHANGE_SURFACE}  — read these to understand what's actually being added.

## Your job
1. Form a one-paragraph mental model of this project's vibe: kind of product, stack, conventions, what the team has been investing in lately.
2. Form a one-paragraph mental model of the change being made.
3. Use WebSearch / WebFetch to check the current (last 12–18 months) state of best practices in this project's domain. Examples: a Next.js app touching server components → current RSC patterns; a Python async API → current async idioms; a React form component → current a11y expectations. Cite the source URL for any claim derived from the web.
4. Compare. Identify suggestions where this project would clearly be better off, AND the suggestion fits the existing vibe. Do not propose rewriting the state layer in a different lib, swapping frameworks, or any change that contradicts a stated project convention.

## Output format
For every suggestion, output exactly:

  [CATEGORY] <one-line description>
  └ where: <file or area>
  └ why: <one sentence — what improves, with evidence>
  └ source: <URL if web-derived, or "internal: project already does X elsewhere at file:line">

Categories (be honest, lean conservative):
- FIT-BREAK: the current change clashes with established project conventions or stack.
- ENHANCE: a concrete, scoped addition (≤ ~50 lines, ≤ 2 files) that clearly improves the product and fits the vibe.
- OPTIONAL: real value but larger scope; flag for user judgment.
- TREND-NOTE: trend worth knowing, not actionable here.

Then a one-line summary: "Found N FIT-BREAK / N ENHANCE / N OPTIONAL / N TREND-NOTE."
If you found nothing actionable, say exactly: "No actionable suggestions — current direction fits the project well."

## Rules
- DO NOT modify any files. Read-only.
- DO NOT recommend changes that contradict an explicit project convention visible in README / CLAUDE.md / package manifests. The project's stated direction wins over generic best practices.
- DO NOT recommend a different framework, language, or major library swap.
- DO NOT pad the report. If there are no FIT-BREAKs or ENHANCEs, do not invent them. Researchers who manufacture suggestions make this skill worse.
- Cite specific file:line for FIT-BREAK; cite specific area for ENHANCE.
- For every web-derived claim, include the source URL. Unsourced "best practice" claims are not allowed.
```

## Rules

- **No-op is a valid outcome.** Being invoked does not obligate you to add anything. If the researcher returns no actionable findings, or every finding triages to OPTIONAL/TREND-NOTE, report a clean bill of health (Template 2) and stop. Inventing work to feel productive is the failure mode this skill must avoid most.
- **Researcher is a fresh agent.** Each invocation is a new `Agent` call. Never resume across runs of this skill — accumulated context biases the vibe model.
- **Researcher does not write or edit.** Read-only + web-only. The implementer (you) holds the only pen.
- **Filter aggressively at Phase D.** WebSearch-equipped agents over-suggest novelty. The bar is "clearly fits THIS project as it exists today," not "matches the latest hype."
- **Auto-apply only small, low-risk ENHANCEs and clear FIT-BREAKs.** Anything larger surfaces to the user as OPTIONAL.
- **Always chain into `/verify-loop` after Phase E.** Proactive additions the user hasn't seen need extra scrutiny — that's the safety net for autonomous scope expansion.
- **If `/verify-loop` BLOCKs a proactive addition you can't cleanly fix in one cycle, revert that addition.** Do not ship half-fixed scope expansion.
- **Skip the skill** for changes too small or too exploratory to warrant trend research. Tell the user "이 정도 변경에는 vibe-enhance 비용이 과합니다 — 그냥 진행하겠습니다" and proceed normally.
- **Do not paste researcher output to the user.** Summarize.
- **Respect explicit opt-outs.** If the user said "딱 시킨 것만" or "no extras" earlier in the conversation, do not run this skill even if a trigger phrase appears later.
- **Web claims must be sourced.** If the researcher returns suggestions without URLs and they aren't clearly grounded in the project itself, downgrade them to TREND-NOTE.
