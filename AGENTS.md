# AGENTS.md

Shared operating rules for coding agents in this repository.
`CLAUDE.md` imports this file, so shared guidance starts here.
Keep this root file limited to stable repository-wide rules and context routing.
Do not copy milestone snapshots, symbol catalogs, dependency versions, or command inventories into it.

## Project sources

PeakCall is a language-learning reminder demo whose subject is peak fan-out through a queue, cache, and read replica.
Use these sources in this order:

1. `README.md` owns current milestone state, architecture, commands, measured results, and their interpretation.
2. `design.md` owns screen, API, data, queue, worker, cache, replica, and measurement contracts.
3. Package manifests, scripts, configuration, source, and colocated tests own the current implementation details.

Read `README.md` before any change larger than a typo.
For a contract change, read the relevant `design.md` section and change it before code.
Do not infer current behavior from this file when an owning source can answer it.

## Load task context

Before editing a listed subtree, read its local instructions.
If a task spans subtrees, read each matching file.
These files contain local deviations and invariants, not repeated root rules.

- `apps/mobile/**`: `apps/mobile/AGENTS.md`
- `apps/api/**`: `apps/api/AGENTS.md`
- `packages/db/**`: `packages/db/AGENTS.md`
- Screens, API shapes, schema, queue behavior, or metrics: the relevant section of `design.md`
- CI, Trunk, Compose, Supabase, or repository scripts: the configuration or manifest that owns the behavior
- Measured results or milestone claims: `README.md` plus the cited artifact under `load/results/`

Inspect the smallest relevant source and test set.
Static code maps become stale, so verify symbols and paths in the working tree instead of expanding this file.

## Repository gates

1. Change `design.md` before changing a screen, API, or data contract.
   Define a new screen's route, API calls, empty state, and error state before implementing it.
2. Run `bun run check` before declaring an agent-produced change complete or committing it.
   This is the typecheck, lint, workspace tests, and migration-history gate.
   A workspace with a `test` script must keep at least one test file.
3. Keep one commit to one sentence-sized concern and use Conventional Commit prefixes.
   Do not mix scaffold, schema, route, and worker changes without a task requirement that makes them one concern.
4. Put measured numbers in `README.md` only from committed `load/results/*.json` fields.
   Do not copy chat summaries or estimates into the measurement table.
5. Fill all three fields in `.github/PULL_REQUEST_TEMPLATE.md`: change, matching `design.md` item, and verification.

Run targeted checks while iterating.
Before handoff, format only explicit changed paths, then run:

```bash
bun run check
trunk check --all --no-fix
```

CI runs those two checks and never formats.
Use `package.json` and workspace manifests as the command authority rather than maintaining another command catalog here.

## Operational safety

- The simulated push distribution is part of the committed experiment.
  A change to it invalidates measurement comparability and must be called out explicitly.
- Every load command must remain on the simulated sink.
  `bun run push:expo` is an external one-message action, and an accepted Expo ticket is not device-delivery evidence.
- Supabase startup, M4 seeding, fan-out measurements, mobile builds, and emulators are heavy operations.
  Run at most one heavy operation at a time.
- Supabase must not run beside a build or emulator, and it must be stopped with `bun run supabase:stop` when the task is done.
- Validate untested Drizzle SQL against the Compose PostgreSQL service before opening a pull request.
- Generated migrations under `packages/db/drizzle/` come from `bun run db:generate`.
  Commit generated SQL and metadata together and never hand-edit them.

## Boundaries

- Product names, copy, and content are original.
  Do not imitate an existing language-learning product or name a company in docs, code, or commits.
- Real multi-region deployment, VoIP, media extraction, and recommendation are out of scope.
  Mention them only in the README's `Next` section.
- Preserve intentional Korean strings and comments.
- Write commit messages and identifiers in English.
