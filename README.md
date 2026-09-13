# PeakCall (peak-fanout)

A language-learning reminder app whose only hard problem is the evening peak.
Users pick a daily reminder time.
Most of them pick the same few evening minutes, so the backend has to fan out thousands of push notifications at once.
This repository builds that fan-out three times, adding a job queue, a cache, and a read replica one step at a time, and records what each step changed in measured numbers.

Stack: Bun workspaces, Elysia with Eden treaty, Drizzle on Postgres 16, Supabase Auth, Expo Router.

## Status

**M0 and M1 are complete. M2 is next.**
M0 left a Bun workspaces monorepo with the Expo SDK 57 app in `apps/mobile`, an Elysia API in `apps/api` serving `GET /health`, `POST /auth/session` and `GET /me` behind Supabase JWT verification, a Drizzle package in `packages/db`, and a local Supabase Auth stack in `supabase/`.
The app signs in with a magic link and shows its own `users` row from `GET /me` through Eden treaty.
M1 part 1 added the `reminders` and `deliveries` tables and a seed that writes 50,000 users whose reminders land 8,000-strong on one UTC minute, proven by `load/verify-peak.sql` rather than asserted.
M1 part 2 added the simulated push sink, the per-minute scheduler that sends through it inline, and the load harness that drives one measured run and writes it to `load/results/`; the M1 row below is filled from such a file.
M2 is next: the scheduler only enqueues, and N workers consume with `SKIP LOCKED`, retry with backoff, dead-letter, and shut down gracefully.
The milestone list below is the plan, not a record; the Done column is filled only when every gate in `AGENTS.md` passed for that milestone.

| Milestone | Scope                                                                                                                    | Done |
| --------- | ------------------------------------------------------------------------------------------------------------------------ | ---- |
| M0        | Bun workspaces, Elysia hello route, one Drizzle migration, Expo app calls `/me` through Eden treaty, magic-link login    | ✓    |
| M1        | Naive send: scheduler scans `reminders` every minute and pushes inline. 50,000 seeded users, 8,000 due at 21:00          | ✓    |
| M2        | Queue: scheduler only enqueues. N workers consume with `SKIP LOCKED`, retry with backoff, dead-letter, graceful shutdown |      |
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
| M1 naive                | 866.3 s (14 min 26 s)             | 5 ms                | 29.85                  | n/a                             |
| M2 queue                |                                   |                     |                        |                                 |
| M3 cache + read replica |                                   |                     |                        |                                 |

