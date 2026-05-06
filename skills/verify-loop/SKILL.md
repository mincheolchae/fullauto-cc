---
name: verify-loop
description: Verified self-correcting implementation loop. Combines objective verification (typecheck / test / lint — deterministic floor) with multiple independent reviewer subagents (correctness / security / design / requirements-fit — fresh context, no implementation bias). The requirements-fit reviewer compares the task spec / acceptance criteria against the implementation and catches missing or partially-done features that pass tests but don't actually fulfill the ask. After implementing, the loop runs project gates first, then spawns parallel reviewers, triages findings, fixes BLOCKs, and re-verifies — both objectively and subjectively — until clean or the iteration cap is reached. Stronger than pure-LLM review because it (1) grounds each cycle in deterministic gates that catch what reviewers miss (broken builds, regressions), (2) threads the implementer's intent statement AND the original task requirements through every reviewer so they don't keep re-flagging intentional choices and they ground findings against what was actually requested, and (3) tells re-review reviewers exactly which prior BLOCKs to verify so subtle un-fixes don't slip through. TRIGGER when the user signals a quality bar that justifies the extra cost — phrases like "꼼꼼히", "신중하게", "제대로", "제대로 해줘", "확실히", "똑바로", "프로덕션", "production-ready", "검증", "검증하면서", "리뷰 받으면서", "loop으로", "verify loop", "review loop", "self-review", or when the user explicitly invokes `/verify-loop`. Also TRIGGER when the user is implementing something with high blast radius (auth, payments, security boundaries, schema migrations, public APIs) and has not opted out. SKIP for trivial edits (typo fix, doc update, single-line change), exploratory/throwaway code, when the user says "quickly" / "대충" / "빨리", and when the user has explicitly opted out of verification for this task.
user-invocable: true
allowed-tools:
  - Agent
  - Bash(git status*)
  - Bash(git diff*)
  - Bash(git log*)
  - Bash(git stash*)
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
  - Read
  - Edit
  - Write
  - Grep
---

# /verify-loop — Verified Implementation Loop

A loop that combines **objective verification** (typecheck / test / lint — deterministic floor) with **independent reviewer subagents** (correctness / security / design / requirements-fit — fresh context, no implementation bias). Reviewers see green code, fresh context, the implementer's stated intent, AND the original task requirements — not their own re-discovered assumptions, and not just "is the code well-written" but "does it actually deliver what was asked."

## When this skill is active

- You are the **implementer**.
- Reviewers are **separate `Agent` invocations** with `subagent_type: general-purpose`. Fresh context, no view of the implementation conversation.
- Objective gates are shell commands you run yourself (typecheck, test, lint, build) — they catch regressions that pure-LLM review can miss.

## The loop in one picture

```
  Phase B: Implement + capture intent statement + capture requirements statement
       ↓
  Phase C: Run objective gates (typecheck / test / lint)
       ↓ all green
  Phase D: Spawn reviewers in parallel (correctness / security / design / requirements-fit)
       ↓
  Phase E: Triage → BLOCK / WARN / INFO
       ↓ any BLOCK?
       ├─ yes (self-fixable) → Phase F: Fix BLOCKs → goto Phase C   (≤ 3 cycles)
       └─ no  → Phase G: Final report
                          ↑
                          └─ after iteration cap, unfixed BLOCKs escalate
                             to the user / upstream caller (e.g. fullauto
                             subagent emits FULLAUTO_RESULT: DEFER)
```

## Phase A — Plan (optional, for non-trivial tasks)

Skip for clearly mechanical work (rename, single-file fix, translated string). Otherwise:

1. Sketch a short plan in your own words (3–8 bullets).
2. State assumptions and unknowns explicitly.
3. Proceed to Phase B. Plan validation belongs to the user, who has product context — don't burn a reviewer cycle on it.

## Phase B — Implement + Intent + Requirements statements

1. Implement the change with `Edit` / `Write` / `Read`. Keep it focused — bundling unrelated changes only confuses reviewers.

