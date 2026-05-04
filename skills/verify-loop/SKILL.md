---
name: verify-loop
description: Verified self-correcting implementation loop. Combines objective verification (typecheck / test / lint — deterministic floor) with multiple independent reviewer subagents (correctness / security / design — fresh context, no implementation bias). After implementing, the loop runs project gates first, then spawns parallel reviewers, triages findings, fixes BLOCKs, and re-verifies — both objectively and subjectively — until clean or the iteration cap is reached. Stronger than pure-LLM review because it (1) grounds each cycle in deterministic gates that catch what reviewers miss (broken builds, regressions), (2) threads the implementer's intent statement through every reviewer so they don't keep re-flagging intentional choices, and (3) tells re-review reviewers exactly which prior BLOCKs to verify so subtle un-fixes don't slip through. TRIGGER when the user signals a quality bar that justifies the extra cost — phrases like "꼼꼼히", "신중하게", "제대로", "제대로 해줘", "확실히", "똑바로", "프로덕션", "production-ready", "검증", "검증하면서", "리뷰 받으면서", "loop으로", "verify loop", "review loop", "self-review", or when the user explicitly invokes `/verify-loop`. Also TRIGGER when the user is implementing something with high blast radius (auth, payments, security boundaries, schema migrations, public APIs) and has not opted out. SKIP for trivial edits (typo fix, doc update, single-line change), exploratory/throwaway code, when the user says "quickly" / "대충" / "빨리", and when the user has explicitly opted out of verification for this task.
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

A loop that combines **objective verification** (typecheck / test / lint — deterministic floor) with **independent reviewer subagents** (correctness / security / design — fresh context, no implementation bias). Reviewers see green code, fresh context, and the implementer's stated intent — not their own re-discovered assumptions.

## When this skill is active

- You are the **implementer**.
- Reviewers are **separate `Agent` invocations** with `subagent_type: general-purpose`. Fresh context, no view of the implementation conversation.
- Objective gates are shell commands you run yourself (typecheck, test, lint, build) — they catch regressions that pure-LLM review can miss.

## The loop in one picture

```
  Phase B: Implement + capture intent statement
       ↓
  Phase C: Run objective gates (typecheck / test / lint)
       ↓ all green
  Phase D: Spawn reviewers in parallel (correctness / security / design)
       ↓
  Phase E: Triage → BLOCK / WARN / INFO
       ↓ any BLOCK?
       ├─ yes → Phase F: Fix BLOCKs → goto Phase C   (≤ 3 cycles)
       └─ no  → Phase G: Final report
```

## Phase A — Plan (optional, for non-trivial tasks)

Skip for clearly mechanical work (rename, single-file fix, translated string). Otherwise:

1. Sketch a short plan in your own words (3–8 bullets).
2. State assumptions and unknowns explicitly.
3. Proceed to Phase B. Plan validation belongs to the user, who has product context — don't burn a reviewer cycle on it.

## Phase B — Implement + Intent statement

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

2. **Spawn 2–3 reviewers in parallel** in a single message with multiple `Agent` tool calls. Default reviewer set:

   - **Correctness reviewer** — bugs, broken behavior, missing edge cases, type/contract violations, error handling gaps, race conditions, **untested critical paths** (a critical path with no test coverage is a BLOCK in itself, even when gates pass — gates only verify what tests exist for).
   - **Security reviewer** — input validation, auth/authz boundaries, secrets handling, injection vectors, unsafe deserialization, missing rate limits. Skip if the change has no security surface (pure UI styling, doc edit).
   - **Design reviewer** (only when relevant) — for UI changes (a11y, layout, theme tokens, i18n keys), public API changes (naming, backward compat), or architectural changes (coupling, abstraction level).

   Each reviewer gets the **Reviewer Prompt Template** below, with `{INTENT}`, `{FOCUS}`, `{FILES}` filled in. **Cycle 2 and beyond also includes `{PRIOR_BLOCKS}`** — see Phase F.

3. Each reviewer returns a structured finding list. Merge them, deduping when two reviewers flag the same line for the same reason.

## Phase E — Triage

| Severity | Definition | Loop behavior |
|---|---|---|
| **BLOCK** | Real bug, security hole, broken behavior, contract violation, data loss risk, untested critical path. Includes regressions of prior BLOCKs (description prefix `REGRESSION:`). | Triggers another fix-and-verify cycle |
| **WARN** | Code smell, maintainability concern, missing edge case unlikely but possible | Reported to user; not auto-fixed |
| **INFO** | Style preference, nitpick, alternative-but-not-better suggestion | Reported briefly or omitted |

If a finding is borderline BLOCK/WARN, lean WARN — the loop catches real problems, not perfection.

If a reviewer raises a BLOCK that **your intent statement already addressed**, demote to INFO with note "addressed in intent statement." If it keeps recurring across cycles, your intent statement was unclear — sharpen it for the next cycle (this is the only time you should edit the intent statement mid-loop).

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

## Phase G — Final Report

When BLOCKs are clear (or after iteration cap), report once:

