/**
 * A minimal VALID product brief (every required section, a parseable
 * feature map, an ordered backlog). Unit tests mutate it to produce each
 * validation failure; the evolve e2e feeds it to the fake claude's shape
 * stage and derives the per-round rewrites from it.
 */
export const VALID_BRIEF = `# Product: Notes
<!-- fullauto:product v1 -->
## Concept
A tiny note-taking app for one person.

## Target users & core value
Solo makers who want to jot and find notes fast.

## Category & benchmarks
productivity-tool — Apple Notes, Simplenote, Bear: all have search, tags, autosave.

## Principles & constraints
- Stack: Next.js + SQLite. Non-goals: collaboration, mobile app.
- Quality bar: tests, empty/error states, responsive.

## Feature map
| id | feature | status | round | note |
|----|---------|--------|-------|------|
| F001 | Create and edit a note | planned | 1 | |
| F002 | Search notes | planned | 1 | |
| F003 | Tags | planned | | later |
| F004 | Share by link | rejected | | non-goal |

## Decisions
- SQLite over Postgres — single user, zero ops.

## Backlog
- [P1] F001 Create and edit a note — impact:H effort:M — the core loop
- [P1] F002 Search notes — impact:H effort:S — finding is the value
- [P2] F003 Tags — impact:M effort:M — after the loop works

## Round log
`;

/** The brief as /product-assess would leave it after round 1 (F001/F002 done, F003 next). */
export const BRIEF_AFTER_ROUND_1 = VALID_BRIEF
  .replace('| F001 | Create and edit a note | planned | 1 | |', '| F001 | Create and edit a note | done | 1 | |')
  .replace('| F002 | Search notes | planned | 1 | |', '| F002 | Search notes | done | 1 | |')
  .replace('- [P1] F001 Create and edit a note — impact:H effort:M — the core loop\n- [P1] F002 Search notes — impact:H effort:S — finding is the value\n', '')
  .replace('## Round log\n', '## Round log\n### Round 1 — 2026-09-21\nshipped F001, F002; score 50; next F003\n');
