---
name: vibe-enhance
description: Proactive project-fit + convention + trend-check skill. Before or after a task, spawns an independent researcher subagent (fresh context, WebSearch enabled) that (1) absorbs the project's vibe — stack, conventions, recent direction — (2) compares the current or planned work against TWO axes — (a) the conventional / table-stakes features the project's domain expects (baseline that would surprise users if missing) and (b) latest industry trends and best practices — and (3) recommends additions or refinements the user did NOT explicitly ask for but would meaningfully improve the product. The implementer (you) applies the high-value recommendations, then chains the additions through `/verify-loop` for verification. TRIGGER when the user signals they want trend-aware or above-and-beyond work — phrases like "트렌드", "최신 트렌드", "분위기에 맞나", "프로젝트와 어울리게", "더 나은 서비스", "한 단계 위로", "개선 여지", "벤치마크", "industry standard", "best practices", "above and beyond", "proactive enhance", "관례", "필수 기능", "당연히 있어야 하는", "table stakes", or when the user explicitly invokes `/vibe-enhance`. Also TRIGGER when delivering a feature where the user has expressed interest in product polish (launch, demo, public release). SKIP for trivial edits, exploratory/throwaway code, when the user says "딱 시킨 것만", "scope 최소", "no extras", "빨리", "quickly", or when the user has explicitly opted out of scope expansion.
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

# /vibe-enhance — 프로젝트 분위기 점검 & 관례·트렌드 기반 능동 개선

A loop where a fresh researcher subagent — equipped with WebSearch — reads the project, absorbs its vibe, compares current work against **two axes** — (1) the **conventional / table-stakes features** users in this domain expect by default (the baseline that would surprise people if missing) and (2) the **latest industry trends and best practices** — and proposes high-value additions. You (the implementer) apply the proposals that are clearly worth it, then verify the new work through `/verify-loop`.

The two axes matter equally. Industry trends point at what's *new and rising*; conventions point at what's *expected by default and would be conspicuously missing if absent*. A polished product needs both — a service can be trend-aligned but still feel half-built if it skips a baseline feature its category usually has, and a service can have every conventional feature but feel stale if it ignores current best practices. The researcher must check both axes, not just one.

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

The researcher returns a categorized suggestion list — covering **both** missing table-stakes / conventional features AND trend-based improvements — with web sources cited (or, for convention claims, references to well-known peer projects / community guides).

## Phase D — Triage suggestions

The researcher tags every suggestion with one of five categories AND one axis (`convention` or `trend`). Researchers fed WebSearch tend to bias toward novelty — you have the final say on category and on whether to act.

**The bar is *fit confidence*, not size.** A 200-line addition can be ENHANCE if it merely extends a pattern the project already uses. Adding a NEW library is allowed when the addition is the conventional / current-best-practice pick for this stack AND the project signal clearly supports it (`[ENHANCE:DEP]`); a 5-line addition stays OPTIONAL if it makes an architectural pivot or picks among credible alternatives. *Swapping* an existing library is always OPTIONAL — that is a decision, not an enhancement.

**Axis tilt during triage.** Convention-axis findings (missing table-stakes features) are usually higher value than trend-axis findings of the same category — the user is more likely to thank you for adding password reset to an auth flow than for refactoring an existing flow into the latest RSC pattern. When triage is borderline, lean toward applying convention-axis ENHANCEs and lean OPTIONAL on trend-axis swaps. But the rule "swap = OPTIONAL" still holds on both axes.

