# Sample tasks.md

This is the format `fullauto-cc` accepts. It matches the output of speckit's
`/speckit.tasks` command, but any markdown checkbox list works.

- [ ] T001 Create the data model in `src/models/user.ts` with fields id, email, createdAt
- [ ] T002 Add a CRUD repository in `src/repos/user-repo.ts` (depends on T001)
- [ ] T003 Add an Express router at `src/routes/users.ts` exposing GET /users and POST /users (depends on T002)
- [ ] T004 Add integration tests under `test/users.test.ts` covering both endpoints (depends on T003)