2. **Capture an intent statement** (1–3 lines) before moving to verification. Reviewers don't see the conversation; they re-discover every choice from scratch — including intentional ones. The intent statement is fed into every reviewer's prompt, in every cycle, so they don't keep raising the same false-positive BLOCKs.

   Cover:
   - **What's it for** — the user-facing or product purpose, in one line.
   - **Deliberate "looks wrong" choices** — anything fresh eyes would flag that you've already considered. Examples:
     - "Endpoint is intentionally public; signup flow before auth context exists."
     - "No rate limit at this layer because the gateway enforces 100 req/min globally."
     - "No null check on `user`; type narrowing on line N already guarantees non-null."
     - "Catches all errors deliberately; this is a defense-in-depth boundary, the caller already validates."
   - **(optional) What's NOT in scope** — areas reviewers might suggest extending into. "Pagination intentionally not added — separate task."

   The second bullet is the highest-value part. If there's truly nothing intentional that fresh eyes might flag, write "No surprises — the code looks how it works." Don't fabricate.

3. **Capture a requirements statement** — what the task actually asked for, verbatim or near-verbatim. This is a *separate* artifact from the intent statement: intent is *how/why* you implemented (subjective, the implementer's frame); requirements are *what was asked* (objective, the user's frame). The Requirements reviewer (Phase D) compares one against the other to catch features that pass tests but don't actually fulfill the ask.

   Sources, in priority order:
   - **Tasks-file body** (e.g. `tasks.md` line + indented sub-bullets) when invoked from `fullauto` or a similar orchestrator. The sub-bullets are usually the acceptance criteria — file paths, method names, endpoints, contract shape — and must be quoted as-is.
   - **Linked spec / ticket / PR description** if the user referenced one in the conversation. Quote the relevant section.
   - **The user's natural-language request** from the conversation if invoked manually. Quote the actual ask, not your paraphrase of it.
   - **Inferred-from-code-only** as last resort. If you genuinely have no source-of-truth ask (e.g. "fix this bug" with no further detail), write `No explicit requirements — Requirements reviewer will be skipped this cycle.` and skip the Requirements reviewer in Phase D. **Do not invent acceptance criteria** — a fabricated spec causes false BLOCKs.

   **If a `## Prior attempt context` section exists in your subagent prompt** (fullauto re-run of a previously deferred task), every `unmet: ...` line in that block is a highest-priority requirement bullet for this pass. Quote ALL of them (not just the first) at the top of your `## Requirements` block under a `### Carried over from prior pass` sub-heading, in the same order they appear, so the Requirements reviewer makes them the first things it checks. Multiple `unmet:` lines mean prior cycle-3 had multiple unresolved BLOCKs — losing any of them means the next pass's Requirements reviewer rediscovers it from scratch (or worse, doesn't). Likewise, every `warn: ...` line in the block flags a meaningful concern the prior cycle judged non-fatal but worth surfacing — quote them under a `### Carried-over WARN signals` sub-heading inside the same `## Requirements` block (or as INFO-level intent statements) so the Correctness/Security reviewers see them as already-flagged when they re-evaluate. This is how cross-pass propagation actually works end-to-end: cycle-3-of-pass-N emits one structured DEFER with one or more `unmet:` / `warn:` lines → orchestrator stores it → buildSubagentPrompt re-injects it next pass → you (the new implementer) elevate every line back into the requirements / intent statements → reviewers prioritize them in the listed order.

   Format:

   ```
   ## Requirements (verbatim from <source>)
   <quoted task body / spec excerpt / user ask, indented or fenced — do not summarize>

   ## Implementer's coverage notes (optional, if any item was intentionally deferred or interpreted)
   - <requirement bullet> — <covered at file:line> | <deferred — reason> | <interpreted as: ... — reason>

   ## Enhancements applied this pass (optional, only when verify-loop is invoked after /vibe-enhance or other proactive additions)
   - [ENHANCE:S | ENHANCE:L] <one-line description> — <file:line> — fit citation: <existing pattern at file:line, or "table-stakes for domain X">
   ```

   The coverage notes section is the bridge to the intent statement: if a sub-bullet is intentionally NOT in the implementation (e.g. "tests live in T###" — explicitly delegated to another task), say so here so the Requirements reviewer doesn't flag it as a missing feature. Without coverage notes the reviewer will compare requirements ↔ code blindly.

   The enhancements section is the bridge to `/vibe-enhance`: when verify-loop runs *after* a proactive enhancement pass, the diff contains code that is **legitimately not in the original requirements** — it was added because vibe-enhance judged it project-fit. Listing those additions here tells the Requirements reviewer "these are deliberate, judge them as additions to the spec, not as out-of-scope drift." Without this section the reviewer would WARN every enhance applied. If verify-loop is invoked outside vibe-enhance flow, omit this section entirely.

