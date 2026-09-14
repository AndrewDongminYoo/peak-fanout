# PeakCall (peak-fanout)

A language-learning reminder app whose only hard problem is the evening peak.
Users pick a daily reminder time.
Most of them pick the same few evening minutes, so the backend has to fan out thousands of push notifications at once.
This repository builds that fan-out three times, adding a job queue, a cache, and a read replica one step at a time, and records what each step changed in measured numbers.

Stack: Bun workspaces, Elysia with Eden treaty, Drizzle on Postgres 16, Supabase Auth, Expo Router.

## Status

**M0, M1 and M2 are complete.**
M0 left a Bun workspaces monorepo with the Expo SDK 57 app in `apps/mobile`, an Elysia API in `apps/api` serving `GET /health`, `POST /auth/session` and `GET /me` behind Supabase JWT verification, a Drizzle package in `packages/db`, and a local Supabase Auth stack in `supabase/`.
The app signs in with a magic link and shows its own `users` row from `GET /me` through Eden treaty.
M1 part 1 added the `reminders` and `deliveries` tables and a seed that writes 50,000 users whose reminders land 8,000-strong on one UTC minute, proven by `load/verify-peak.sql` rather than asserted.
M1 part 2 added the simulated push sink, the per-minute scheduler that sends through it inline, and the load harness that drives one measured run and writes it to `load/results/`; the M1 row below is filled from such a file.
M2 part 1 added the `jobs` table and the queue on Postgres alone: the scheduler only enqueues by default (`SCHEDULER_MODE=naive` keeps the M1 send reproducible), and N workers claim with `FOR UPDATE SKIP LOCKED`, retry with backoff, dead-letter, are reclaimed by lease when killed, and drain the batch in flight on `SIGTERM`.
M2 part 2 measured it: the harness runs both milestones by `LOAD_MODE`, every delivery carries the record of the sender that wrote it and the run log grades that record and the generator's offered rate (issues #25 and #26, run-log schema 5), a restart run kills one worker with `SIGKILL` mid-fan-out and reads what became of its batch, and the M2 row below is filled from those two run logs beside an M1 row re-measured by the same writer.
M3 part 1 added the `expressions` table and its seed, the pure pick of the day's three cards, the `cards` module with its in-process LRU stale-while-revalidate cache, the worker reading the day's cards through that module before every send, `GET /cards/today` served by the same module, and the `db.read` / `db.write` seam in `packages/db` (reads fall back to the primary's own pool until `DATABASE_READ_URL` is set); nothing is measured yet, and the replica container is part 2's.
The milestone list below is the plan, not a record; the Done column is filled only when every gate in `AGENTS.md` passed for that milestone.

| Milestone | Scope                                                                                                                    | Done |
| --------- | ------------------------------------------------------------------------------------------------------------------------ | ---- |
| M0        | Bun workspaces, Elysia hello route, one Drizzle migration, Expo app calls `/me` through Eden treaty, magic-link login    | ✓    |
| M1        | Naive send: scheduler scans `reminders` every minute and pushes inline. 50,000 seeded users, 8,000 due at 21:00          | ✓    |
| M2        | Queue: scheduler only enqueues. N workers consume with `SKIP LOCKED`, retry with backoff, dead-letter, graceful shutdown | ✓    |
| M3        | Cache and read replica: LRU stale-while-revalidate for `/cards/today`, `db.read` / `db.write` routing                    |      |
| M4        | Optional: 5,000,000-row `expressions` table, EXPLAIN before and after indexing                                           |      |
| M5        | Final measurement table, one architecture diagram, one real-device push                                                  |      |

M0 through M2 are required. M3 onward happens if time allows.

## Measurements

Every cell is filled only from a run log in `load/results/*.json`.
Blank means not measured yet.
No estimates.

| Step                    | 8,000 sends at 21:00 completed in | API p95 during peak | Primary transactions/s | Jobs lost across worker restart |
| ----------------------- | --------------------------------- | ------------------- | ---------------------- | ------------------------------- |
| M1 naive                | 860.6 s (14 min 21 s)             | 5 ms                | 30.19                  | n/a                             |
| M2 queue                | 14.8 s                            | 23 ms               | 582.31                 | 0                               |
| M3 cache + read replica |                                   |                     |                        |                                 |

The source of every filled cell is one `load/results/<ISO instant>-<experiment>.json`, written by the harness for that experiment — `bun run load:m1` for the M1 row; `bun run load:m2` and `bun run load:m2:restart` for the M2 row, which cites two logs, the timing run for its first three cells and the restart run for its fourth — and every run is a single-machine localhost run against a simulated push sink.
The M1 row comes from `load/results/2026-09-13T13-43-19Z-m1-naive.json`: `fanout.duration_seconds`, `api.p95_ms`, and `database.transactions_per_second`.
The M2 row's first three cells come from `load/results/2026-09-13T13-32-22Z-m2-queue.json`, the same three fields, and its fourth from `load/results/2026-09-13T13-34-13Z-m2-queue-restart.json`, `restart.jobs_lost`.
All three files are the harness's output unedited, written by run-log schema 5 in one session on one machine, which is what makes the two rows one comparison: the M1 row was measured again by the writer that measured M2, and the schema-4 log behind the earlier M1 row is not kept.
Each file's `sink` block is what makes its row comparable: the pinned distribution of 50–150 ms at a failure rate of 0, beside the cost the fan-out actually paid, measured from the rows the sender wrote — a mean of 101.32 ms over 8,000 sends and 50..152 ms observed for M1, 100.77 ms and 50..213 ms for M2 — which is what the fourth, fifth and sixth verdict checks grade; and beside both, since schema 5, the record every sender wrote on every delivery of the settings it actually read (`fanout.sender_records_observed`, exactly one record per file, `kind` `naive` in the M1 log and `worker` in the M2 logs), which the eighth check grades against the pinned constants.
The observed figures sit above the drawn bounds because the sink reports what each wait cost on the clock, timer overshoot included, and not the delay it drew; [design.md](design.md#the-push-sink) owns that distinction and why the tolerances hold it, and the M2 maximum sits higher because a worker's twenty-five concurrent sends and their recording share one event loop, and four such workers share the machine, where M1's sends had both to themselves.
Every file's `base_commit` and `worktree_dirty` say the run was performed on top of commit `6b90522`, with only the status prose of this file and `AGENTS.md` uncommitted ([design.md](design.md#metric-definitions-and-their-sources) owns why a run log names the base commit rather than the commit that produced it).
Two review-round commits followed on the same pull request: `71daa45` reworded one sentence of `design.md`, and `e7957b1` made the restart procedure read a worker's working directory through `lsof` before the kill, one more check that changes what a restart run refuses and not what it records; neither touched `run-log.ts` or the sink, and a timing run does not run the restart procedure, so the three logs stand as measured.
The column is transactions and not queries because stock Postgres 16 counts transactions; the same section defines each metric and names what it does not cover.

What the M1 row says: one process sending 8,000 reminders one at a time took 860.6 s, fourteen times the one-minute tick it was scheduled on, so the fan-out spilled far past its own minute.
Meanwhile the API was untouched — a p95 of 5 ms over 16,908 requests, no errors, and 7 connections of `max_connections` 100 in use at the peak.
The third column is mostly the measurement's own traffic rather than the sender's: of those 30.19 transactions a second, the load generator's 16,908 in-window requests (`api.requests_in_window`) are about 20 and the sender's 8,000 recorded attempts (`fanout.delivery_attempts`) about 9, each divided by the seconds between the two `database.counter_samples`.
The generator offered 98.2% of the 20 a second it was set to (`api.offered_rate.observed_fraction`), inside the 5% the seventh check allows: its interval timer fires late on a loaded machine and does not replay a missed beat, while `api.requests_skipped_for_backpressure` counts only the beats it declined on purpose, 0 here.

What the M2 row says: four workers claiming batches of 25 with `FOR UPDATE SKIP LOCKED` sent the same 8,000 reminders in 14.8 s, against 860.6 s for one process sending them one at a time — the fan-out no longer spills past its minute, and the tick that used to do the sending only enqueues.
The fleet is recorded as observed and not as declared: `queue.workers_observed` is 4 and `queue.largest_claim_observed` is 25, read from `jobs.locked_by` and the claim timestamps at window close, and `queue.duplicate_attempts` is 0.
The API felt it this time: a p95 of 23 ms (p99 82 ms) over 286 in-window requests, against 5 ms over 16,908 in M1.
Both figures are the same generator at the same 20 requests a second, but a window of 14.6 s instead of 861 s, so the two p95s are the same instrument at very different sample sizes ([design.md](design.md#metric-definitions-and-their-sources) says so beside the definition), and four workers recording some 550 completions a second on the same Postgres is contention the naive sender never produced.
The third column is now mostly the sender's: of those 582.31 transactions a second, the fan-out's 8,000 recorded attempts (`fanout.delivery_attempts`) are about 549 and the generator's 286 in-window requests about 20, each over the seconds between the two `database.counter_samples`, and the claim statements and the harness's own polls are the rest.
Peak connection usage was 46 of `max_connections` 100 (`database.peak_connections`) — four workers, the API, the scheduler and the harness each holding a driver pool — against 7 in M1, which is the number to watch before adding workers.
The generator offered 98.0% of its target over the window (`api.offered_rate.observed_fraction`).

The fourth cell comes from the restart run: the harness killed the worker `restart.killed_worker` names with `SIGKILL` at `13:34:49.682Z` (`restart.killed_at`), 2,281 attempts into the fan-out, while it held 20 claimed jobs (`restart.jobs_held_at_kill`).
Five of them the killed worker recorded between the harness's last reading and the signal (`restart.finished_by_killed_worker`); the other fifteen sat locked until the lease expired — `restart.first_reclaim_at` is 29.9 s after the kill — and were then claimed and finished by another worker (`restart.finished_by_another_worker`); none was still open at window close and no peak reminder was left non-terminal, so `restart.jobs_lost` is 0 and the ninth check held.
That run's own fan-out took 34.5 s (`fanout.duration_seconds`), and the lease wait is most of the difference from the timing run, which is why the first three cells come from the run without a kill ([design.md](design.md#metric-definitions-and-their-sources), "Jobs lost across worker restart").
Delivery is at-least-once by design, and this run recorded 0 duplicates too: a `SIGKILL` mid-batch leaves sends that were never recorded, not sends recorded twice.
That is what the queue bought on the first column, and what it cost on the second and the connection count; M3's cache and read replica are measured against this row next.

## Architecture

### Stack decisions

| Area     | Choice                                                 | Why, and the fallback                                                                        |
| -------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Runtime  | Bun workspaces monorepo                                | `apps/api`, `apps/mobile`, `packages/db` share one lockfile and one typecheck                |
| API      | Elysia                                                 | Eden treaty lets the app import the server's `App` type. A route change breaks the app build |
| ORM      | Drizzle + `postgres` driver                            | Migrations with drizzle-kit                                                                  |
| Database | Postgres 16 primary; streaming replica in M3 part 2    | M3 part 2 routes replica-tolerant reads. Fallback: primary only, routing code kept           |
| Queue    | Own `jobs` table with `FOR UPDATE SKIP LOCKED`         | Explain a queue with Postgres alone. pg-boss is the documented replacement                   |
| Cache    | In-process LRU first, Redis optional later             | Swapping the cache layer should touch one module                                             |
| Auth     | Supabase Auth, email magic link                        | API only verifies the JWT                                                                    |
| Mobile   | Expo SDK 57, expo-router, TanStack Query               | Eden treaty client                                                                           |
| Push     | Simulated sink with a pinned latency distribution      | Its latency is the experiment. expo-server-sdk and one real-device send arrive in M5         |
| Load     | A Bun script in `apps/api/src/load/`                   | Needs `pg_stat_*` and `verifyPeak`, so it stays in this repository's runtime. k6 is not used |
| CI       | GitHub Actions: typecheck, lint, test, migration check | Public repository                                                                            |

### Layout

```plaintext
peak-fanout/
├── apps/
│   ├── api/                # Elysia. src/app.ts exports createApp({ users, jwt, cards }) and type App = ReturnType<typeof createApp>; src/index.ts wires Drizzle and listens
│   │   └── src/            # push/ (the simulated sink), scheduler/ (the per-minute tick: enqueue or naive), worker/ (N claim-and-send processes), cards/ (the day's cards and their cache), load/ (the measured run)
│   └── mobile/             # Expo SDK 57 with expo-router; src/lib/ holds the Supabase and Eden treaty clients
├── packages/
│   └── db/                 # Drizzle schema (src/schema.ts: users, expressions, reminders, jobs, deliveries), createDb and createReadWriteDb (src/index.ts), migrations in drizzle/, the peak seed (src/seed.ts)
├── supabase/               # config.toml for the local Supabase Auth stack (supabase start); its Postgres holds only auth
├── load/                   # verify-peak.sql proves the seeded peak; results/*.json are the measured runs, one file per experiment
├── docker-compose.yml      # postgres-primary today; postgres-replica comes with M3 part 2
├── tsconfig.base.json      # strict compiler options that apps/api and packages/db extend
├── .env.example            # DATABASE_URL, PORT, SUPABASE_URL, SUPABASE_JWT_SECRET; copy to .env, which is gitignored
├── design.md               # single source of truth: screens, API, data contracts
├── AGENTS.md               # agent operating rules
└── README.md
```

Every workspace is a Bun workspace (`apps/*`, `packages/*`) sharing the root `bun.lock`.
Root scripts fan out with `bun run --filter`: `check`, `typecheck`, `lint`, `test`, `dev:api`, `db:generate`, `db:migrate`, `db:check`, `db:seed`, `db:verify-peak`; `dev:mobile`, `dev:scheduler`, `dev:worker`, `load:m1`, `load:m2` and `load:m2:restart` use `bun --cwd=<workspace>` instead, so Expo keeps a TTY for its interactive keys and the long-running processes stream their progress unprefixed (the three `load:*` scripts also set `LOAD_MODE`, and the last `LOAD_WORKER_RESTART`), and `supabase:start`, `supabase:stop`, `supabase:status` wrap the Supabase CLI.

### Auth

Supabase Auth issues the tokens; the API only verifies them.
Two Postgres instances run locally on purpose: the compose `postgres-primary` (port 5432) holds the application tables, and the Supabase stack's own Postgres (port 54322) holds only Supabase Auth's schema.
`apps/api/src/auth.ts` checks the signature (HS256 with `SUPABASE_JWT_SECRET`, or ES256 against the signing keys Supabase Auth publishes at `SUPABASE_URL/auth/v1/.well-known/jwks.json`, which is what the local CLI issues), the expiry, and the `email` claim, then `POST /auth/session` upserts `users` by email.
The request and response shapes are in [design.md](design.md#authentication).

### Contracts

Screens, the API surface, and the data model live in [design.md](design.md), which is the single source of truth for them.

## Getting started

Prerequisites: Bun (version in `.bun-version`), Docker Desktop, and the Supabase CLI on your PATH (`brew install supabase/tap/supabase`, developed against 2.117.0). The `supabase:*` root scripts call that CLI; it is not an npm dependency yet (see issue #14).

```bash
bun install
cp .env.example .env                           # DATABASE_URL, PORT, SUPABASE_URL, SUPABASE_JWT_SECRET (local defaults)
cp apps/mobile/.env.example apps/mobile/.env   # EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY, EXPO_PUBLIC_API_URL
docker compose up -d --wait        # Postgres 16 on localhost:5432; returns once the healthcheck passes
bun run db:migrate                 # applies packages/db/drizzle/*; run it again on an existing database whenever a migration lands
bun run db:seed                    # optional: 50,000 users and one reminder each, 8,000 of them on the peak minute, and 1,000 expressions
bun run db:verify-peak             # optional: re-prints the counts the seed ends with, from load/verify-peak.sql
bun run supabase:start             # Supabase Auth on http://127.0.0.1:54321; needs Docker, pulls several images the first time
bun run supabase:status            # prints the anon key: paste it into apps/mobile/.env, and check the JWT secret matches .env
bun run dev:api                    # Elysia on http://localhost:3000, curl /health -> {"ok":true}
(cd apps/mobile && bunx expo run:ios)      # development build (or run:android); Expo Go cannot receive the peakfanout:// magic-link redirect
```

The seed is optional: only a measurement needs it, and the app and the API work without it — `GET /cards/today` answers with an empty list until it has run.
Expect it to take a noticeable amount of time: it writes a user and a reminder for every seeded index, and on a first run the `docker compose up` above pulls the Postgres image before any of that starts.
It deletes the rows it owns — the ones carrying `users.seeded`, and the reminders materialized for them — before inserting, so a second run leaves the same counts. A row the application created never carries that flag, so a user created by a magic-link login keeps their row and gains no reminder, whatever their address is.
It also replaces the `expressions` table whole with 1,000 rows of placeholder content at positions 1..1000, the rows the day's three cards are picked from; the application never writes that table, which is why the seed owns it entirely ([design.md](design.md#data-model-packagesdb)).
It refuses to run at all unless `DATABASE_URL` names a loopback host.
Both scripts print the counts that prove the peak, and [design.md](design.md#reminders-and-delivery-m1) says what those counts mean.

Use a development build, not Expo Go or the web target: `bunx expo run:ios` / `run:android` registers the `peakfanout` scheme from `apps/mobile/app.json`, which is where every magic link redirects, while Expo Go only handles `exp://` links and there is no HTTP callback for the web target yet.
`bun run dev:mobile` (`expo start`) is enough afterwards for JavaScript-only changes, as long as you open the app through the development build rather than Expo Go.

Magic-link mail never leaves the machine.
The local stack's mail catcher (Mailpit) serves a web inbox at <http://127.0.0.1:54324> and a JSON API at `http://127.0.0.1:54324/api/v1/messages`; open the newest message and follow its link, which redirects to `peakfanout://auth/callback` and opens the app.
The link points at `127.0.0.1`, so open it on the machine that runs the simulator.
A physical device needs two changes, not one: the Mac's LAN IP in `apps/mobile/.env` (see the comments there) only moves the OTP request, while the emailed link still points at `127.0.0.1:54321`, which on the phone is the phone itself.
Set the host Auth embeds in mail by uncommenting `external_url` under `[auth]` in `supabase/config.toml` as `external_url = "http://<Mac LAN IP>:54321/auth/v1"`, restart the stack (`bun run supabase:stop`, then `bun run supabase:start`), and open the inbox from the phone at `http://<Mac LAN IP>:54324`.
That value is machine-specific: revert it before committing.
`jwt_issuer` follows `external_url`, which is harmless here because `apps/api/src/auth.ts` does not check the issuer.
`bun run supabase:stop` shuts the stack down when you are done; it is the heaviest thing this repository runs locally.

### Measuring a milestone

No Supabase stack is needed: a measured run never verifies a magic-link token, and the harness signs its own pool's tokens with the `SUPABASE_JWT_SECRET` the API is running with.
A run is a heavy job — Postgres, the API, the sender processes and the load generator at once — so run nothing else alongside it.
An M1 run's fan-out takes on the order of ten minutes at 8,000 sends of 50–150 ms each, one at a time; that slowness is the M1 result, not a problem with the run.
An M2 run's fan-out takes seconds, and the restart run adds one lease wait to its own.

The shared steps, in this order:

```bash
docker compose up -d --wait   # Postgres on localhost:5432
bun run db:migrate
bun run db:seed               # 50,000 users, 8,000 reminders on the peak minute
bun run dev:api               # a second terminal, left running
```

Then the harness, in a third terminal, and the sender it prints the commands for, each in its own terminal, pasted as printed:

```bash
bun run load:m1               # the M1 row: it prints the scheduler line, with SCHEDULER_MODE=naive and SCHEDULER_NOW set
bun run load:m2               # the M2 row's first three cells: it prints the worker line, then the scheduler line with SCHEDULER_MODE=enqueue
bun run load:m2:restart       # the M2 row's fourth cell: the same, and the harness kills one worker mid-fan-out
docker compose down           # afterwards
```

In queue mode start the workers before the scheduler, one `bun run dev:worker` per terminal — the headline row used four — so the enqueue tick's jobs meet a fleet; the harness's hint says so and prints the worker line first.
The harness sets the scheduler's mode in the line it prints, so nothing is added to it by hand.
Re-seed between runs, with the scheduler and every worker stopped first: the harness refuses a database that has already been measured ("A database that has already been measured must be re-seeded"), a scheduler still ticking with `SCHEDULER_NOW` set would enqueue or send the fresh peak within the minute, and a tick or a worker's batch that lands while the seed is deleting can deadlock against it, and Postgres then aborts one side — a seed aborted that way rolls back and changes nothing, a worker aborted that way exits non-zero and its jobs go with the reminders the seed removes.
The harness marks the day's earlier reminders sent before it creates its pool, so a naive scheduler already ticking with `SCHEDULER_NOW` set would begin sending those 36,000 rather than the peak minute; in queue mode the same early scheduler would enqueue the peak before the harness checks it, and the harness then refuses up front ("0 reminders are due and pending at the peak instant").
Leave every `PUSH_SIM_*` and `WORKER_*` value alone for the sender processes: they are the processes that read them, and the run log grades both the send cost it measures and the settings each delivery records against the pinned distribution.
In a restart run the harness picks the worker holding the most open claims, checks through `ps` that the pid runs `bun` with the worker script on this machine and through `lsof` that its working directory is under this checkout, reads its claims once more, sends it `SIGKILL`, and nobody starts a replacement; that worker's terminal shows it die, and the remaining workers finish its batch once the lease expires.
Start the workers from the same checkout as the harness: a pid read from a table can have been reused by another project's worker, which prints the same command line, so a worker running from anywhere else — another checkout of this repository included — refuses the run without a log rather than being signalled.
A restart run whose kill stranded nothing — the batch finished before the signal landed — is refused at window close rather than logged, like one that never killed; re-seed and run it again.
`LOAD_STALL_TIMEOUT_MS` has to exceed the workers' lease in a restart run — the killed worker's batch waits out the lease before anything moves it — and the harness refuses one at or below the pinned default of 30,000 ms; it cannot see a `WORKER_LEASE_MS` the workers were started with, so a fleet run at a longer lease needs a longer stall timeout by hand.

The scheduler needs `SCHEDULER_NOW` because the seed's target date is a fixed future date, so nothing is due by the wall clock; the harness prints the instant rather than any document restating it (see [design.md](design.md#the-scheduler)).
The harness refuses to run unless the seed is present and exactly 8,000 reminders are due and pending on the peak instant, so measuring twice means seeding again first.
It also refuses while another harness holds the same database, so two runs cannot overlap (see [design.md](design.md#what-one-measured-run-assumes)).
It creates its own 200 `GET /me` users, marked `users.load_pool`, and deletes them however the run ends — a run that is killed outright leaves them, and the next run sweeps them by that flag and says how many it found.
It writes one `load/results/*.json`, prints it, and exits non-zero when the run misses the targets that file states; [design.md](design.md#metric-definitions-and-their-sources) defines every field and every check.

Checks:

```bash
bun run check          # typecheck + lint + test in every workspace, then drizzle-kit check
trunk fmt && trunk check
```

Working rules for agents and contributors are in [AGENTS.md](AGENTS.md).

## Next

Out of scope for this demo, listed so they are not mistaken for omissions:

- Real multi-region deployment. Only per-user timezone handling is in scope.
- Redis as the cache layer, and pg-boss as the queue.
- Voice calls, media extraction, recommendation.
- A web client. Expo web stands in if time allows.