| Category | Definition | Default action |
|---|---|---|
| **FIT-BREAK** | The current change clashes with the project's established conventions or stack — e.g., introducing a second state library, breaking the design token system, mixing async patterns inconsistently | Apply unless the user explicitly chose the divergence |
| **ENHANCE** (small / `[ENHANCE:S]`) | A scoped addition (a few lines, single file, obvious extension) that clearly fits the project | Apply directly |
| **ENHANCE** (large / `[ENHANCE:L]`) | A larger addition (multi-file, beyond ~50 lines) that **clearly fits** — the pattern already lives in the project (you can cite the existing file:line), OR the addition pulls in a library that is the de-facto standard / current best practice for this kind of work AND clearly fits the project's stack and direction | Apply directly. **Each large application MUST cite either the internal pre-existing pattern OR the de-facto-standard justification (current best-practice URL + why this project's stack/direction is a clean fit).** Without that citation, downgrade to OPTIONAL. |
| **ENHANCE** (dependency / `[ENHANCE:DEP]`) | Adds a NEW library/dependency that is (a) the conventional / de-facto-standard pick for this concern in this stack today (e.g., `zod` for schema validation in a TS Node project, `tanstack-query` for server state in modern React, `pydantic` for typed payloads in a Python API), AND (b) clearly fits the project's stack and direction, AND (c) does not displace an existing library doing the same job | Apply directly. MUST report under the LARGE / dedicated section with: trend/standard URL, library license, install command, bundle/footprint trade-off, and a one-line revert (uninstall + remove imports). |
| **OPTIONAL** | Genuine value but the change is the kind users typically want to consciously decide: swaps or replaces an existing library, introduces an opinionated tech choice with credible alternatives (auth provider, db, ORM, framework, state lib), pivots architecture, reasonable engineers would disagree on the direction, or the project may have intentionally opted out of it | Report only. Never auto-apply. |
| **TREND-NOTE** | Industry trend worth knowing but not actionable here — context only | Mention briefly in final report |

Filter aggressively. **When borderline between ENHANCE:L / ENHANCE:DEP and OPTIONAL, lean OPTIONAL** — the test is "could a reasonable engineer on this team disagree with this direction?" If yes, it's a decision, not an enhancement. The user is the tiebreaker for decisions.

What still disqualifies a finding from ENHANCE (any size, including DEP):
- Replaces or competes with a library the project ALREADY uses for the same concern (that is a swap, not an addition — OPTIONAL)
- Pivots architecture, deployment, or data model in a way that ripples beyond the touched code
- Is an opinionated pick with credible alternatives that reasonable engineers would disagree on (auth provider, ORM, db, full framework). Even if it's "trendy," if the choice is non-obvious, it is OPTIONAL.
- Has a "we should adopt X instead of our current Y" framing — that's a swap, not an enhancement
- The library is new/unmaintained/niche enough that calling it "standard" requires hedging