## Phase C — Objective gates (every cycle)

Before spawning any reviewers, run the project's verification commands. Reviewers should never look at non-compiling or test-failing code; their findings would be drowned in noise — and worse, they'd miss real issues amid the syntax-error chatter.

1. **Detect runnable gates** by inspecting the project, in this order:
   - `CLAUDE.md` / `AGENTS.md` — if it documents a verify command, prefer that.
   - `package.json` `scripts` → run `typecheck` then `test` then `lint`, only if each script exists.
   - `pyproject.toml` / `pytest.ini` → `pytest -x` (or whatever the README documents).
   - `go.mod` → `go vet ./... && go test ./...`.
   - `Cargo.toml` → `cargo check && cargo test`.
   - `Makefile` → check for `make check` / `make test` targets.

2. **Run them.** Order: typecheck (fastest, surfaces type bugs) → test → lint. Bail on the first failure for speed.

3. **Triage gate results:**
   - **All green** → proceed to Phase D.
   - **Red AND your changes are likely the cause** → fix the gate failures first, then re-run from step 2. This is non-negotiable — reviewers are not asked to evaluate broken code.
   - **Red but pre-existing (your diff is unrelated)** → record as `INFO: pre-existing failure in <gate>` for the final report and proceed to Phase D. To be sure, optionally `git stash && <gate> && git stash pop` to confirm the failure was already there.

4. **No runnable gates detected.** Tell the user honestly: "No verification commands detected — running review-only mode. Manual verification required before merge." Do NOT invent a fake gate. The loop still has value (reviewer findings) but the user needs to know it's running with one wing.

5. **Cap gate self-fix at 3 attempts per cycle.** If gates keep failing after 3 fixes on the same cycle, stop and surface the failure to the user — your mental model of the test/build is off and another attempt will likely make it worse.

## Phase D — Parallel reviewers

1. **Identify the review surface:**
   - `git status -s` and `git diff --stat` — list changed files.
   - Cap surface to changed files + their immediate dependencies. Do not ask reviewers to read the entire repo.

