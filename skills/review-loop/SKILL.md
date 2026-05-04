---
name: review-loop
description: Self-correcting implementation loop where the main Claude implements, then spawns one or more independent reviewer subagents (fresh context, no implementation bias) to critique the work, fixes BLOCK-level findings, and re-reviews until clean or the iteration cap is reached. Reviewers run in parallel for independent dimensions (correctness, security, design) so the loop is fast despite multiple passes. TRIGGER when the user signals a quality bar that justifies the extra cost — phrases like "꼼꼼히", "신중하게", "제대로", "제대로 해줘", "확실히", "똑바로", "프로덕션", "production-ready", "리뷰 받으면서", "검증하면서", "loop으로", "review loop", "self-review", or when the user explicitly invokes `/review-loop`. Also TRIGGER when the user is implementing something with high blast radius (auth, payments, security boundaries, schema migrations, public APIs) and has not opted out. SKIP for trivial edits (typo fix, doc update, single-line change), exploratory/throwaway code, when the user says "quickly" / "대충" / "빨리", and when the user has explicitly opted out of review for this task.
user-invocable: true
allowed-tools:
  - Agent
  - Bash(git status*)
  - Bash(git diff*)
  - Bash(git log*)
  - Read
  - Edit
  - Write
  - Grep
---

# /review-loop — Self-Correcting Implementation Loop

A loop where the implementing Claude (you) spawns independent reviewer subagents to critique your own work, fix the real problems, and re-verify — without polluting your main context.

## When this skill is active

- You are the **implementer**.
- Reviewers are **separate `Agent` invocations** with `subagent_type: general-purpose`. They start fresh with no knowledge of your reasoning — they only see the code you point them at.
- The user's task may already be partially understood from prior conversation; you bring it forward into this loop, the reviewers do not.

## Phase A — Plan (optional, for non-trivial tasks)

Skip for tasks that are clearly mechanical (rename, single-file fix, add a translated string). For anything touching multiple files, an interface, or domain logic:

1. Sketch a short plan in your own words (3–8 bullets).
2. State assumptions and unknowns explicitly.
3. Proceed to Phase B. Do not spend a reviewer pass on the plan unless the user asks — plan validation is best done by the user, who has actual product context.

## Phase B — Implement

Implement the change normally using `Edit` / `Write` / `Read`. Keep it focused — don't bundle unrelated changes; the reviewers will (correctly) flag them.

When the implementation is in a reviewable state (compiles, runs, but not necessarily polished), proceed to Phase C.

## Phase C — Parallel Review (cycle 1)

1. Identify the review surface:
   - `git status -s` and `git diff --stat` to list changed files
   - Cap the surface to changed files plus their immediate dependencies. Do not ask reviewers to read the entire repo.

2. Spawn **2–3 reviewers in parallel** in a single message with multiple `Agent` tool calls. Default reviewer set:

   - **Correctness reviewer** — bugs, broken behavior, missing edge cases, type/contract violations, error handling gaps, race conditions.
   - **Security reviewer** — input validation, auth/authz boundaries, secrets handling, injection vectors, unsafe deserialization, missing rate limits. Skip if the change has no security surface (e.g., pure UI styling).
   - **Design reviewer** (only when relevant) — for UI changes (a11y, layout, theme tokens, i18n keys), public API changes (naming, backward compat), or architectural changes (coupling, abstraction level).

   Pass each reviewer the **exact same prompt template** (see "Reviewer Prompt Template" below) with the focus dimension swapped in.

3. Each reviewer returns a structured finding list. Merge them, deduping when two reviewers flag the same line for the same reason.

## Phase D — Triage

Categorize every merged finding into one of three buckets — reviewers are instructed to do this, but you have the final say:

| Severity | Definition | Loop behavior |
|---|---|---|
| **BLOCK** | Real bug, security hole, broken behavior, contract violation, data loss risk | Triggers another fix-and-review cycle |
| **WARN** | Code smell, maintainability concern, missing edge case that's unlikely but possible, suboptimal pattern | Reported to user; not auto-fixed |
| **INFO** | Style preference, nitpick, alternative-but-not-better suggestion | Reported to user briefly or omitted |

If a finding is borderline BLOCK/WARN, lean toward WARN — the loop's job is to catch real problems, not to chase perfection.