What can now qualify under `[ENHANCE:DEP]` that previously couldn't:
- Adding a missing piece of the conventional toolchain when the project clearly needs it but hasn't installed it yet (e.g., a TS API project with hand-rolled request validation → adding `zod`; a Next.js app fetching server state with bare `fetch` + `useEffect` → adding `tanstack-query`; a Python async API serializing dicts by hand → adding `pydantic`)
- Adding a library that is *required* by a convention this project is already trying to follow (e.g., the project's tests use `vitest` but the plan adds tests without `@testing-library/*` — install it)
- Adding a current-best-practice utility where the project's own recent direction (last ~10 commits) shows it would have been picked anyway

## Phase E — Apply (or do nothing)

**Default outcome is "no additions."** This skill exists to *consider* proactive work, not to *guarantee* it. Most well-scoped tasks in a healthy project will produce zero FIT-BREAKs and zero ENHANCEs — that is a successful run, not a failure.

If after triage there are **no FIT-BREAKs and no ENHANCEs to apply**: skip directly to Phase G with the no-op report. Do not invent work to justify the skill invocation. Do not downgrade an OPTIONAL item to ENHANCE just to have something to ship.

Otherwise, for each FIT-BREAK and ENHANCE (small, large, or DEP) you decide to apply:

1. Apply with `Edit` / `Write`. No mid-flight confirmation prompts — the user invoked this skill knowing it adds work. Trust the triage and proceed.
2. Keep each addition independently revertible — discrete, scoped edits, never mixed with unrelated changes. The user must be able to revert any single addition cleanly from the report alone.
3. **For every `[ENHANCE:L]` (large) application, capture extra notes** before moving on, to be surfaced in the Phase G report under a dedicated "LARGE additions" subsection:
   - **Fit citation** — the existing file:line in the project that establishes this pattern as already-used, OR (for de-facto-standard library additions handled under `[ENHANCE:L]`) the trend/standard URL and a one-line argument for why this project's stack is a clean fit. Mandatory. If you can't supply either, downgrade to OPTIONAL and don't apply.
   - **Trade-off statement** — what cost this addition brings (build time, runtime overhead, maintenance, bundle size, etc.). Even great additions have costs.
   - **Single-line revert** — exact `git revert <hash>` style command, OR file-level "remove `<file>`, restore `<file>` from HEAD~1" instruction.
4. **For every `[ENHANCE:DEP]` (new library) application, capture an extended record** to be surfaced in the same dedicated section, with these additional fields on top of the LARGE notes:
   - **Library + version** — exact name and version pinned. Run the project's package manager (`npm install`, `pnpm add`, `pip install`, etc.) so the lockfile updates correctly.
   - **License** — read it from the registry / repo (MIT, Apache-2.0, etc.). If permissive licenses are not acceptable for this project (e.g., copyleft restrictions visible in CLAUDE.md), do not apply — downgrade to OPTIONAL.
   - **Why standard** — one-line justification grounded in current best practice (with URL) AND one-line citation of the project signal (recent commit, package manifest, README direction) that says this project's stack/direction is a clean fit.
   - **Why not a swap** — explicit confirmation that no existing library in the project already covers this concern. If one does, this is a swap, not an addition — abort and re-triage as OPTIONAL.
   - **Bundle/footprint trade-off** — install size, runtime size for client libs, Node-only vs. isomorphic, etc.
   - **Single-line revert** — `<package-manager> uninstall <pkg>` plus the file revert instruction for the imports.
5. Do not bundle OPTIONAL items into this step. Those go to the final report only — OPTIONAL is the bucket for swaps, opinionated picks, architectural pivots, or any choice the user should consciously make.

The accountability for unrequested work — especially for large additions — happens in Phase G (thorough report) and Phase F (verify-loop), not in a pre-apply prompt.

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

LARGE 추가 (`[ENHANCE:L]` 또는 다중 파일 FIT-BREAK)는 사용자 시야를 더
크게 차지하니 **별도 섹션으로 prominent하게** 보고. 작은 추가는 한 묶음.

```
## vibe-enhance 완료

**프로젝트 분위기:** <한 줄 요약 — 스택, 컨벤션, 최근 방향>

**자동 적용한 작은 추가** (n개 — 작은 ENHANCE / FIT-BREAK):

1. <제목>
   - 무엇을: <한 줄>
   - 어디에: <file:line 또는 file 범위>
   - 왜: <근거 한 줄 — 무엇이 좋아지는지>
   - 출처: <web URL 또는 "internal: <file:line>에서 이미 같은 패턴 사용">
   - 카테고리 / axis: FIT-BREAK | ENHANCE:S  ·  convention | trend
   - 되돌리려면: <한 줄>

2. ...

**LARGE 자동 적용** (n개 — `[ENHANCE:L]`, 명확한 fit으로 판단됨):

> 이 섹션의 변경은 작은 ENHANCE보다 영향이 크므로, 기대와 다르면 아래
> "되돌리려면"을 참고해 빠르게 revert하세요. 큰 변경 0개면 이 섹션 생략.

1. <제목>
   - 무엇을: <2~3줄로 충분히 묘사 — 어떤 기능이 추가됐는지>
   - 어디에: <touched files 전체 리스트, 줄 범위 포함>
   - axis: convention | trend  (관례 누락 보강인지 트렌드 적용인지)
   - 왜 fit으로 판단했나: <기존 코드와의 부합 근거 — 어떤 패턴/컨벤션을 따르는지, 인용한 file:line>
   - 트레이드오프: <이 추가가 가져오는 비용 — 빌드 시간, 번들 크기, 런타임 오버헤드, 유지보수 부담 등>
   - 출처: <URL — 트렌드 근거가 된 원문, 또는 convention인 경우 RFC/peer-project/style guide 참조>
   - 되돌리려면: <명확한 한 줄 — git revert hash 또는 "rm <file>; git checkout HEAD -- <file>" 형식>

2. ...

**DEP 자동 추가** (n개 — `[ENHANCE:DEP]`, 관례상 필수 / 현행 표준):

> 새 의존성이므로 제일 먼저 살펴볼 영역. 마음에 안 들면 "되돌리려면" 한 줄로
> 즉시 제거 가능. 새 라이브러리 0개면 이 섹션 생략.

1. <라이브러리명@버전>
   - 왜 추가: <한 줄 — 어떤 concern을 표준 방식으로 해결하기 위함>
   - 어디에 적용: <touched files 리스트>
   - axis: convention | trend  (이 라이브러리가 관례상 필수라서 추가됐는지, 최신 트렌드 표준이라 추가됐는지)
   - 라이선스: <MIT / Apache-2.0 / 등>
   - 표준 근거: <URL — 이 stack에서 de-facto-standard라는 출처, 또는 axis=convention이면 해당 도메인의 표준 가이드/peer 프로젝트 인용>
   - 프로젝트 fit: <한 줄 — recent commits / 매니페스트 / README 방향성에서 자연스럽게 도출되는 이유>
   - swap 아님 확인: <한 줄 — 같은 concern을 처리하는 기존 라이브러리가 없음을 명시>
   - 트레이드오프: <설치 크기 / 번들 영향 / 유지보수 부담>
   - 되돌리려면: <`npm uninstall <pkg>` (또는 해당 PM 명령) + 변경 파일 revert 한 줄>

2. ...

**OPTIONAL — 적용하지 않음, 사용자 판단 필요** (n개):

1. <제목>
   - 무엇을: <한 줄>
   - 왜 OPTIONAL: <새 의존성 / 아키텍처 변화 / 의견이 갈리는 선택>
   - 출처: <URL>

**트렌드 노트** (참고만, n개):
- <한 줄> · <source URL>

**verify-loop 결과:** <BLOCK n / WARN n / INFO n>
- <BLOCK이 있었다면 어떻게 처리했는지 — 수정 / 해당 추가만 revert>

다음 행동: <권장 조치 1줄, 또는 "그대로 마무리해도 됩니다. 마음에 들지 않으면 위 '되돌리려면' 줄 참고하세요. LARGE 추가가 있다면 그쪽을 먼저 검토하세요.">
```

**Template 2 — no additions (no-op run):**

```
## vibe-enhance 완료 — 추가 작업 없음

**프로젝트 분위기:** <한 줄 요약>

현재 작업이 프로젝트 컨벤션과 최신 트렌드 모두에 부합합니다. 추가할 만한 변경이 없어 그대로 두었습니다.

**OPTIONAL (사용자 판단용, n개):**
- <한 줄 설명>     ← 없으면 이 섹션 자체를 생략

**트렌드 노트 (참고만, n개):**
- <한 줄> · <source URL>     ← 없으면 이 섹션 자체를 생략

다음 행동: 그대로 마무리해도 됩니다.
```

Do not paste researcher output verbatim. Summarize. The user invoked this skill to get curated additions or a clean bill of health, not a research transcript.

## Researcher Prompt Template

When spawning the researcher Agent, use this structure (fill `{...}`):

```
You are a project-fit, convention-coverage, and trend-research reviewer with fresh eyes. You have NOT seen the implementation conversation. Do not assume the implementer's intent. Your goal is to surface valuable additions the user did not explicitly request — covering BOTH (a) baseline / table-stakes features the project's domain conventionally has but this project is currently missing, AND (b) trend-based improvements aligned with current best practices.

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
3. **Convention / table-stakes axis** (do this BEFORE the trend axis). Identify the project's *domain category* in concrete terms (e.g., "subscription SaaS dashboard", "OAuth-based auth flow", "REST CRUD API", "checkout/payment surface", "real-time chat UI", "data-ingest worker", "developer-tool CLI"). For that category, enumerate the **baseline / table-stakes features that users in this category conventionally expect** — features whose absence would be conspicuous. Examples (illustrative, not exhaustive):
   - Auth flow → password reset, email verification, rate-limited login, secure session cookie flags, basic account lockout
   - Payment / checkout → idempotency keys, retry semantics, receipt or success page, webhook signature verification
   - REST API → consistent error response shape, request validation, pagination on list endpoints, basic rate-limit headers, auth + 401 handling
   - UI form → loading state, error state, empty state, basic a11y labels + focus management
   - Real-time chat → reconnect/backoff, message ordering on reconnect, typing/presence affordance if competitive
   - Background worker / ingest → retry with backoff, dead-letter or skip-on-poison-record, observable metrics

   Then check the project: which of those baseline items are clearly present, which are clearly missing, which are ambiguous. Missing baseline items are first-class suggestions — categorize them with the same triage rules as trend findings (ENHANCE:S / ENHANCE:L / ENHANCE:DEP / OPTIONAL). Mark each one with `axis: convention`.

   Convention claims must be grounded too — cite a community guide, RFC, well-known peer project (e.g., "Stripe checkout always issues an idempotency key — see <stripe docs URL>"), or a widely-followed style guide. "It's just standard" without an anchor is not allowed.

4. **Trend axis**. Use WebSearch / WebFetch to check the current (last 12–18 months) state of best practices in this project's domain. Examples: a Next.js app touching server components → current RSC patterns; a Python async API → current async idioms; a React form component → current a11y expectations. Cite the source URL for any claim derived from the web. Mark each finding with `axis: trend`.

5. Compare. Identify suggestions where this project would clearly be better off, AND the suggestion fits the existing vibe. Do not propose rewriting the state layer in a different lib, swapping frameworks, or any change that contradicts a stated project convention.

## Output format
For every suggestion, output exactly:

  [CATEGORY] <one-line description>
  └ axis: convention | trend  (REQUIRED — which axis surfaced this)
  └ where: <file or area>
  └ why: <one sentence — what improves, with evidence>
  └ fit citation: <REQUIRED for ENHANCE:L — internal file:line where the project already uses this pattern>
  └ library: <REQUIRED for ENHANCE:DEP — package name + version + license>
  └ standard ref: <REQUIRED for ENHANCE:DEP — URL showing this is the de-facto standard for this concern in this stack today>
  └ project signal: <REQUIRED for ENHANCE:DEP — concrete file or recent commit showing the project's stack/direction makes this a clean fit>
  └ swap check: <REQUIRED for ENHANCE:DEP — confirm no existing library in the project already covers this concern; if one does, downgrade to OPTIONAL>
  └ source: <URL if web-derived, OR "internal: project already does X elsewhere at file:line", OR for axis=convention "convention ref: <URL or peer-project citation>">
  └ trade-off: <REQUIRED for ENHANCE:L and ENHANCE:DEP — what cost the addition brings (build time, bundle, runtime, maintenance, install size)>

Categories (be honest, lean conservative):
- FIT-BREAK: the current change clashes with established project conventions or stack.
- ENHANCE:S: small scoped addition (a few lines, single file, obvious extension) that clearly fits.
- ENHANCE:L: larger addition (multi-file, beyond ~50 lines) that ALSO clearly fits — the pattern already lives in the project (cite the internal file:line as `fit citation`), no architectural pivot, can be reverted as one logical unit. Without a valid fit citation, downgrade to OPTIONAL.
- ENHANCE:DEP: adds a NEW external library that is the de-facto-standard / current-best-practice pick for this concern in this project's stack today, AND the project's stack/direction is a clean fit, AND no existing library in the project already covers this concern. Requires `library`, `standard ref`, `project signal`, `swap check`, and `trade-off`. Without any of these, downgrade to OPTIONAL.
- OPTIONAL: genuine value but swaps/replaces an existing library, requires architectural pivot, is an opinionated tech choice with credible alternatives (auth provider, db, ORM, full framework, state lib), reasonable engineers would disagree on direction, or the project may have intentionally opted out.
- TREND-NOTE: trend worth knowing, not actionable here.

Then a one-line summary: "Found N FIT-BREAK / N ENHANCE:S / N ENHANCE:L / N ENHANCE:DEP / N OPTIONAL / N TREND-NOTE — split: M from convention axis, K from trend axis."
If you found nothing actionable, say exactly: "No actionable suggestions — current direction fits the project well."

## Rules
- DO NOT modify any files. Read-only.
- DO NOT recommend changes that contradict an explicit project convention visible in README / CLAUDE.md / package manifests. The project's stated direction wins over generic best practices.
- DO NOT recommend a different framework, language, or major library SWAP. Replacing an existing library is OPTIONAL, never ENHANCE — even if the replacement is more popular today.
- DO NOT mark something as ENHANCE:L without a valid `fit citation` pointing to an existing project pattern. Without that anchor, you're recommending "we should adopt X," which is OPTIONAL by definition.
- DO mark a NEW library as ENHANCE:DEP (not OPTIONAL) when ALL of these hold: (a) it is the conventional / de-facto-standard tool for this concern in this stack today, (b) the project's stack/direction makes it a clean fit (cite the project signal), (c) no existing library in the project already covers this concern. Borderline cases — cases where credible alternatives exist or where reasonable engineers would disagree on which standard pick to make — stay OPTIONAL.
- DO NOT pad the report. If there are no FIT-BREAKs or ENHANCEs, do not invent them. Researchers who manufacture suggestions make this skill worse.
- Cite specific file:line for FIT-BREAK; cite specific area for ENHANCE.
- For every web-derived claim, include the source URL. Unsourced "best practice" claims are not allowed.
- For every convention-axis claim ("this kind of project usually has X"), cite an anchor: an RFC, a community guide, well-known peer project's docs, or a widely-followed style guide. "Common knowledge" without a citable anchor is not allowed.
- Run BOTH axes — convention first, then trend. If you produce only trend findings, the report is incomplete; missing baseline features are exactly what users feel as "this product is half-built." Convention misses are usually higher value than trend additions.
```

## Rules

- **No-op is a valid outcome.** Being invoked does not obligate you to add anything. If the researcher returns no actionable findings, or every finding triages to OPTIONAL/TREND-NOTE, report a clean bill of health (Template 2) and stop. Inventing work to feel productive is the failure mode this skill must avoid most.
- **Both axes run, every time.** The researcher must check (1) convention / table-stakes coverage AND (2) latest trends, in that order. A run that produces only trend findings is incomplete — convention misses are usually the highest-value additions and skipping that axis defeats the purpose of this skill. If the researcher returns no convention-axis findings, double-check that it actually evaluated baseline domain features (not just punted) before accepting the result.
- **Researcher is a fresh agent.** Each invocation is a new `Agent` call. Never resume across runs of this skill — accumulated context biases the vibe model.
- **Researcher does not write or edit.** Read-only + web-only. The implementer (you) holds the only pen.
- **Filter aggressively at Phase D.** WebSearch-equipped agents over-suggest novelty. The bar is "clearly fits THIS project as it exists today," not "matches the latest hype."
- **The auto-apply bar is *fit confidence*, not size.** A multi-file ENHANCE:L is auto-applied when (a) the pattern already lives in the project (cite the file:line) OR the addition pulls in a de-facto-standard library that clearly fits the project's stack, (b) no architectural pivot, (c) revertible as one logical unit. Adding a NEW library is allowed under `[ENHANCE:DEP]` ONLY when it is the conventional / current-best-practice pick AND the project signal supports it AND nothing in the project already covers the concern. Replacing an existing library, pivoting architecture, or picking among credible alternatives stays OPTIONAL.
- **Every LARGE auto-apply must be reported in the dedicated "LARGE 자동 적용" section** of Template 1, with fit citation, trade-off, and a clean revert command. **Every new-library auto-apply must be reported in the dedicated "DEP 자동 추가" section** with library/version/license, standard ref URL, project-fit signal, swap-check confirmation, footprint trade-off, and an exact uninstall + revert command. Buried-in-the-small-list reporting for either is a failure of this skill.
- **Always chain into `/verify-loop` after Phase E.** Proactive additions the user hasn't seen need extra scrutiny — that's the safety net for autonomous scope expansion.
- **If `/verify-loop` BLOCKs a proactive addition you can't cleanly fix in one cycle, revert that addition.** Do not ship half-fixed scope expansion.
- **Skip the skill** for changes too small or too exploratory to warrant trend research. Tell the user "이 정도 변경에는 vibe-enhance 비용이 과합니다 — 그냥 진행하겠습니다" and proceed normally.
- **Do not paste researcher output to the user.** Summarize.
- **Respect explicit opt-outs.** If the user said "딱 시킨 것만" or "no extras" earlier in the conversation, do not run this skill even if a trigger phrase appears later.
- **Web claims must be sourced.** If the researcher returns suggestions without URLs and they aren't clearly grounded in the project itself, downgrade them to TREND-NOTE.