2. **Spawn 2–4 reviewers in parallel** in a single message with multiple `Agent` tool calls. Default reviewer set:

   - **Correctness reviewer** — bugs, broken behavior, missing edge cases, type/contract violations, error handling gaps, race conditions, **untested critical paths** (a critical path with no test coverage is a BLOCK in itself, even when gates pass — gates only verify what tests exist for).
   - **Security reviewer** — input validation, auth/authz boundaries, secrets handling, injection vectors, unsafe deserialization, missing rate limits. Skip if the change has no security surface (pure UI styling, doc edit).
   - **Design reviewer** (only when relevant) — for UI changes (a11y, layout, theme tokens, i18n keys), public API changes (naming, backward compat), or architectural changes (coupling, abstraction level).
   - **Requirements reviewer** — task spec / acceptance criteria vs implementation. Reads the `## Requirements` block captured in Phase B and walks every line/sub-bullet against the diff to find gaps:
     - **Missing feature** — a requirement bullet has no corresponding code (BLOCK).
     - **Partial / wrong-shape** — feature exists but doesn't match the spec (e.g. spec says `GET /users/:id`, code has `POST /users` only — BLOCK; spec says response shape `{ user, token }`, code returns `{ user }` only — BLOCK).
     - **Misnamed / misplaced** — spec asks for `src/repos/user-repo.ts` but code lives in `src/services/user.ts` without justification — BLOCK if the path matters (other tasks will import it), WARN if it's likely cosmetic.
     - **Acceptance-criteria not exercised by tests** — a sub-bullet describes user-visible behavior but no test covers it — BLOCK (gates can pass without exercising the new ask).
     - **Out-of-scope additions** — code does things the requirements didn't ask for. Treat as follows:
       - If the addition is listed under `## Enhancements applied this pass` (vibe-enhance flow) → legitimate, NOT a finding. Treat the enhance entry as an extension of the spec.
       - If the addition has an `[ENHANCE:S]` / `[ENHANCE:L]` marker in the code itself → legitimate, NOT a finding.
       - Otherwise → WARN, not BLOCK (extra work isn't a regression). One-line note so the implementer/user can decide whether to keep or revert.
     - **Coverage-notes mismatches** — implementer claimed a bullet was deferred or reinterpreted, but the claim contradicts the code (e.g. coverage notes say "tests live in T010" but the diff includes inline tests — INFO, not a bug).

     **Skip this reviewer when**:
     - Phase B requirements statement is `No explicit requirements — Requirements reviewer will be skipped this cycle.` (truly vague request).
     - Trivial edit caught by the skill-wide skip rule.

   Each reviewer gets the **Reviewer Prompt Template** below, with `{INTENT}`, `{REQUIREMENTS}`, `{FOCUS}`, `{FILES}` filled in. **Cycle 2 and beyond also includes `{PRIOR_BLOCKS}`** — see Phase F.

3. Each reviewer returns a structured finding list. Merge them, deduping when two reviewers flag the same line for the same reason.

## Phase E — Triage

| Severity | Definition | Loop behavior |
|---|---|---|
| **BLOCK** | Real bug, security hole, broken behavior, contract violation, data loss risk, untested critical path, **missing required feature, wrong-shape implementation vs spec, acceptance criterion not exercised by tests**. Includes regressions of prior BLOCKs (description prefix `REGRESSION:`). | Triggers another fix-and-verify cycle |
| **WARN** | Code smell, maintainability concern, missing edge case unlikely but possible, **out-of-scope additions, cosmetic spec drift (e.g. file rename that doesn't break callers)** | Reported to user; not auto-fixed |
| **INFO** | Style preference, nitpick, alternative-but-not-better suggestion, intent-covered or coverage-notes-covered finding | Reported briefly or omitted |

If a finding is borderline BLOCK/WARN, lean WARN — the loop catches real problems, not perfection. **Exception: requirements gaps.** A clearly-asked-for feature that's missing or wrong-shape stays BLOCK even if "the code works" — passing gates while silently dropping a requirement is the failure mode this dimension exists to catch.

If a reviewer raises a BLOCK that **your intent statement OR the implementer's coverage notes already addressed**, demote to INFO with note "addressed in intent/coverage statement." If it keeps recurring across cycles, your statement was unclear — sharpen it for the next cycle (this is the only time you should edit the intent statement or coverage notes mid-loop).

**Two failure modes to specifically watch for in requirements BLOCKs:**
- *Implementer disagrees with the spec.* If you (the implementer) believe the spec is wrong, do NOT silently ignore it — that just makes the reviewer raise it again next cycle. Either (a) implement what the spec asked and add a separate INFO to the final report explaining your concern, or (b) update the requirements statement's coverage notes with `interpreted as: <X> — reason: <Y>` so the reviewer can judge whether the reinterpretation is reasonable. Do this in cycle 1 — don't burn a cycle on a fight you've already decided to have.
- *Spec is genuinely ambiguous.* fullauto's philosophy is **no AMBIGUOUS path** — never block waiting for a user decision. So when a requirement bullet has multiple reasonable readings, you (the implementer) **pick one and proceed**, in this priority order: (1) existing project signal — what does the code already do in similar places? (2) project conventions — README / CLAUDE.md / nearby modules; (3) domain best practices and recent industry conventions; (4) sensible default that minimizes blast radius. Record the choice in coverage notes as `interpreted as: <X> — reason: <project signal / convention / default — cite source if any>`. The reviewer reads coverage notes and demotes the finding to INFO if the reasoning is sound. If the same bullet keeps coming back as BLOCK across cycles despite a coverage note, treat it as a normal unfixed BLOCK — it rides the standard iteration-cap → DEFER path (see Phase F), where it propagates to the orchestrator's next pass with the unmet-requirement hint, NOT to a synchronous user prompt.

## Phase F — Fix + Re-verify (cycles 2 and 3)

If any BLOCK findings exist:

1. Tell the user in 1–2 lines what's being fixed. No transcript paste.
2. Apply fixes with `Edit` / `Write`. Scope strictly to BLOCKs — no opportunistic WARN/INFO cleanup (that widens the diff and gives the next cycle more nitpick surface, and muddles regression detection).
3. **Build the `{PRIOR_BLOCKS}` block** for the next cycle's reviewer prompt. One bullet per BLOCK, in this exact shape:

   ```
   - [BLOCK at <file:line>] <original BLOCK description>
     fix applied: <one-line description of what you changed>
   ```

   This is fed to cycle 2+ reviewers so they specifically verify these areas were resolved correctly — not just glance over them with fresh-eyes drift.

4. **Goto Phase C** (gates) → Phase D (reviewers) → Phase E (triage). Increment cycle counter.

**Iteration cap: 3 cycles.** After cycle 3:
- If BLOCKs remain, **stop**, summarize remaining BLOCKs to the user, and ask for direction. Do not silently continue.
- The cap exists because reviewers occasionally fixate on something the implementer has correctly judged irrelevant. The user is the tiebreaker.
- **Escalation paths for unfixed BLOCKs** (especially requirements gaps that the implementer cannot resolve unilaterally — e.g. "spec asks for Stripe webhook handling but no API key is wired up"):
  - **Manual invocation**: surface the remaining BLOCKs in the final report and ask the user how to proceed. Do not invent assumptions.
  - **Inside a `fullauto` subagent** (or any orchestrator that owns the upstream task): the subagent must emit a single DEFER marker with a structured hint so the next pass starts with the gap surfaced rather than rediscovering it from scratch. Format:

    ```
    FULLAUTO_RESULT: DEFER <one-line cause> | unmet: <verbatim requirement bullet OR file:line of the BLOCK> | unmet: <next gap if any> | unmet: <next gap if any> | warn: <unfixed WARN of meaningful concern> | warn: <next WARN if any> | last-attempt: <one-line summary of the cycle-N fix that didn't take>
    ```

    The `unmet:` field is the most important — it lets the next pass's task subagent see exactly which requirement bullets are still open gaps before re-reading the task body, which prevents the same BLOCKs from re-surfacing through naive re-implementation. **If multiple BLOCKs remain, emit one `unmet:` field per BLOCK** in priority order, all in the same DEFER line. The next-pass implementer's `Carried over from prior pass` section will quote every one.

    **Also emit `warn:` fields for any meaningful unfixed WARN** — `warn:` items are non-fatal in the current cycle (loop didn't auto-fix them per Phase E) but in fullauto headless mode the user never sees the final report mid-run, so without explicit propagation those concerns die silently. Skip pure-cosmetic WARNs; include WARNs that flag real edge cases, missing-but-low-priority error handling, security smells one rung below BLOCK, or design concerns the next implementer might want to weigh while picking up the task. Cap at 5 `warn:` lines to keep the marker readable; if you have more than that, the implementer's mental model needs a different intervention than carry-over.

    (Legacy single-`unmet:` markers and bare `DEFER <reason>` still parse, but they lose the multi-gap propagation benefit — older runs that emitted `also-unmet: <count>` count as legacy.) fullauto's marker parser carries the entire defer line verbatim into next pass via deferDetail, so any `|`-delimited field structure rides through unchanged. This is the "feedback to the side that gave the work" path the user asked for — the implementer side cannot fix it, so it's bounced back upstream cleanly rather than silently passing.
  - In both cases, prior BLOCKs are listed in the final report with their last-cycle fix attempt summarized so the receiving side has full context.

## Phase G — Final Report

When BLOCKs are clear (or after iteration cap), report once:

```
## verify-loop 완료 (n 사이클)

🛡️ 게이트: typecheck ✓ / test ✓ / lint ✓
   (또는: typecheck ✓ / test ✗ "<오류 한 줄>" — pre-existing, 별도 추적 필요)
🎯 요구사항 충족도: <전부 충족 | 부분 충족 (n/m) | 검증 안 됨(요구사항 미캡처)>
   (부분 충족인 경우 미충족 요구사항 한 줄씩 — 이건 cycle 안에서 못 푼 것)
✅ BLOCK: 모두 해결 (n건)
   (또는: ❌ BLOCK 미해결 (n건) — 사이클 cap 도달, 아래 권한 필요한 항목 참고)
⚠️ WARN (n건) — 사용자 판단 필요:
- <설명> · <파일:라인>

ℹ️ INFO (n건, 참고만):
- <설명>

다음 행동: <권장 조치 1줄, 또는 "그대로 마무리해도 됩니다.">
   (BLOCK 미해결이면: "<BLOCK 항목>은 implementer 권한 밖 — 사용자 결정 / 외부 dep 필요")
```

If invoked inside a `fullauto` subagent and BLOCKs remain after iteration cap, additionally emit the structured DEFER marker (Phase F format):

```
FULLAUTO_RESULT: DEFER <cause> | unmet: <requirement bullet or file:line> | unmet: <next gap if any> | warn: <unfixed WARN of meaningful concern> | last-attempt: <cycle-N fix summary>
```

Emit one `unmet:` per remaining BLOCK in priority order — all of them, not just the top one — so the next pass starts with the full open-gap list. Also emit `warn:` lines (cap 5) for unfixed WARNs that the next implementer should weigh while re-attempting; pure cosmetic WARNs can be skipped. Do NOT emit a bare `DEFER <reason>` if you have structured hints available — propagation matters.

Do not reopen the loop on user-deferred WARN/INFO — those are decisions, not bugs.

## Reviewer Prompt Template

When spawning a reviewer Agent (fill `{INTENT}`, `{REQUIREMENTS}`, `{FOCUS}`, `{FILES}`, and on cycle 2+ `{PRIOR_BLOCKS}`):

```
You are a code reviewer with fresh eyes. You have NOT seen the implementation conversation — you only see the code in front of you. Do not assume the implementer's intent beyond what is stated below.

## Implementer's intent
{INTENT}

If a finding you're about to raise is already covered by an explicit intent statement above, do NOT raise it as BLOCK. Demote to INFO with note "addressed in intent statement," or skip entirely. The intent statement is the implementer's pre-declaration of intentional choices — challenging it costs cycles for nothing.

## Original requirements (what the user/task actually asked for)
{REQUIREMENTS}

This is the source-of-truth ask. The intent statement above is the implementer's frame; the requirements block is the user's frame. Use it as follows depending on your focus dimension:
  - If your focus is `requirements`: this is your **primary** check surface. Walk every requirement bullet against the diff and flag missing / partial / wrong-shape / acceptance-criteria-not-exercised gaps as described in your focus instructions.
  - If your focus is `correctness` / `security` / `design`: use this as **context** to ground your findings. A spec mismatch that lands in your dimension (e.g. spec says input must be sanitized → security; spec mandates a specific contract → correctness) is fair game. Do NOT systematically re-walk the spec — that's the requirements reviewer's job.
  - If the requirements block says it was skipped, treat it as absent and don't speculate about what the spec "probably" said.

## Files to review
{FILES}  — read each one fully before judging.

## Focus dimension
{FOCUS}  — only one of: correctness | security | design | requirements.
Stay in your lane. If you spot something outside your dimension, mention briefly under INFO; don't dig in.

If your focus is `requirements`, your job is specifically:
  1. For every requirement bullet (or sentence) in `{REQUIREMENTS}`, locate where it is implemented in the diff. If it's not implemented and not explicitly deferred in the implementer's coverage notes, raise BLOCK.
  2. For every implemented requirement, check that the *shape* matches — file path, function/method name, HTTP verb + route, response shape, parameter list, behavior described in sub-bullets. Mismatches that other tasks/callers will depend on are BLOCK; cosmetic ones are WARN.
  3. For every acceptance-criterion sub-bullet that describes user-visible behavior, check that a test exercises it. No test = BLOCK (gates can pass without exercising the new ask).
  4. Note any code that does things the requirements did NOT ask for. Apply this filter:
     - Listed under `## Enhancements applied this pass` in the requirements block → legitimate, do NOT raise.
     - Has an `[ENHANCE:S]` or `[ENHANCE:L]` marker in the code → legitimate, do NOT raise.
     - Otherwise → WARN (extra work isn't a regression, but the user should see the list).
  5. Do NOT flag style, naming, or implementation-detail choices unless they directly contradict a requirement bullet.
  6. If a requirement bullet has multiple reasonable readings AND the implementer's coverage notes record a chosen interpretation with a reason (`interpreted as: <X> — reason: <Y>`), evaluate whether the reasoning is sound (cites project signal / convention / sensible default). If sound → demote to INFO. Only raise BLOCK if the interpretation is unreasonable or contradicts another requirement bullet. fullauto is unattended — do NOT demand the user resolve ambiguity, the implementer's role is to pick reasonably.

## Prior cycle context (cycle 2+ only — omit on cycle 1)
{PRIOR_BLOCKS}

The implementer claims the above were fixed in this cycle. **Specifically verify each one before doing your normal pass:**
  - For every prior BLOCK, locate the file:line in the current code and confirm the fix is correct AND complete (not papered-over with a check that's still bypassable, not relocated to a different bug, not "fixed" by deleting the test that was failing, not "fixed" by silently dropping a requirement bullet).
  - If a prior BLOCK is still present or the fix introduced a new bug, raise as BLOCK with description prefix `REGRESSION:` so the implementer knows this isn't a fresh finding.
  - If a fix is correct, you do NOT need to mention it — silence is a pass on that item.
After the prior-BLOCK pass, do your normal end-to-end review for new BLOCKs.

## Output format
For every finding, output exactly:

  [SEVERITY] <one-line description>
  └ file:line — <why this is a real problem, not a style preference>

For requirements-focus findings, also include a third line citing the spec:
  └ spec: "<exact quoted requirement text or sub-bullet>"

Severities (be honest, lean conservative):
- BLOCK: a real bug, broken behavior, security hole, contract violation, data loss risk, untested critical path, **missing or wrong-shape required feature, untested acceptance criterion**. The code is wrong or incomplete vs the ask. Use the `REGRESSION:` prefix in the description if it's a prior BLOCK that wasn't actually fixed.
- WARN: a real concern but the code probably works. Code smell, fragile pattern, missing edge case unlikely to hit, out-of-scope additions, cosmetic spec drift.
- INFO: nitpick, style, alternative approach, intent-covered finding, coverage-notes mismatch that doesn't change behavior.

Then a one-line summary: "Found N BLOCK / N WARN / N INFO."
If you found nothing, say exactly: "No findings — code is clean for this dimension."

## Rules
- DO NOT modify any files. Review only.
- DO NOT speculate about code you cannot see. If a function is called but not shown, say so under INFO and move on.
- DO NOT pad the report. If there are no BLOCKs, don't invent them. Manufactured findings make the loop worse.
- DO NOT repeat the same finding under multiple severities.
- DO NOT raise findings already addressed in the intent statement OR the implementer's coverage notes.
- DO NOT invent requirements that aren't in `{REQUIREMENTS}`. If the spec is silent on something, the implementer's choice stands.
- Cite specific file:line for every finding. No findings without locations. Requirements-focus findings additionally cite the spec text.
```

When you spawn the reviewer, the `prompt` field of the `Agent` call should embed this template along with the actual values for `{INTENT}`, `{REQUIREMENTS}`, `{FOCUS}`, `{FILES}`, and (cycle 2+) `{PRIOR_BLOCKS}`.

## Rules

- **Reviewers are fresh agents.** New `Agent` calls every cycle. Never accumulate reviewer state — it builds bias toward defending earlier findings.
- **Reviewers don't write or edit.** Read-only. The implementer holds the only pen.
- **Gates run every cycle, before reviewers.** Reviewers are expensive context to spend on broken code; gates are the cheap deterministic floor that catches what fresh-eyes review structurally misses.
- **Iteration cap is 3.** If reviewers keep finding new BLOCKs after cycle 3, escalate to the user — that's a signal the implementer's mental model is off, and another cycle won't help.
- **Intent and requirements statements are updated, not duplicated.** If cycle 2 reveals a reviewer-misread that's worth pre-empting in cycle 3, refine the intent statement (or add a coverage note in the requirements statement) for cycle 3 rather than tacking on a parallel "clarification" block. The requirements statement's *quoted* portion should NEVER be edited (it's the source-of-truth ask) — only the implementer's coverage notes underneath.
- **Don't paste full reviewer output to the user.** Summarize. The user invoked this skill to *avoid* reading reviewer transcripts.
- **Don't auto-fix WARN/INFO.** Hold them for the final report. Auto-fixing them muddles the next cycle's regression detection.
- **Don't fix requirements gaps by deleting the requirement.** If the spec asks for a feature you can't implement this cycle, your fix is to add a coverage note (`deferred — reason: ...`) and propagate to the final report / DEFER marker, NOT to silently drop the bullet from the requirements statement. Editing the quoted spec is a self-inflicted false-pass.
- **Requirements reviewer is conditional, not optional.** Run it whenever Phase B captured an explicit requirements statement. Skip *only* when the requirements statement is the literal sentinel "No explicit requirements — Requirements reviewer will be skipped this cycle." or the entire skill is being skipped for a trivial edit.
- **Run reviewers in parallel** by issuing multiple `Agent` calls in a single message — sequential reviews waste wall-clock time for no gain.
- **Skip the loop entirely** for changes too small to warrant it (1–2 line edits, doc-only, typo fixes). Tell the user "이 정도 변경은 verify-loop 비용이 과합니다 — 그냥 진행하겠습니다" and proceed normally.
