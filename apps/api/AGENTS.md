# API agent rules

These rules apply to `apps/api/**` in addition to the repository root `AGENTS.md`.
Read the relevant contract in `../../design.md` before changing behavior.

## Module boundaries

- `src/app.ts` is imported for its `App` type by the mobile workspace.
  Keep it and its dependency contracts free of Bun-only and database imports.
- Keep Drizzle and Bun-only imports out of `src/scheduler/tick.ts`, `src/scheduler/enqueue.ts`, `src/scheduler/runner.ts`, and `src/worker/loop.ts`.
  Their tests must run without PostgreSQL, a listening server, or a real one-minute timer.
- Keep repository contracts database-free and put Drizzle implementations in their `*-drizzle.ts` siblings.
- Exercise SQL in cards, deliveries, scheduler, worker, and load paths against Compose PostgreSQL before a pull request when unit tests do not execute that SQL.

## Identity and read routing

- A row with `users.seeded = true` is a load-test fixture, never an authenticated identity.
- Authentication and all writes use `db.write`.
  Replica-tolerant cards and delivery-sample reads use `db.read`.
- When `DATABASE_READ_URL` is absent, `db.read` and `db.write` must share one client and pool.
- A process configured for a replica must verify `pg_is_in_recovery() = true` before treating the connection as one.
  Store only a credential-free endpoint identity in delivery provenance.

## Push and worker invariants

- The simulated sink owns committed measurements and must remain the default.
  Load commands explicitly force simulation; Expo is opt-in through `PUSH_SINK=expo` or the separate one-message command.
- Measure `deliveries.latency_ms` inside the sink around one send.
  Card reads and database recording stay outside that measurement.
- A missing reminder or failed card read skips the job without sending or recording an attempt and leaves it for lease recovery.
  A `CardsReadError` stops that worker from claiming more jobs until the same read probe succeeds.
- Preserve at-least-once completion guards in `src/worker/jobs-drizzle.ts`:
  - Reminder updates require `state = 'queued'`.
  - Job updates require `done_at IS NULL`.
  - Transactions lock the job row before the reminder row.
  - Job timestamps use database `now()`.
  - Retry or dead-letter decisions re-read `attempts FOR UPDATE` inside the failure transaction.
- `SIGTERM` and `SIGINT` drain the active batch, interrupt idle sleep, release its timer, and exit cleanly.

## Measurement harness

`../../design.md` sections "Metric definitions and their sources", "Queue and workers (M2)", and "Cache and read replica (M3)" own the measurement contract.
Keep these invariants when changing `src/load/**`:

- `LOAD_MODE` and `LOAD_VARIANT` must agree, and a schema shape change increments `RUN_LOG_SCHEMA_VERSION`.
- Scope seeded reminder, delivery, and job counts by the recorded ownership fields and peak instant, never by address or value shape.
- Read sink settings and worker provenance from delivery rows rather than the harness environment.
- Hold the one-harness-at-a-time advisory lock on its reserved connection.
- For replica variants, verify recovery before fixture mutation and sample the verified endpoint at both window boundaries.
- Before a restart run sends `SIGKILL`, verify the process command and confirm through `lsof` that its working directory is inside this checkout.
- A new metric moves from `design.md` to `run-log.ts` to a run artifact and only then to `README.md`.

Start workers before the enqueue scheduler, re-seed between measured runs, and leave pinned `PUSH_SIM_*` and `WORKER_*` values unchanged unless the experiment itself is being redesigned.
