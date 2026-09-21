# Product: Streakly
<!-- fullauto:product v1 -->

## Concept
habit tracker for remote teams

## Target users & core value
- Primary user: a member of a 3–15 person remote team who wants a personal routine to stay visible to teammates
- Secondary user: the team lead who sets up the workspace and nudges the team
- Job to be done: keep daily habits going when nobody is in the same room to notice
- Core value: a check-in today is visible to the team today — accountability without meetings
- Not for: solo users who want a private habit journal; enterprise HR wellness programs

## Category & benchmarks
- Category: `productivity-tool` (secondary: `saas-dashboard`)
- Peers: Habitify (https://www.habitify.me); Streaks (https://streaksapp.com); Loop Habit Tracker (https://github.com/iSoron/uhabits); Habitica (https://habitica.com)
- All of them have: habit with a schedule; daily check-in; streak counter; history view; reminders; archive or pause a habit
- Worth having: team accountability board — Habitica parties show who did their dailies, which is the remote-team payoff; weekly summary email — Habitify sends one and it brings lapsed users back
- Benchmark source: web (2026-09-14)

## Principles & constraints
- Stack: Next.js 15 (App Router, TypeScript) / Prisma + SQLite locally, Postgres-ready via `DATABASE_URL` / Vercel
- Quality bar: tests through the real entry point for every core journey; loading / empty / error states on every data view; labels, focus, contrast on every form; responsive at 390×844 and 1280×800; README + .env.example + CI green
- Scope rule: depth before breadth — polish and harden the shipped loop before adding new surface
- Non-goals: no gamification currency or avatars (Habitica territory); no native mobile app in v1 — responsive web only; no Slack or calendar integrations until the core loop is clean
- Constraints: free-tier hosting; no paid email provider in round 1 (the mailer logs to stdout)

## Feature map
| id | feature | status | round | note |
|---|---|---|---|---|
| F001 | Sign in by magic link & team workspace with invite link | done | 1 | new user signs in, lands in a workspace, invite link adds a second member |
| F002 | Create a habit with a schedule (daily / weekdays / custom days) | done | 1 | habit appears in today's list only on scheduled days |
| F003 | Daily check-in with personal streak | done | 1 | one tap marks today done; streak counter increments and survives reload |
| F004 | Team board: who checked in today | deferred | 2 | deferred: 1/2 tasks done; T009 gate_failed — test/team-board.e2e.test.ts 1 failing |
| F005 | Reminder email at the member's local time | planned | 2 | reminder arrives at the configured local hour; quiet on unscheduled days |
| F006 | Empty, loading, error states and a 390×844 layout pass on every view | planned | 2 | every list has a CTA when empty; no horizontal scroll on a phone |
| F007 | Habit history calendar (last 30 days) | planned | - | per-habit month view with done / missed days |
| F008 | Export check-ins to CSV | planned | - | download of all check-ins for the workspace |
| F009 | Weekly team digest email | planned | - | Monday summary of each member's completion rate |
| F010 | Fix: check-in button submits twice on double click | planned | 2 | double-click creates one row; UI shows "Already done today" |

## Decisions
- Product name "Streakly" — default: short, descriptive placeholder; renaming is a one-line change
- Stack Next.js 15 App Router + TypeScript with Prisma — default: mainstream for productivity-tool + saas-dashboard; greenfield, no project signal
- Auth by email magic link, no passwords — convention (productivity-tool; Habitify and Todoist offer it): team identity needs sign-in and magic links avoid password-reset scope
- Persistence Prisma + SQLite file in dev, `DATABASE_URL` switchable to Postgres — default: zero-setup local loop with a recorded migration path
- Hosting Vercel with `vercel.json` in the repo — convention (saas-dashboard typical stacks): default deploy target for Next.js
- Locale English UI in a single `en` locale file; dates rendered in the member's time zone — default
- Test runner vitest + supertest for route tests, Playwright for the check-in journey — default for Next.js projects
- Time zone stored per member at first sign-in from the browser — convention (productivity-tool common mistake: streaks break at UTC midnight)
- Email provider — needs human (an email provider API key as `EMAIL_PROVIDER_API_KEY`): magic links and reminders log to stdout until it is provided
- Enforce one check-in per habit per day with a unique index and a 409 `already_checked_in` — project signal (prisma/schema.prisma habit–member relations) + convention (api-backend-service error envelope)

## Backlog
- [P1] F004 Team board: who checked in today — impact:H effort:S — deferred round 1: T009 gate_failed, e2e expects today's check-ins grouped by member
- [P2] F006 Empty, loading, error states and a 390×844 layout pass on every view — impact:M effort:S — walkthrough J1: habits list empty state has no create action
- [P2] F010 Fix: check-in button submits twice on double click — impact:M effort:S — P2 defect: J2/check-in submit — two rows created, streak shows 2
- [P2] F005 Reminder email at the member's local time — impact:M effort:M — all four peers have reminders; the time zone setting shipped in F001
- [P3] F007 Habit history calendar (last 30 days) — impact:L effort:M — Habitify and Streaks show history; depth item once the loop is clean
- [P3] F008 Export check-ins to CSV — impact:L effort:S — universal baseline: data export
- [P3] F009 Weekly team digest email — impact:L effort:M — differentiator (team accountability); needs the F005 mailer

## Round log
### Round 0 — 2026-09-14
- shaped: 9 features, MVP = F001–F004 (onboard F001, core action F003, visible result F003 + F004), category `productivity-tool`
- next focus: F001, F002, F003, F004

### Round 1 — 2026-09-15
- shipped: F001 Sign in by magic link & team workspace with invite link, F002 Create a habit with a schedule, F003 Daily check-in with personal streak (3/4 planned); deferred: F004 (T009 gate_failed — e2e 1 failing)
- tasks: 9 done / 1 deferred / 0 failed; enhance: 1 applied (.env.example + README quickstart), promote none, lifted none; round-level failures: none
- ux: surface=web journeys=3 findings=3 (p1=0 p2=2 p3=1) → .fullauto/ux/20260915-183012/
- score: 64 (completeness 12 / usability 10 / robustness 12 / polish 10 / release 20)
- verdict: continue — next: F004,F006,F010,F005 — team board gate red; empty-state and double-submit defects on core journeys
