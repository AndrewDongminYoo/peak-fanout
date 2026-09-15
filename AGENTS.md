# AGENTS.md

Operating rules for every coding agent (Claude Code, Codex, or a human following the same gate) in this repository.
`CLAUDE.md` imports this file, so keep all shared guidance here and nothing in `CLAUDE.md` that would drift from it.

## What this repository is

**PeakCall** is a language-learning reminder demo.
A user picks a daily time such as 21:00, and at that time the backend picks three expression cards and sends one push notification.
The point of the demo is not the domain.
It is the fan-out problem: tens of thousands of reminders fall on the same evening minute, and the repository shows, with measured numbers, how a job queue, a cache, and a read replica absorb that peak.

`README.md` owns the plan: stack decisions, layout, data model, API surface, milestones, and the measurement table.
Read it before any change that is larger than a typo.
This file owns only the rules for working here.

## Current state versus target state

The repository has **M0 through M4 complete, with M5 next** and is the Bun workspaces monorepo described in `README.md` under "Layout".

- `apps/mobile` (`@peak-fanout/mobile`) is the Expo SDK 57 app with the two M0 screens from `design.md`: magic-link login (`/login`, `/auth/callback`) and the Me screen (`/`, the Home tab) that calls `GET /me` through Eden treaty with TanStack Query. The session lives in `expo-secure-store` through the Supabase Expo guide's `LargeSecureStore` adapter.
- `apps/api` (`@peak-fanout/api`) is an Elysia app with `GET /health`, `POST /auth/session`, `GET /me`, `GET /cards/today` and `GET /deliveries`. No authenticated route treats a row carrying `users.seeded` as an identity: `POST /auth/session` answers 409 and the reads report it absent, because a seeded row is a load-test fixture rather than an identity. An ordinary authenticated user may read the shared seeded delivery sample, with no identity or sender detail, through `GET /deliveries?limit=`. `src/app.ts` exports `createApp({ users, jwt, cards, deliveries })` and `type App`; `src/index.ts` wires the read/write pair, the cards cache and service, and the delivery repository, and listens only under `import.meta.main`, so tests build the app with in-memory or fake dependencies and never open a port or a database connection.
- `packages/db` (`@peak-fanout/db`) holds the Drizzle `users`, `expressions`, `reminders`, `jobs` and `deliveries` schema, `createDb(url)` over the `postgres` driver and `createReadWriteDb({ writeUrl, readUrl })` over it (`{ write, read }`, where `read` is the very same client as `write` when no read URL is set, so no second pool opens), seven generated migrations under `drizzle/`, and the peak seed (`src/seed-plan.ts` decides the distribution and the expressions' content rule, `src/seed.ts` writes both, `src/time.ts` converts local reminder times to UTC and, since M3, an instant to its local date). `expressions` is `id, position, lang, text, translation, level` with `position` unique and dense `1..n`, written by the seed alone. `jobs` is the queue: `id, kind, payload jsonb, run_at, locked_at, locked_by, attempts, last_error, dead_at, done_at`, with a partial index on `(run_at) WHERE done_at IS NULL`; `reminders.state` walks `pending → queued → sent | failed`; `deliveries.sender` (`jsonb`, nullable, no default) is the record of who sent the row, its sink settings and, for a worker, its cards cache and read database, written by both senders on every row they insert.
- `apps/api/src/cards/` is the day's cards: the pure pick by position, the in-process LRU stale-while-revalidate cache (`CARDS_CACHE*`, `off` for a pass-through), the repository over `db.read`, and the service the worker and `GET /cards/today` both read through. One set per calendar day for everyone, keyed by the local date in the user's timezone. `read-database.ts` produces a credential-free endpoint identity and verifies that a configured read connection reports `pg_is_in_recovery() = true` before a worker treats it as a replica.
- `apps/api/src/push/` is the push sink: one interface and one simulated implementation whose per-send delay is uniform over `PUSH_SIM_LATENCY_MIN_MS`..`PUSH_SIM_LATENCY_MAX_MS`. **That distribution is the experiment**, so changing it invalidates every committed comparison. No provider SDK is a dependency yet; `expo-server-sdk` arrives in M5 with the one real-device send.
- `apps/api/src/scheduler/` is the scheduler, running as its own process (`bun run dev:scheduler`), with two ticks picked by `SCHEDULER_MODE`. `enqueue`, the default, is one statement per tick: the due and `pending` seeded reminders become `queued` and one `send_reminder` job each with `run_at = now()`; it sends nothing. `naive` is the M1 send, unchanged — sequential, unbatched, claiming nothing, without graceful shutdown — kept so the M1 row stays reproducible. `SCHEDULER_NOW` fixes the instant a tick treats as now, which a measured run needs because the seed's target date is a fixed future date; the worker needs no such thing, because `run_at` is the enqueue instant.
- `apps/api/src/worker/` is the worker, N processes (`bun run dev:worker`, one per terminal) that claim `WORKER_BATCH_SIZE` jobs with `FOR UPDATE SKIP LOCKED`, read each reminder's cards for its local date through the cards module before the send, send them concurrently through the same sink, and record each outcome in its own transaction. Before a worker with `DATABASE_READ_URL` claims anything, it verifies that its own read server is a standby; every worker delivery records the cache configuration, whether cards came from the primary or replica and, for a replica, the credential-free endpoint. A card read that throws skips that job — no send, nothing recorded, left claimed for the lease — as does a claimed job whose reminder no longer exists, and the batch line counts both as `skipped`; a batch skipped whole takes the poll sleep, and a read that failed at the database (`CardsReadError`) also stops that worker claiming until a probe of the same read succeeds, one per poll, so a worker that cannot read holds one batch under its lease and not the queue. A failed send is retried `WORKER_BACKOFF_BASE_MS × 2^(attempts − 1)` later and dead-lettered at `WORKER_MAX_ATTEMPTS`; a batch left locked by a killed worker is reclaimed after `WORKER_LEASE_MS`, which makes delivery at-least-once and is why every reminder update carries `WHERE state = 'queued'`. `SIGTERM` or `SIGINT` finishes the batch in flight and exits 0 at once, an idle worker included: the poll sleep is cut short and its timer released, so nothing holds the process open after the loop returns.
- `apps/api/src/load/` is the measured run, in two modes and five schema-6 variants. `LOAD_MODE` selects the naive sender or queue; `LOAD_VARIANT` distinguishes M1, M2 and the M3 cache-off primary, cache-off replica and cache-on replica experiments. Replica variants verify and sample their standby independently at both window boundaries; the verdict binds that endpoint to the record written by every worker delivery. `bun run load:m2:restart` and `bun run load:m3:restart` kill one worker with `SIGKILL` mid-fan-out and read what became of its batch. The M1 and M2 committed logs remain schema 5, while the four M3 logs use schema 6. `README.md` fills the M3 timing cells from the cache-on replica timing run, the restart cell from its restart run, and cites both cache-off controls.
- `packages/db/src/m4-explain.ts` is the separate M4 database experiment. It requires the explicit 5,000,000-row expression population, runs the three-position predicate without and with `expressions_position_unique` inside one rollback-only transaction, verifies the original constraint afterward, and writes the schema-1 JSON result under `load/results/`. Its execution times are not fan-out metrics.
- `supabase/config.toml` describes the local Supabase Auth stack (`bun run supabase:start`): auth, db, api, and the mail catcher are on; studio, realtime, storage, edge runtime, and analytics are off. It is a **heavy dependency**: Docker plus several containers. Run it alone, never next to a build or an emulator, and stop it with `bun run supabase:stop`. Its Postgres holds only Supabase Auth's schema; the application tables stay in the compose `postgres-primary`. M1 does not need it.
- `load/` holds `verify-peak.sql`, the query that proves the seeded peak is one minute wide, and `results/*.json`, one file per experiment; a superseded log is removed in the commit that adds its replacement. k6 is not used.
- `docker-compose.yml` runs `postgres-primary`, an idempotent one-shot replication-role setup and `postgres-replica`, all on the official `postgres:16` image. The primary keeps its named volume. The replica takes its first base backup into a separate named volume and reuses it only when both `PG_VERSION` and the post-backup completion marker exist, so an interrupted first backup is cleared and taken again; its health check requires recovery mode. `DATABASE_READ_URL` points at the replica on localhost:5433; leaving it unset keeps `db.read` on the primary's own pool.

Redirect allow-list rule: Supabase Auth only redirects a magic link to URLs that match `[auth] site_url` or `additional_redirect_urls`, and it appends the tokens to the URL, so the app entry is the **pattern** `peakfanout://**`, never the exact `peakfanout://auth/callback`.

M1 ended with the contract in `design.md`, the two tables, a seed whose peak is proven by `load/verify-peak.sql`, the simulated sink, the naive scheduler, the harness, and one committed run log behind the filled M1 row of `README.md`'s measurement table.
M2 part 1 added the `jobs` table, the enqueue tick, and a worker that claims with `SKIP LOCKED`, retries with backoff, dead-letters, is reclaimed by lease and shuts down gracefully — all of it tested without Postgres.
M2 part 2 ends here: `deliveries.sender` and migration `0005`, the harness's two modes and its restart procedure (`src/load/restart.ts`), `RUN_LOG_SCHEMA_VERSION` 5 closing #25 and #26, an M1 row re-measured by the schema-5 writer, and the M2 row filled from a timing run and a restart run.
M2 imported `apps/api/src/push/simulated.ts` unchanged: it changed how sends are scheduled and not what a send costs, which is what keeps the M1 and M2 rows comparable.
M3 part 1 ends here: the `expressions` table and migration `0006`, the seed's expressions step, the pick, the cache and the service in `src/cards/`, the worker's read before every send with `skipped` on its batch line, `GET /cards/today`, and `createReadWriteDb` with reads falling back to the primary's own pool; `deliveries.sender` and the naive tick are untouched, and nothing is measured.
M3 part 2 ends here: the streaming `postgres-replica`, `DATABASE_READ_URL` pointing at it, and `GET /deliveries?limit=` reading the shared seeded sample on `db.read`.
M3 part 3 ends here: schema 6 names the variant, records worker-proven cache and read-route provenance, samples primary and replica transaction counters, and supplies four committed logs: cache-off primary, cache-off replica, cache-on replica timing and cache-on replica restart. The M3 row is filled from the last two and its interpretation cites both controls.
M4 ends here: `bun run db:seed:m4` selects the exact 5,000,000-expression population without changing the normal seed, `bun run load:m4` captures and grades the before/after JSON plans while rolling its constraint changes back, and `README.md` cites the committed result.
When a milestone item lands, update this section in the same commit.

## Gate rules

These rules are the deliverable of the repository as much as the code is.
They exist so that a pull request from a non-developer, written with an agent, is filtered by the repository before a person reads it.

1. **`design.md` is the single source of truth for screens, API, and data contracts.**
   Change `design.md` first, then change code.
   Give `design.md` to any agent as context before it touches a contract.
   A new screen gets its route path, API calls, and empty and error states there before its first component exists.
2. **Every agent-produced change must pass `bun run check` before it is committed.**
   `check` is typecheck + lint + `bun test` in every workspace, then `drizzle-kit check` on the migration history.
   A workspace that declares a `test` script must contain at least one test file, because `bun test` with no files exits 1.
   A change that fails the gate goes back to the agent, not to a reviewer.
3. **One commit is one change that a single sentence can describe.**
   Do not mix scaffold, schema, route, and worker changes in one commit.
   Use conventional commit prefixes, as the existing history does.
4. **Measured numbers enter `README.md` only from run logs in `load/results/*.json`.**
   Never copy a number an agent summarized in chat.
   Never fill a blank cell in the measurement table with an estimate.
5. **A pull request states three things:** what changed, which `design.md` item it implements, and how it was verified.
   `.github/PULL_REQUEST_TEMPLATE.md` has exactly those three fields. Fill all three.

## Commands

The project uses Bun workspaces (`bun.lock` at the root covers every workspace; `bunfig.toml` pins the hoisted linker so Metro sees one copy of each Expo package).
Use `bunx`, not `npx`, for every Expo command, and run Expo commands from `apps/mobile`.

Root scripts, run from the repository root:

```bash
bun install                      # install every workspace
bun run check                    # the gate: typecheck + lint + test per workspace, then drizzle-kit check
bun run typecheck                # tsc --noEmit in every workspace
bun run lint                     # expo lint in apps/mobile, eslint in apps/api and packages/db
bun run test                     # bun test in apps/api and packages/db
bun run dev:api                  # bun --watch apps/api/src/index.ts on PORT (default 3000)
bun run dev:scheduler            # the per-minute tick, its own process: SCHEDULER_MODE=enqueue (default) or naive; SCHEDULER_NOW makes the seeded peak due
bun run dev:worker               # one worker; run it in N terminals. Claims, sends, records; SIGTERM/SIGINT drains the batch in flight
bun run dev:mobile               # expo start (press i / a / w for iOS / Android / web)
bun run load:m1                  # one measured M1 run (LOAD_MODE=naive); writes load/results/*.json and exits non-zero on a missed target
bun run load:m2                  # one measured M2 timing run (LOAD_MODE=queue): four workers, then the enqueue scheduler, as the harness prints them
bun run load:m2:restart          # one measured M2 restart run (LOAD_WORKER_RESTART=1): the same, and the harness kills one worker mid-fan-out
bun run load:m3:primary          # M3 control: cache off, cards read from the primary
bun run load:m3:replica          # M3 control: cache off, cards read from the verified standby
bun run load:m3                  # M3 timing run: cache on, cards read from the verified standby
bun run load:m3:restart          # M3 restart run: the same, and the harness kills one worker mid-fan-out
bun run load:m4                  # M4 EXPLAIN before/after; requires the exact M4 population and writes one schema-1 result
bun run db:generate              # drizzle-kit generate from packages/db/src/schema.ts
bun run db:migrate               # drizzle-kit migrate against DATABASE_URL
bun run db:check                 # drizzle-kit check, offline
bun run db:seed                  # 50,000 users and their reminders for the target date, and 1,000 expressions; refuses a non-loopback DATABASE_URL
bun run db:seed:m4               # the same seed with exactly 5,000,000 expressions; explicit and heavy
bun run db:verify-peak           # runs load/verify-peak.sql: the counts that prove the peak minute
bun run supabase:start           # local Supabase Auth stack (Docker, heavy); supabase:status, supabase:stop
docker compose up -d --wait      # postgres-primary on localhost:5432 and the read-only replica on 5433; waits for both
trunk fmt && trunk check         # formatting and lint gate (also runs as git hooks)
```

Expo commands, run from `apps/mobile`:

```bash
bunx expo start                  # dev server
bun run ios                      # expo start --ios
bun run android                  # expo start --android
bun run web                      # expo start --web
bunx expo-doctor                 # dependency and config diagnosis
bunx expo install <package>      # add a dependency at the SDK-compatible version
bunx expo install --fix          # repair incompatible versions
```

Tests use `bun test`; a test file is `*.test.ts` next to the code it covers.
Run `bun run check` before declaring any task done.

`DATABASE_URL`, `PORT`, `SUPABASE_URL`, and `SUPABASE_JWT_SECRET` come from the environment, and so do the optional `DATABASE_READ_URL` and `CARDS_CACHE*`. `.env.example` lists them; copy it to `.env`, which is gitignored and which `bun run` loads.
The app reads `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, and `EXPO_PUBLIC_API_URL` from `apps/mobile/.env` (`apps/mobile/.env.example` is the template); Metro inlines them at bundle time.

`tsc` in `apps/mobile` depends on `expo-env.d.ts`, which is gitignored and normally generated the first time the dev server starts.
The mobile `typecheck` script writes the same one-line file when it is missing, so a fresh clone typechecks without starting Metro.
Do not commit `expo-env.d.ts`.
`apps/api` and `packages/db` extend the root `tsconfig.base.json`; `apps/mobile` extends `expo/tsconfig.base` because Expo owns its JSX and module settings.

ESLint has one root entry, `eslint.config.mjs`, which trunk and the `eslint .` scripts use. It extends `apps/mobile/eslint.config.js` for the app, which stays in place because `expo lint` requires a config in the app root.

CI (`.github/workflows/ci.yml`) runs the same two gates on every push to `main` and every pull request: `bun run check` and `trunk check --all --no-fix`.
CI never formats. Run `trunk fmt` locally before pushing.
Action references are SHA-pinned by `pinact` with the version tag in a trailing comment. Write the exact patch tag and let `trunk check --fix --filter=pinact` resolve the SHA. Dependabot keeps the pins current.

Trunk is configured in `.trunk/trunk.yaml` with `trunk-fmt-pre-commit` and `trunk-check-pre-push` hooks.
`.trunk/trunk.yaml` enables checkov, eslint, git-diff-check, grype, markdownlint, oxipng, pinact, prettier, svgo, trivy, and trufflehog, and the `quality-configs` plugin it sources adds actionlint, cspell, osv-scanner, and yamllint. `.trunk/trunk.yaml` is the owner of that list; when it changes, update this sentence in the same commit.
`packages/db/drizzle/**` is ignored by every linter because `drizzle-kit generate` owns those files.
Prettier settings live in `.prettierrc.mjs`: 2-space indent, single quotes, print width 100.

## Expo rules

Expo ships breaking changes every SDK release, and this project is on **SDK 57** with React Native 0.86, React 19.2, and TypeScript 6.
Do not write Expo, EAS, or React Native code from memory.

1. Confirm the major version in `apps/mobile/package.json`.
2. Read the matching docs at `https://docs.expo.dev/versions/v57.0.0/`.
3. For anything else, start from `https://docs.expo.dev/llms.txt` and follow its links.

Rules that follow from the project setup:

- **Expo Router owns navigation.** Routes live in `apps/mobile/src/app/`. Every file there is a screen, and `_layout.tsx` defines the navigator. Keep components, hooks, and constants outside `src/app/`.
- `apps/mobile/app.json` enables `typedRoutes` and `reactCompiler` under `experiments`. Route names are type-checked, so a renamed file surfaces as a compile error.
- **Continuous Native Generation is on.** `apps/mobile/ios/` and `apps/mobile/android/` are gitignored (`apps/mobile/.gitignore`) and generated. Configure native behavior in `app.json` and config plugins, never by editing generated folders.
- Expo Go covers only its bundled native modules. After adding a library with native code, use a development build: `bunx expo run:ios`, `bunx expo run:android`, or `bunx eas-cli build --profile development`.
- **A Dependabot bump for a package the SDK pins is wrong by construction, so do not merge one.** `node_modules/expo/bundledNativeModules.json` is the authority for `react`, `react-dom`, `react-native`, `react-native-reanimated`, `react-native-screens` and `react-native-worklets`; `bunx expo install --fix` is what moves them. `.github/dependabot.yml` lists those packages under `ignore` and owns that list.
- Prefer Expo modules over third-party libraries, and check the available skills before adding a dependency.
- For EAS, run `bunx eas-cli <command>` where the docs say `eas <command>`.

## Code layout

`apps/mobile/`:

- `src/app/` — routes. `_layout.tsx` provides `QueryClientProvider`, `SessionProvider`, and `ThemeProvider`, then renders a `Stack` whose `Stack.Protected` guards show `(tabs)` with a session and `login` without one; `auth/callback.tsx` is reachable in both states. `(tabs)/_layout.tsx` renders `AppTabs`; `(tabs)/index.tsx` is the Me screen and `(tabs)/explore.tsx` the template Explore tab.
- `src/components/app-tabs.tsx` — the tab bar, built on `NativeTabs` from `expo-router/unstable-native-tabs`. It is an unstable API. Check the SDK 57 docs before changing it.
- `src/components/` — themed primitives (`ThemedText`, `ThemedView`, `Button`) and template widgets.
- `src/constants/theme.ts` — `Colors` (light and dark), `Fonts`, spacing, and layout constants. Use these instead of literal colors.
- `src/hooks/` — `useColorScheme`, `useTheme`, and `useSession` (the Supabase session mirrored into React state).
- `src/lib/` — `supabase.ts` (client with the `LargeSecureStore` adapter and the foreground auto-refresh listener), `api.ts` (Eden treaty client that attaches the bearer token), `auth-callback.ts` (deep-link parsing and `completeSignIn`), `env.ts`.
- `@peak-fanout/api` is a workspace dependency for `import type { App }` only. Nothing from the server enters the bundle; check with `bunx expo export --platform web` and grep `dist/` for `elysia` when you touch `src/lib/api.ts`.
- **Platform splits use file suffixes.** `app-tabs.web.tsx`, `animated-icon.web.tsx`, and `use-color-scheme.web.ts` replace their native twins on web. When you change a native file, check whether a `.web.*` twin needs the same change.
- **Path aliases:** `@/*` maps to `./src/*` and `@/assets/*` maps to `./assets/*` (see `apps/mobile/tsconfig.json`). Use them for every non-relative import.

`apps/api/`:

- `src/app.ts` — `createApp({ users, jwt, cards, deliveries })` builds the Elysia app and `type App` is what the mobile app imports (`package.json` `exports` points here). Routes and their response schemas live here until a `src/routes/` split is worth it. Keep it free of Bun-only and database imports: `apps/mobile` typechecks this file, and its dependency contracts stay free of them for the same reason.
- `src/auth.ts` — `verifySupabaseJwt(token, { secret, jwks })`, the single place that knows how a token is checked: HS256 with the shared secret, ES256 through the JWKS resolver (`createRemoteJWKSet` on `SUPABASE_URL/auth/v1/.well-known/jwks.json`, wired in `index.ts`). The local Supabase CLI issues ES256 tokens and cannot issue HS256 ones, so the JWKS branch is the live path. `readBearerToken` lives here too.
- `src/users.ts` — `UsersRepository` (`findByEmail`, `upsertByEmail`) and `UserRecord`; `src/users-drizzle.ts` implements it over `@peak-fanout/db`.
- `src/index.ts` — the entry point: `parsePort`, `requireEnv`, and, only under `import.meta.main`, the Drizzle wiring and `app.listen`.
- `src/app.test.ts` — exercises routes through `app.handle(new Request(...))` with an in-memory repository and tokens signed in the test; no network, no database. `src/index.test.ts` unit-tests `parsePort` and `requireEnv`.
- `src/cards/` — `pick.ts` is `positionsForDay(dayNumber, count)`, the arithmetic of design.md "The day's cards", pure; `cache.ts` is `createSwrCache` over a `Map` with an injected clock (fresh, stale with one revalidation behind it, expired; single-flight per key; LRU by `maxEntries`), the `CardsCache` interface a Redis implementation would also satisfy, `createPassThroughCache` for `CARDS_CACHE=off`, and `readCardsCacheConfig(env)` in the shape of `readWorkerConfig`; `cards-drizzle.ts` is `createDrizzleCardsRepository(db)` with `maxPosition()` and `byPositions(positions)`, the two statements, over `db.read`; `read-database.ts` turns a URL into a credential-free endpoint and verifies the connected server with `pg_is_in_recovery()`; `service.ts` is `createCardsService({ repository, cache })` with `forDate(localDate)` and `todayFor(instant, timezone)`, plus `messageFor(cards)`, the push copy (the M1 `REMINDER_MESSAGE` when there are no cards), and `CardsReadError`, which wraps a throw from either repository statement with the date and the cause — the one throw the worker stops claiming on, so a throw from before the read (an unknown timezone) is left as the runtime threw it. `service.ts` imports `@peak-fanout/db/time`, the package's pure subpath, and never its root, because `app.ts` imports its type and `apps/mobile` typechecks `app.ts`; its value import of `REMINDER_MESSAGE` puts `scheduler/tick.ts` and `push/sink.ts` in that same typecheck program, so the rule that keeps Drizzle and Bun-only imports out of `tick.ts` now also protects the mobile build. The cache key is the local date alone. The SQL in `cards-drizzle.ts` and `read-database.ts` is validated against compose Postgres before a pull request opens.
- `src/deliveries.ts` is the database-free public repository contract, and `src/deliveries-drizzle.ts` implements it over `db.read`: inner joins `deliveries → reminders → users`, restricts the sample by `users.seeded`, selects only `id`, `status`, `latency_ms` and `created_at`, and orders by `created_at DESC, id DESC` before applying the limit. The route still reads the caller's `users` row from `db.write`, so authentication has read-after-write behavior; the operational sample itself is replica-tolerant. The SQL is not unit-tested; validate it against the compose Postgres before a pull request opens and paste the output into the PR body.
- `src/push/` — `sink.ts` is the contract (`send`, `PushSendError`) and `simulated.ts` the only implementation. M2 and M3 import both unchanged, so a change here is a change to the experiment: say so in the pull request, or leave the distribution alone. `sender.ts` is a sibling, not a change to the sink: `DeliverySender` is the shape of `deliveries.sender`; `describeSender` builds a naive record from its sink settings or a worker record from its sink, cards cache, read database and verified replica endpoint, with snake_case keys because it is a database value.
- `src/scheduler/` — `tick.ts` is `runTick` over injected dependencies (the naive send, unchanged since M1), `enqueue.ts` is `enqueueTick` over the same due query plus one enqueue operation (and owns `SEND_REMINDER_KIND` and the `send_reminder` payload type, because it is the writer), `runner.ts` the non-overlap guard, the interval and `SCHEDULER_MODE`, `reminders-drizzle.ts` the three SQL statements (`createDrizzleRemindersRepository(db, sender)`; `recordAttempt` writes the sender record on every `deliveries` row and refuses to run without one), `index.ts` the process that picks the tick by mode and, in naive mode, builds the sender record with `describeSender('naive', sinkConfig)` from the sink settings it reads. Keep Drizzle and Bun-only imports out of `tick.ts`, `enqueue.ts` and `runner.ts`, which is what keeps their tests free of Postgres and of a timer that really waits a minute.
- `src/worker/` — `loop.ts` is `runWorkerLoop` over injected dependencies (the three repository operations, the cards service's `todayFor`, the sink, a clock, a sleep that is handed the shutdown `AbortSignal`, and the signal itself), plus `decideFailure`, the backoff arithmetic `design.md` tabulates, `readWorkerConfig`, and `sleepUnlessStopped`, the process's idle sleep, which clears its timer when the signal cuts it short — a timer left armed holds the process open for the rest of the poll after the loop has returned. Each attempt reads `cards.todayFor(job.scheduledAt, job.timezone)` before the send and outside the send's `try`, because `deliveries.latency_ms` is the sink's measurement of one send and nothing else; a read that throws returns `skipped` — the sink is not called, nothing is recorded, the job stays claimed for the lease — and so does a job whose `reminder` is null, before any read; `BatchResult`, `WorkerSummary` and both format lines carry `skipped` beside `duplicate`. A read that failed at the database — a `CardsReadError`, which only the cards service throws, and only for a throw from its repository — also trips the loop's breaker: the worker claims nothing more, probes the same `todayFor` for the first such job's `scheduledAt` and `timezone` at once and then once per `pollMs` sleep, and claims again when a probe succeeds, so a worker that cannot read holds the one batch it had under its lease instead of a fresh batch per poll; both outcomes of a probe go back to the top of the loop, so a shutdown that arrived during it is seen before any claim. Any other throw from `todayFor` — a timezone the runtime does not know — is that job's own and never trips it, nor does an orphan, which is what keeps one unreadable row from idling every worker that claims it; a batch skipped whole by such jobs takes the `pollMs` sleep an empty claim gets and is claimed past. `jobs-drizzle.ts` is the SQL — the claim statement from `design.md` with the lease, whose second select returns `expo_push_token`, `users.timezone` and `reminders.scheduled_at` as `ClaimedJob.reminder`, null for a claimed job whose reminder no longer exists — handed to the loop to skip by name, never thrown, because the claim's UPDATE has already committed and a throw there would strand the batch — the completion, the retry and the dead-letter, each in one transaction, and `createDrizzleJobsRepository(db, sender)` writes the sender record on both `deliveries` inserts; `index.ts` the process, which builds the read/write pair from `DATABASE_URL` and `DATABASE_READ_URL`, the cards service over `db.read`, that record with `describeSender('worker', sinkConfig)`, logs the cache setting on its start line, and installs the `SIGTERM`/`SIGINT` handler; `idle-shutdown.fixture.ts` the child process `loop.test.ts` spawns, because whether a shutdown during an idle poll exits the process, and not only returns the loop, is visible only from outside it. Keep Drizzle and Bun-only imports out of `loop.ts`. Three rules hold in `jobs-drizzle.ts`: every reminder update carries `WHERE state = 'queued'` and every job update `WHERE done_at IS NULL`, so a second completion after a lease reclaim changes nothing; every transaction that touches both tables takes the job row before the reminder row, so two workers recording the same reclaimed job never deadlock; and every timestamp is the database's `now()`, never the process clock. The retry-or-dead-letter decision is `decideFailure` over the row's `attempts` re-read `FOR UPDATE` inside the failure's transaction, never over a count the claim returned — `ClaimedJob` carries none. The SQL is not unit-tested; validate it against the compose Postgres before a pull request opens and paste the output into the PR body.
- `src/load/` — `metrics.ts` (percentiles, the counter arithmetic), `run-log.ts` (the schema-6 shape, five `LoadVariant` values, variant-aware verdict, sender provenance and primary and replica counters) and `restart.ts` (the restart procedure: `chooseWorkerToKill`, `isWorkerCommand` and `isUnderRepository` are pure, `runRestartProcedure` takes its claims query, its `ps` and `lsof` reads, its kill, its clock and its sleep as parameters, and `createRestartIntervention` is the hook the window loop calls once per poll) are tested without Postgres, a real timer or a signal; `m1.ts` holds the I/O, the SQL and the wiring for M1 through M3. It requires `LOAD_VARIANT` to agree with `LOAD_MODE`, refuses a primary variant with `DATABASE_READ_URL`, verifies a replica variant's loopback read server before fixture mutation, samples the primary and replica counters concurrently at each window boundary, and closes both clients on every exit. The decisions inside `m1.ts` that a run log depends on — when a fan-out counts as stalled (with `queued` holding the window open beside `pending`), and what provenance a run can honestly claim, which `run` reads once at its entry beside `started_at` and never after the window — take their clock, their poll and their `git` as parameters, so they are tested without Postgres or a real wait. A new metric goes in `design.md`, then in `run-log.ts`, then in a README cell — never straight into a cell, and a change to the log's shape bumps `RUN_LOG_SCHEMA_VERSION`, which `run-log.ts` owns; an optional block (`queue`, `restart`, `replica`) is omitted when absent and never written as `null`. Four rules hold inside `m1.ts`: its `GET /me` pool is owned by `users.load_pool` and never by a predicate over addresses; every count over `reminders`, `deliveries` or `jobs` — pending, queued, attempts, the fan-out's timestamps and send costs, the sender records, the workers and claims observed, the open claims the kill picks from — is scoped to the peak instant and `users.seeded`, the same ownership fact the scheduler selects by, never a predicate over values; a sink parameter is measured from the `deliveries` rows the sender wrote, and its record read from the same rows, rather than read from this process's environment; and one harness holds a database at a time, through a session advisory lock on a connection reserved for it (`withRunLock`), never through a count of reminders. The restart procedure signals a pid only after `ps -p <pid> -o command=` names a worker and `lsof -a -p <pid> -d cwd` puts its working directory under this checkout's root, because a pid read from a table can have been reused — by anything, which the first read catches, or by another project's worker, which prints the same command line and only the second read tells apart; a worker started from another checkout of this repository is refused by the same rule.

`packages/db/`:

- `src/schema.ts` — Drizzle tables, exactly the columns `design.md` lists. Change `design.md` first.
- `src/index.ts` — `createDb(url)` over the `postgres` driver, `createReadWriteDb({ writeUrl, readUrl })` returning `{ write, read }` with `read` the same client as `write` when `readUrl` is unset, `endReadWriteDb` (one `end` per pool), and re-exports the schema. `package.json` also exports `./time`, the pure subpath `apps/api/src/cards/service.ts` imports.
- `src/time.ts` — the local-time-to-UTC conversion, the TypeScript counterpart of the materializer's `AT TIME ZONE`, and its reverse, `localDate(instant, timezone)` (`YYYY-MM-DD` in the zone, what "today" means for the day's cards) with `dayNumber(localDate)` (days since 1970-01-01, refusing a date that names no real day). It matches the engine on every local time that occurs exactly once on its date, and its file header names the two daylight-saving cases where the two differ. Pure, and tested without a database.
- `src/seed-plan.ts` — the seed's numbers: the target instant, the timezone split, which local time each of the 50,000 indices gets, `EXPRESSION_COUNT` (1,000), `M4_EXPRESSION_COUNT` (5,000,000), the exact `SEED_M4_EXPRESSIONS=1` selector and `seedExpression(position, count)`, the content rule the expressions insert repeats in SQL. Change this, not the SQL, to change the distribution.
- `src/seed-guard.ts` — refuses a `DATABASE_URL` whose host is not loopback, and one whose host the `postgres` driver would read differently from `new URL()`, before any client is constructed. Its file header owns why the host has to be read twice.
- `src/seed.ts` — the seed script (`bun run db:seed`, or `bun run db:seed:m4` for the explicit M4 population) and the materializer. Both key on `users.seeded`, which the seed sets and the application never does, so the seed reads, writes and deletes only its own rows — every `jobs` row of its reminders included, done and dead-lettered ones too, which the users' cascade does not reach because `jobs` holds its reminder in `payload` and not in a foreign key, so the seed deletes them itself: users first, then every job whose reminder no longer exists, in that order because the cascade's row locks are what serialize the seed against an enqueue tick, and the reverse order left a job enqueued between the two statements with no reminder and nothing to ever remove it (`design.md` "The enqueue tick" walks the three orderings). The transaction's first step replaces `expressions` whole — `DELETE FROM expressions`, then one insert over `generate_series(1, expressionCount)` — with no predicate, because the table has one writer and no flag is needed to tell its rows apart. One statement per segment over `generate_series`; never a row-at-a-time loop. The whole replacement is one transaction, so the delete cannot commit alone.
- `src/m4.ts` — the pure M4 result builder: validates the exact dense table, walks nested JSON plan nodes, requires a before `Seq Scan` with no index and an after scan on `expressions_position_unique`, and owns result schema 1 and its filename. `src/m4-explain.ts` owns the loopback-only PostgreSQL I/O: table and catalog preconditions, `ANALYZE`, the rollback-only constraint experiment, the post-rollback catalog check and the result write. Every SQL statement in the runner must be exercised against compose Postgres before a pull request opens.
- `src/verify-peak.ts` — runs `load/verify-peak.sql` (`bun run db:verify-peak`); the seed calls it too, so both report the same query.
- `drizzle.config.ts` — reads `DATABASE_URL`; `generate` and `check` work without it.
- `drizzle/` — generated by `bun run db:generate`. Commit the SQL and `meta/` together; never edit them by hand.

## Boundaries

- Product names, copy, and content in this repository are original. Do not imitate any existing language-learning product's brand or content, and do not name any company in docs, code, or commits.
- Real multi-region deployment, VoIP, media extraction, and recommendation are out of scope. Mention them only in the README's "Next" section.
- Korean strings and comments, where they appear, are intentional. Do not translate them.
- Commit messages and identifiers are in English.
