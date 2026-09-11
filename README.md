# PeakCall (peak-fanout)

A language-learning reminder app whose only hard problem is the evening peak.
Users pick a daily reminder time.
Most of them pick the same few evening minutes, so the backend has to fan out thousands of push notifications at once.
This repository builds that fan-out three times, adding a job queue, a cache, and a read replica one step at a time, and records what each step changed in measured numbers.

Stack: Bun workspaces, Elysia with Eden treaty, Drizzle on Postgres 16, Supabase Auth, Expo Router.

## Status

The repository is at **pre-M0**: an Expo SDK 57 app scaffold at the root, nothing else yet.
The milestone list below is the plan, not a record.

| Milestone | Scope                                                                                                                    | Done |
| --------- | ------------------------------------------------------------------------------------------------------------------------ | ---- |
| M0        | Bun workspaces, Elysia hello route, one Drizzle migration, Expo app calls `/me` through Eden treaty, magic-link login    |      |
| M1        | Naive send: scheduler scans `reminders` every minute and pushes inline. 50,000 seeded users, 8,000 due at 21:00          |      |
| M2        | Queue: scheduler only enqueues. N workers consume with `SKIP LOCKED`, retry with backoff, dead-letter, graceful shutdown |      |
| M3        | Cache and read replica: LRU stale-while-revalidate for `/cards/today`, `db.read` / `db.write` routing                    |      |
| M4        | Optional: 5,000,000-row `expressions` table, EXPLAIN before and after indexing                                           |      |
| M5        | Final measurement table, one architecture diagram, one real-device push                                                  |      |

M0 through M2 are required. M3 onward happens if time allows.

## Measurements

Every cell is filled only from a run log in `load/results/*.json`.
Blank means not measured yet.
No estimates.

| Step                    | 8,000 sends at 21:00 completed in | API p95 during peak | Primary queries/s | Jobs lost across worker restart |
| ----------------------- | --------------------------------- | ------------------- | ----------------- | ------------------------------- |
| M1 naive                |                                   |                     |                   | n/a                             |
| M2 queue                |                                   |                     |                   |                                 |
| M3 cache + read replica |                                   |                     |                   |                                 |

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
| Push     | expo-server-sdk, log sink by default                       | One real-device send at the end                                                              |
| Load     | k6, or a Bun script                                        | p95, RPS, queue lag as numbers                                                               |
| CI       | GitHub Actions: typecheck, lint, test, migration check     | Public repository                                                                            |

### Target layout

```plaintext
peak-fanout/
├── apps/
│   ├── api/                # Elysia
│   │   ├── src/routes/
│   │   ├── src/worker/     # job consumer
│   │   ├── src/scheduler/  # per-minute enqueue
│   │   └── src/index.ts    # export type App = typeof app
│   └── mobile/             # Expo, Eden treaty client
├── packages/
│   └── db/                 # Drizzle schema, migrations, seed
├── load/                   # k6 scenarios, results/*.json
├── docker-compose.yml      # postgres-primary, postgres-replica, (redis)
├── design.md               # single source of truth: screens, API, data contracts
├── AGENTS.md               # agent operating rules
└── README.md
```

### Contracts

Screens, the API surface, and the data model live in [design.md](design.md), which is the single source of truth for them.

## Getting started (current app)

```bash
bun install
bunx expo start        # then press i, a, or w
```

Checks:

```bash
bun run check          # typecheck + lint
trunk fmt && trunk check
```

Working rules for agents and contributors are in [AGENTS.md](AGENTS.md).

## Next

Out of scope for this demo, listed so they are not mistaken for omissions:

- Real multi-region deployment. Only per-user timezone handling is in scope.
- Redis as the cache layer, and pg-boss as the queue.
- Voice calls, media extraction, recommendation.
- A web client. Expo web stands in if time allows.
