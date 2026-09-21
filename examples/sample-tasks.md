# Sample tasks.md

This is the format `fullauto-cc` accepts. It matches the output of spec-kit's
`/speckit-tasks` command (checkbox line with a `T###` ID, optional `[P]` and
`[US#]` labels, and a `(depends on T###)` note), but any markdown checkbox list
works. Indented sub-bullets under a task line become the task body: acceptance
criteria, file paths, and the optional `- marker: value` lines the orchestrator
reads (`kind` / `risk` / `tdd` / `level` / `tests` or `tested by` / `no test` /
`touches-config` / `modifies-tests` / `wired by`). Markers win over the
heuristics; without them the orchestrator classifies each task from its title
and body. Every new code file must be imported by production code in the same
task or carry `- wired by: T###` — otherwise the post-task audit BLOCKs the task
as orphan code.

## Phase 1: Setup

- [ ] T001 Set up vitest as the test runner
  - kind: config
  - touches-config: adds `vitest` devDependency, `vitest.config.ts`, and the `test` / `typecheck` scripts in package.json
  - no test: scaffolding only

## Phase 2: User Story 1 - User CRUD (Priority: P1)

- [ ] T002 [US1] Create the User model in `src/models/user.ts` with fields id, email, createdAt
  - wired by: T004
  - export `User` type and `validateEmail(email: string): boolean`
  - no test: pure type + a one-line validator that T003 covers

- [ ] T003 [US1] Tests for the user repository (depends on T002)
  - tdd: red
  - level: integration
  - wired by: T005
  - File: `test/user-repo.test.ts`
  - Uses an in-memory SQLite database; `create()` then `findById()` round-trips; `findByEmail()` returns undefined for unknown email; duplicate email rejects
  - Add a minimal stub `src/repos/user-repo.ts` whose methods throw `not implemented` so typecheck passes and the tests FAIL at runtime (the stub is new production code that only the test imports, hence `wired by: T005`)

- [ ] T004 [US1] Implement the CRUD repository in `src/repos/user-repo.ts` (depends on T003)
  - tests: T003
  - risk: medium
  - Methods: `findById`, `findByEmail`, `create`, `update`, `delete`
  - Uses the SQLite client from `src/db/client.ts` and the `User` type from `src/models/user.ts`
  - Do not edit `test/user-repo.test.ts`; if a test is wrong, fix it and emit `FULLAUTO_TEST_CHANGE: test/user-repo.test.ts — <reason>`

- [ ] T005 [US1] Add the Express router in `src/routes/users.ts` exposing GET /users and POST /users (depends on T004)
  - risk: medium
  - Register the router in `src/app.ts` (`app.use('/users', usersRouter)`) in this task — the audit BLOCKs an unregistered router
  - Add `test/users.e2e.test.ts` with supertest: GET /users → 200 + JSON array; POST /users valid body → 201; invalid email → 400 `{ error: "invalid_email" }`

## Phase 3: User Story 2 - Profile page (Priority: P2)

- [ ] T006 [P] [US2] Create the `UserCard` component in `src/components/UserCard.tsx`
  - wired by: T007
  - Props: `{ user: User }`; renders email and a formatted createdAt
  - Unit test in `test/UserCard.test.tsx` renders the component with a fixture user and asserts the email text

- [ ] T007 [US2] Render `UserCard` on the profile page `app/profile/page.tsx` (depends on T006)
  - kind: impl
  - Fetches the current user and renders `<UserCard user={user} />` — this closes the wiring promised in T006
  - Add an e2e test in `test/profile.e2e.test.ts` (or the project's Playwright suite) that loads /profile and sees the user's email

## Phase 4: Polish

- [ ] T008 Add password-reset endpoint POST /auth/reset in `src/routes/auth.ts` and register it in `src/app.ts` (depends on T005)
  - risk: high
  - Token is single-use and expires in 15 minutes; rate-limited to 5 requests / hour per email
  - Integration test for token expiry + e2e test through the HTTP layer for the happy path and the rate-limit 429

- [ ] T009 Document the users API in `docs/api.md` (depends on T005)
  - kind: docs
  - no test: documentation only

## Manual Prerequisites
<!-- fullauto:prerequisites -->
- [ENV] DATABASE_URL — SQLite path for local runs (e.g. `file:./dev.db`)
