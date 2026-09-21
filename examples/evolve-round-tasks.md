<!-- fullauto:round=2 items=F004,F006,F010 -->

## Feature: F004 Team board: who checked in today

- [ ] T001 Make the round-1 e2e `test/team-board.e2e.test.ts` pass: group today's check-ins by member in `src/app/team/page.tsx` and render `<TeamBoard />` from `src/components/TeamBoard.tsx`
  - kind: impl
  - no test: covered by the existing round-1 e2e `test/team-board.e2e.test.ts` (the contract this task makes pass)
  - risk: medium
  - level: e2e
  - The existing test (written in round 1, T008) is the contract — do not edit it; if it is genuinely wrong emit `FULLAUTO_TEST_CHANGE: test/team-board.e2e.test.ts — <reason>`
  - Acceptance (from product.md F004 note): members who checked in today are listed with a check mark; members who have not are listed without one; an empty workspace shows "Invite your team"
  - wiring: `TeamBoard` is rendered by `src/app/team/page.tsx` in this task (the round-1 orphan-code BLOCK on `src/components/TeamBoard.tsx` is closed here)

## Feature: F006 Empty, loading, error states and a 390×844 layout pass on every view

- [ ] T002 Write failing Playwright test `e2e/empty-states.spec.ts` for the habits list empty state and the check-in error toast
  - tdd: red
  - level: e2e
  - A fresh workspace at `/habits` shows a "Create your first habit" button that opens the create form; a failed check-in (mock 500 via route interception) shows a toast with a retry action
- [ ] T003 Add the habits empty state with its CTA in `src/app/habits/page.tsx` and `loading.tsx` / `error.tsx` for the `habits` and `team` routes (depends on T002)
  - tests: T002
  - risk: low
  - `error.tsx` calls `reportError()` from `src/lib/report-error.ts` and offers a retry button
- [ ] T004 Mobile layout pass at 390×844 for `src/components/HabitRow.tsx` and `src/components/CheckInButton.tsx` (depends on T003)
  - no test: layout only; verified by the round walkthrough re-walk
  - risk: low
  - Title and check-in control stay on one row; tap target ≥ 44 px; no horizontal scroll at 390 px

## Feature: F010 Fix: check-in button submits twice on double click

- [ ] T005 Write failing integration test `test/checkins.test.ts`: a second `POST /api/checkins` for the same habit and day returns 409 `{ error: { code: "already_checked_in" } }` and leaves one row
  - tdd: red
  - level: integration
  - Exercise the real route handler through `fetch` against the Next.js test server; verify the row count with a follow-up read
- [ ] T006 Enforce one check-in per habit per day in `src/app/api/checkins/route.ts` (unique index migration on `(habitId, memberId, day)` + 409) and disable `CheckInButton` while the request is pending (depends on T005)
  - tests: T005
  - risk: medium
  - re-walk acceptance: double-click creates one row; the UI shows "Already done today" instead of a second streak increment

## Manual Prerequisites
<!-- fullauto:prerequisites -->
- [OTHER] None — fully self-contained.

## Assumptions
<!-- fullauto:assumptions -->
- The unique index is the enforcement point for F010 — project signal: `prisma/schema.prisma` already relates habit and member; the 409 shape follows the API error envelope recorded in product.md Decisions.
- F005 (reminder email) was left out of this round — it is P2 behind two defect fixes and would push the round past `maxTasksPerRound`; `/product-assess` re-evaluates it next round.
