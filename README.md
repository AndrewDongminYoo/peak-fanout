# PeakCall (peak-fanout)

A language-learning reminder app whose only hard problem is the evening peak.
Users pick a daily reminder time.
Most of them pick the same few evening minutes, so the backend has to fan out thousands of push notifications at once.
This repository builds that fan-out three times, adding a job queue, a cache, and a read replica one step at a time, and records what each step changed in measured numbers.

Stack: Bun workspaces, Elysia with Eden treaty, Drizzle on Postgres 16, Supabase Auth, Expo Router.

## Status

**M0 is complete once this change merges**: a Bun workspaces monorepo with the Expo SDK 57 app in `apps/mobile`, an Elysia API in `apps/api` serving `GET /health`, `POST /auth/session`, and `GET /me` behind Supabase JWT verification, a Drizzle package in `packages/db` holding the `users` table and its first migration, and a local Supabase Auth stack in `supabase/`.
The app signs in with a magic link and shows its own `users` row from `GET /me` through Eden treaty.
The milestone list below is the plan, not a record; the Done column is filled only when every gate in `AGENTS.md` passed for that milestone.

| Milestone | Scope                                                                                                                    | Done |
| --------- | ------------------------------------------------------------------------------------------------------------------------ | ---- |
| M0        | Bun workspaces, Elysia hello route, one Drizzle migration, Expo app calls `/me` through Eden treaty, magic-link login    | ✓    |
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

### Layout

```plaintext
peak-fanout/
├── apps/
│   ├── api/                # Elysia. src/app.ts exports createApp({ users, jwt }) and type App = ReturnType<typeof createApp>; src/index.ts wires Drizzle and listens
│   │   └── src/            # routes/, worker/ (job consumer), scheduler/ (per-minute enqueue) arrive with M1 and M2
│   └── mobile/             # Expo SDK 57 with expo-router; src/lib/ holds the Supabase and Eden treaty clients
├── packages/
│   └── db/                 # Drizzle schema (src/schema.ts), createDb (src/index.ts), migrations in drizzle/
├── supabase/               # config.toml for the local Supabase Auth stack (supabase start); its Postgres holds only auth
├── load/                   # k6 scenarios, results/*.json (M1)
├── docker-compose.yml      # postgres-primary today; postgres-replica and redis come with M3
├── tsconfig.base.json      # strict compiler options that apps/api and packages/db extend
├── .env.example            # DATABASE_URL, PORT, SUPABASE_URL, SUPABASE_JWT_SECRET; copy to .env, which is gitignored
├── design.md               # single source of truth: screens, API, data contracts
├── AGENTS.md               # agent operating rules
└── README.md
```

Every workspace is a Bun workspace (`apps/*`, `packages/*`) sharing the root `bun.lock`.
Root scripts fan out with `bun run --filter`: `check`, `typecheck`, `lint`, `test`, `dev:api`, `db:generate`, `db:migrate`, `db:check`; `dev:mobile` uses `bun --cwd=apps/mobile` instead so Expo keeps a TTY for its interactive keys, and `supabase:start`, `supabase:stop`, `supabase:status` wrap the Supabase CLI.

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
bun run db:migrate                 # applies packages/db/drizzle/* to the empty database
bun run supabase:start             # Supabase Auth on http://127.0.0.1:54321; needs Docker, pulls several images the first time
bun run supabase:status            # prints the anon key: paste it into apps/mobile/.env, and check the JWT secret matches .env
bun run dev:api                    # Elysia on http://localhost:3000, curl /health -> {"ok":true}
(cd apps/mobile && bunx expo run:ios)      # development build (or run:android); Expo Go cannot receive the peakfanout:// magic-link redirect
```

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
