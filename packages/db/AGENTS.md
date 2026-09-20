# Database agent rules

These rules apply to `packages/db/**` in addition to the repository root `AGENTS.md`.
Read the data and behavior contract in `../../design.md` before changing schema, time conversion, seed ownership, or experiment SQL.

## Schema and clients

- `src/schema.ts` implements the columns and enums declared in `design.md`.
- Generate migrations with `bun run db:generate` from the repository root.
  Commit SQL and `drizzle/meta/` together and never hand-edit generated files.
- `createReadWriteDb` returns the same client as both `write` and `read` when no read URL exists.
  Close each distinct pool exactly once.
- `src/time.ts` is a pure module and must remain importable through the `./time` package subpath without pulling database runtime code into the mobile typecheck.

## Seed ownership

- The seed may mutate only rows it owns through recorded ownership, except for `expressions`, whose sole writer is the seed and whose replacement is whole-table and transactional.
- Preserve the seeded cleanup order defined in `design.md` so an enqueue tick cannot leave an orphan job.
- Keep set-based `generate_series` writes instead of row-at-a-time loops.
- Keep the loopback database guard ahead of client construction.
- `bun run db:seed:m4` is a separate explicit heavy mode and must not change the normal seed population.

## Database experiments

- M4 remains a rollback-only before-and-after constraint experiment over the exact explicit population.
- Execution times from M4 are database access-path observations, not fan-out metrics.
- Exercise every SQL statement in the M4 runner and other untested database paths against Compose PostgreSQL before a pull request.
- Keep result schema ownership, filename construction, and plan grading in the pure module so tests do not need a database.