```
## verify-loop 완료 (n 사이클)

🛡️ 게이트: typecheck ✓ / test ✓ / lint ✓
   (또는: typecheck ✓ / test ✗ "<오류 한 줄>" — pre-existing, 별도 추적 필요)
✅ BLOCK: 모두 해결 (n건)
⚠️ WARN (n건) — 사용자 판단 필요:
- <설명> · <파일:라인>

ℹ️ INFO (n건, 참고만):
- <설명>

다음 행동: <권장 조치 1줄, 또는 "그대로 마무리해도 됩니다.">
```

Do not reopen the loop on user-deferred WARN/INFO — those are decisions, not bugs.

## Reviewer Prompt Template

When spawning a reviewer Agent (fill `{INTENT}`, `{FOCUS}`, `{FILES}`, and on cycle 2+ `{PRIOR_BLOCKS}`):

```
You are a code reviewer with fresh eyes. You have NOT seen the implementation conversation — you only see the code in front of you. Do not assume the implementer's intent beyond what is stated below.

## Implementer's intent
{INTENT}

If a finding you're about to raise is already covered by an explicit intent statement above, do NOT raise it as BLOCK. Demote to INFO with note "addressed in intent statement," or skip entirely. The intent statement is the implementer's pre-declaration of intentional choices — challenging it costs cycles for nothing.

## Files to review
{FILES}  — read each one fully before judging.

## Focus dimension
{FOCUS}  — only one of: correctness | security | design.
Stay in your lane. If you spot something outside your dimension, mention briefly under INFO; don't dig in.

## Prior cycle context (cycle 2+ only — omit on cycle 1)
{PRIOR_BLOCKS}

The implementer claims the above were fixed in this cycle. **Specifically verify each one before doing your normal pass:**
  - For every prior BLOCK, locate the file:line in the current code and confirm the fix is correct AND complete (not papered-over with a check that's still bypassable, not relocated to a different bug, not "fixed" by deleting the test that was failing).
  - If a prior BLOCK is still present or the fix introduced a new bug, raise as BLOCK with description prefix `REGRESSION:` so the implementer knows this isn't a fresh finding.
  - If a fix is correct, you do NOT need to mention it — silence is a pass on that item.
After the prior-BLOCK pass, do your normal end-to-end review for new BLOCKs.

## Output format
For every finding, output exactly:

  [SEVERITY] <one-line description>
  └ file:line — <why this is a real problem, not a style preference>

Severities (be honest, lean conservative):
- BLOCK: a real bug, broken behavior, security hole, contract violation, data loss risk, untested critical path. The code is wrong. Use the `REGRESSION:` prefix in the description if it's a prior BLOCK that wasn't actually fixed.
- WARN: a real concern but the code probably works. Code smell, fragile pattern, missing edge case unlikely to hit.
- INFO: nitpick, style, alternative approach, intent-covered finding.

Then a one-line summary: "Found N BLOCK / N WARN / N INFO."
If you found nothing, say exactly: "No findings — code is clean for this dimension."

## Rules
- DO NOT modify any files. Review only.
- DO NOT speculate about code you cannot see. If a function is called but not shown, say so under INFO and move on.
- DO NOT pad the report. If there are no BLOCKs, don't invent them. Manufactured findings make the loop worse.
- DO NOT repeat the same finding under multiple severities.
- DO NOT raise findings already addressed in the intent statement.
- Cite specific file:line for every finding. No findings without locations.
```

When you spawn the reviewer, the `prompt` field of the `Agent` call should embed this template along with the actual values for `{INTENT}`, `{FOCUS}`, `{FILES}`, and (cycle 2+) `{PRIOR_BLOCKS}`.

## Rules

- **Reviewers are fresh agents.** New `Agent` calls every cycle. Never accumulate reviewer state — it builds bias toward defending earlier findings.
- **Reviewers don't write or edit.** Read-only. The implementer holds the only pen.
- **Gates run every cycle, before reviewers.** Reviewers are expensive context to spend on broken code; gates are the cheap deterministic floor that catches what fresh-eyes review structurally misses.
- **Iteration cap is 3.** If reviewers keep finding new BLOCKs after cycle 3, escalate to the user — that's a signal the implementer's mental model is off, and another cycle won't help.
- **Intent statement is updated, not duplicated.** If cycle 2 reveals a reviewer-misread that's worth pre-empting in cycle 3, refine the intent statement for cycle 3 rather than tacking on a parallel "clarification" block.
- **Don't paste full reviewer output to the user.** Summarize. The user invoked this skill to *avoid* reading reviewer transcripts.
- **Don't auto-fix WARN/INFO.** Hold them for the final report. Auto-fixing them muddles the next cycle's regression detection.
- **Run reviewers in parallel** by issuing multiple `Agent` calls in a single message — sequential reviews waste wall-clock time for no gain.
- **Skip the loop entirely** for changes too small to warrant it (1–2 line edits, doc-only, typo fixes). Tell the user "이 정도 변경은 verify-loop 비용이 과합니다 — 그냥 진행하겠습니다" and proceed normally.