## Phase E — Fix and Re-review (cycles 2 and 3)

If there are any BLOCK findings:

1. Tell the user in 1–2 lines what's being fixed and why. Do not paste full reviewer output.
2. Apply the fixes with `Edit` / `Write`. Keep fixes scoped to the BLOCK findings — do not opportunistically address WARN/INFO in the same pass (that muddles the next review).
3. Spawn the same set of reviewers again, **as fresh `Agent` invocations** (not resuming prior ones). Each new reviewer must see the current state without prior bias.
4. Increment cycle counter.

**Iteration cap: 3 cycles.** After cycle 3:
- If BLOCKs remain, **stop the loop**, summarize remaining BLOCKs to the user, and ask for direction. Do not silently continue.
- The cap exists because reviewers occasionally fixate on a finding the implementer has correctly judged irrelevant. The user is the tiebreaker.

## Phase F — Final Report

When BLOCKs are clear (or after iteration cap), report once to the user:

```
## 리뷰 루프 완료 (n 사이클)

✅ BLOCK: 모두 해결
⚠️ WARN (n개) — 사용자 판단 필요:
- <설명> · <파일:라인>

ℹ️ INFO (n개, 참고만):
- <설명>

다음 행동: <권장 조치 1줄, 또는 "그대로 마무리해도 됩니다.">
```

Do not reopen the loop on user-deferred WARN/INFO — those are decisions, not bugs.

## Reviewer Prompt Template

When spawning a reviewer Agent, use this structure (fill `{FOCUS}` and `{FILES}`):

```
You are a code reviewer with fresh eyes. You have NOT seen the implementation conversation — you only see the code in front of you. Do not assume the implementer's intent; review what the code actually does.

## Files to review
{FILES}  — read each one fully before judging.

## Focus dimension
{FOCUS}  — only one of: correctness | security | design.
Stay in your lane. If you spot something outside your dimension, mention it briefly under "INFO" but don't dig in.

## Output format
For every finding, output exactly:

  [SEVERITY] <one-line description>
  └ file:line — <why this is a real problem, not a style preference>

Severities (be honest, lean conservative):
- BLOCK: a real bug, broken behavior, security hole, contract violation, data loss risk. The code is wrong.
- WARN: a real concern but the code probably works. Code smell, fragile pattern, missing edge case unlikely to hit.
- INFO: nitpick, style, alternative approach. Optional reading.

Then a one-line summary: "Found N BLOCK / N WARN / N INFO."
If you found nothing, say exactly: "No findings — code is clean for this dimension."

## Rules
- DO NOT modify any files. Review only.
- DO NOT speculate about code you cannot see. If a function is called but not shown, say so under INFO and move on.
- DO NOT pad the report. If there are no BLOCKs, don't invent them. Reviewers who manufacture findings make the loop worse.
- DO NOT repeat the same finding under multiple severities.
- Cite specific file:line for every finding. No findings without locations.
```

When you spawn the reviewer, the `prompt` field of the `Agent` call should embed this template along with the actual file paths in `{FILES}` and the focus name in `{FOCUS}`.

## Rules

- **Reviewers are fresh agents, not resumed sessions.** Each cycle uses new `Agent` calls. Never accumulate reviewer state across cycles — it builds bias.
- **Reviewers do not write or edit.** They have read-only roles. The implementer (you) holds the only pen.
- **Iteration cap is 3.** No exceptions without user override. If reviewers keep finding new BLOCKs after cycle 3, that's a signal the implementer's mental model is off — escalate to the user instead of looping.
- **Don't paste full reviewer output to the user.** Summarize. The user invoked this skill to *avoid* reading reviewer transcripts.
- **Don't auto-fix WARN/INFO.** That widens the diff each cycle and gives the next reviewer more surface to nitpick. Hold WARN/INFO for the final report.
- **Run reviewers in parallel** by issuing multiple `Agent` calls in a single message — sequential reviews waste wall-clock time for no gain.
- **Skip the loop entirely** for changes too small to warrant it (1–2 line edits, doc-only, typo fixes). Tell the user "이 정도 변경은 review-loop 비용이 과합니다 — 그냥 진행하겠습니다" and proceed normally.