The source of every filled cell is one `load/results/<ISO instant>-<milestone>.json`, written by the harness for that milestone (`bun run load:m1`), and every run is a single-machine localhost run against a simulated push sink.
The M1 row comes from `load/results/2026-09-12T19-07-48Z-m1-naive.json`: `fanout.duration_seconds`, `api.p95_ms`, and `database.transactions_per_second`.
That file is the harness's output unedited.
Its `sink` block is what makes the row comparable: the pinned distribution of 50–150 ms at a failure rate of 0, beside the cost the fan-out actually paid — a mean of 102.07 ms over 8,000 sends, 51..153 ms observed, measured from the rows the scheduler wrote rather than copied from any process's settings, which is what the run's fourth, fifth and sixth verdict checks grade.
The observed figures sit above the drawn bounds because the sink reports what each wait cost on the clock, timer overshoot included, and not the delay it drew; [design.md](design.md#the-push-sink) owns that distinction and why the tolerances hold it.
Its `base_commit` and `worktree_dirty` say the run was performed on top of commit `ad09480`, the milestone's last pushed commit, with the sixth verdict check and its schema bump still uncommitted ([design.md](design.md#metric-definitions-and-their-sources) owns why a run log names the base commit rather than the commit that produced it).
The column is transactions and not queries because stock Postgres 16 counts transactions; the same section defines each metric and names what it does not cover.

What the M1 row says: one process sending 8,000 reminders one at a time took 866.3 s, fourteen times the one-minute tick it was scheduled on, so the fan-out spilled far past its own minute.
Meanwhile the API was untouched — a p95 of 5 ms over 16,777 requests, no errors, and 4 connections of `max_connections` 100 in use at the peak.
The third column is mostly the measurement's own traffic rather than the sender's: of those 29.85 transactions a second, the load generator's 16,777 in-window requests (`api.requests_in_window`) are about 19 and the sender's 8,000 recorded attempts (`fanout.delivery_attempts`) about 9, each divided by the seconds between the two `database.counter_samples` — which is why it is still the M1-to-M2 comparison it looks like, since M2 runs the same generator at the same fixed rate.
Those 16,777 requests are about 3% short of the 20 a second the generator was set to (`api.requests_per_second_target` over the same window), because its interval timer fires late on a loaded machine and does not replay a missed beat, while `api.requests_skipped_for_backpressure` counts only the beats it declined on purpose, 0 here; [#26](https://github.com/AndrewDongminYoo/peak-fanout/issues/26) makes the offered rate a verdict check, so a later row cannot pass while offering less.
That is the baseline M2 has to beat on the first column without giving up the third and fourth.

## Architecture

### Stack decisions

| Area     | Choice                                                     | Why, and the fallback                                                                        |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Runtime  | Bun workspaces monorepo                                    | `apps/api`, `apps/mobile`, `packages/db` share one lockfile and one typecheck                |
| API      | Elysia                                                     | Eden treaty lets the app import the server's `App` type. A route change breaks the app build |
| ORM      | Drizzle + `postgres` driver                                | Migrations with drizzle-kit                                                                  |
| Database | Postgres 16, primary + streaming replica in docker compose | Needed to route reads for real. Fallback: primary only, routing code kept                    |
| Queue    | Own `jobs` table with `FOR UPDATE SKIP LOCKED`             | Explain a queue with Postgres alone. pg-boss is the documented replacement                   |
| Cache    | In-process LRU first, Redis optional later                 | Swapping the cache layer should touch one module                                             |
| Auth     | Supabase Auth, email magic link                            | API only verifies the JWT                                                                    |
| Mobile   | Expo SDK 57, expo-router, TanStack Query                   | Eden treaty client                                                                           |
| Push     | Simulated sink with a pinned latency distribution          | Its latency is the experiment. expo-server-sdk and one real-device send arrive in M5         |
| Load     | A Bun script in `apps/api/src/load/`                       | Needs `pg_stat_*` and `verifyPeak`, so it stays in this repository's runtime. k6 is not used |
| CI       | GitHub Actions: typecheck, lint, test, migration check     | Public repository                                                                            |

### Layout

```plaintext
peak-fanout/
├── apps/
│   ├── api/                # Elysia. src/app.ts exports createApp({ users, jwt }) and type App = ReturnType<typeof createApp>; src/index.ts wires Drizzle and listens
│   │   └── src/            # push/ (the simulated sink), scheduler/ (the per-minute naive send), load/ (the measured run); worker/ arrives with M2
│   └── mobile/             # Expo SDK 57 with expo-router; src/lib/ holds the Supabase and Eden treaty clients
├── packages/
│   └── db/                 # Drizzle schema (src/schema.ts: users, reminders, deliveries), createDb (src/index.ts), migrations in drizzle/, the peak seed (src/seed.ts)
├── supabase/               # config.toml for the local Supabase Auth stack (supabase start); its Postgres holds only auth
├── load/                   # verify-peak.sql proves the seeded peak; results/*.json are the measured runs, one file per run
├── docker-compose.yml      # postgres-primary today; postgres-replica and redis come with M3
├── tsconfig.base.json      # strict compiler options that apps/api and packages/db extend
├── .env.example            # DATABASE_URL, PORT, SUPABASE_URL, SUPABASE_JWT_SECRET; copy to .env, which is gitignored
├── design.md               # single source of truth: screens, API, data contracts
├── AGENTS.md               # agent operating rules
└── README.md
```

Every workspace is a Bun workspace (`apps/*`, `packages/*`) sharing the root `bun.lock`.
Root scripts fan out with `bun run --filter`: `check`, `typecheck`, `lint`, `test`, `dev:api`, `db:generate`, `db:migrate`, `db:check`, `db:seed`, `db:verify-peak`; `dev:mobile`, `dev:scheduler` and `load:m1` use `bun --cwd=<workspace>` instead, so Expo keeps a TTY for its interactive keys and the two long-running M1 processes stream their progress unprefixed, and `supabase:start`, `supabase:stop`, `supabase:status` wrap the Supabase CLI.

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
bun run db:seed                    # optional: 50,000 users and one reminder each, 8,000 of them on the peak minute
bun run db:verify-peak             # optional: re-prints the counts the seed ends with, from load/verify-peak.sql
bun run supabase:start             # Supabase Auth on http://127.0.0.1:54321; needs Docker, pulls several images the first time
bun run supabase:status            # prints the anon key: paste it into apps/mobile/.env, and check the JWT secret matches .env
bun run dev:api                    # Elysia on http://localhost:3000, curl /health -> {"ok":true}
(cd apps/mobile && bunx expo run:ios)      # development build (or run:android); Expo Go cannot receive the peakfanout:// magic-link redirect
```

The seed is optional: only M1's measurement needs it, and the app and the API work without it.
Expect it to take a noticeable amount of time: it writes a user and a reminder for every seeded index, and on a first run the `docker compose up` above pulls the Postgres image before any of that starts.
It deletes the rows it owns — the ones carrying `users.seeded`, and the reminders materialized for them — before inserting, so a second run leaves the same counts. A row the application created never carries that flag, so a user created by a magic-link login keeps their row and gains no reminder, whatever their address is.
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

### Measuring M1

No Supabase stack is needed: M1 never verifies a magic-link token, and the harness signs its own pool's tokens with the `SUPABASE_JWT_SECRET` the API is running with.
A run is a heavy job — Postgres, the API, the scheduler and the load generator at once — so run nothing else alongside it, and expect the fan-out to take on the order of ten minutes at 8,000 sends of 50–150 ms each. That slowness is the M1 result, not a problem with the run.

```bash
docker compose up -d --wait   # Postgres on localhost:5432
bun run db:migrate
bun run db:seed               # 50,000 users, 8,000 reminders on the peak minute
bun run dev:api               # a second terminal, left running
bun run load:m1               # a third terminal: it prints the scheduler command to start next
# a fourth terminal: the SCHEDULER_NOW=… bun run dev:scheduler line the harness just printed
docker compose down           # afterwards
```

Start them in that order.
The harness marks the day's earlier reminders sent before it creates its pool, so a scheduler already ticking with `SCHEDULER_NOW` set would begin sending those 36,000 rather than the peak minute.
Leave the `PUSH_SIM_*` values alone for the scheduler: it is the process that reads them, and the run log grades the send cost it measures against the pinned distribution.

The scheduler needs `SCHEDULER_NOW` because the seed's target date is a fixed future date, so nothing is due by the wall clock; the harness prints the instant rather than any document restating it (see [design.md](design.md#the-scheduler)).
The harness refuses to run unless the seed is present and exactly 8,000 reminders are due and pending on the peak instant, so measuring twice means seeding again first.
It also refuses while another harness holds the same database, so two runs cannot overlap (see [design.md](design.md#what-one-measured-run-assumes)).
It creates its own 200 `GET /me` users, marked `users.load_pool`, and deletes them however the run ends — a run that is killed outright leaves them, and the next run sweeps them by that flag and says how many it found.
It writes one `load/results/*.json`, prints it, and exits non-zero when the run misses the targets that file states.

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
