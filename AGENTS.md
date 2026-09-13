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

The repository is at the **end of M2** and is the Bun workspaces monorepo described in `README.md` under "Layout".

- `apps/mobile` (`@peak-fanout/mobile`) is the Expo SDK 57 app with the two M0 screens from `design.md`: magic-link login (`/login`, `/auth/callback`) and the Me screen (`/`, the Home tab) that calls `GET /me` through Eden treaty with TanStack Query. The session lives in `expo-secure-store` through the Supabase Expo guide's `LargeSecureStore` adapter.
- `apps/api` (`@peak-fanout/api`) is an Elysia app with `GET /health`, `POST /auth/session`, and `GET /me`. Neither authenticated route serves a row carrying `users.seeded`: `POST /auth/session` answers 409 and `GET /me` reports it absent, because a seeded row is a load-test fixture rather than an identity. `src/app.ts` exports `createApp({ users, jwt })` and `type App`; `src/index.ts` wires Drizzle and listens only under `import.meta.main`, so tests build the app with an in-memory repository and never open a port or a database connection.
- `packages/db` (`@peak-fanout/db`) holds the Drizzle `users`, `reminders`, `jobs` and `deliveries` schema, `createDb(url)` over the `postgres` driver, six generated migrations under `drizzle/`, and the peak seed (`src/seed-plan.ts` decides the distribution, `src/seed.ts` writes it, `src/time.ts` converts local reminder times to UTC). `jobs` is the queue: `id, kind, payload jsonb, run_at, locked_at, locked_by, attempts, last_error, dead_at, done_at`, with a partial index on `(run_at) WHERE done_at IS NULL`; `reminders.state` walks `pending → queued → sent | failed`; `deliveries.sender` (`jsonb`, nullable, no default) is the record of who sent the row and with what sink settings, written by both senders on every row they insert.
- `apps/api/src/push/` is the push sink: one interface and one simulated implementation whose per-send delay is uniform over `PUSH_SIM_LATENCY_MIN_MS`..`PUSH_SIM_LATENCY_MAX_MS`. **That distribution is the experiment**, so changing it invalidates every committed comparison. No provider SDK is a dependency yet; `expo-server-sdk` arrives in M5 with the one real-device send.
- `apps/api/src/scheduler/` is the scheduler, running as its own process (`bun run dev:scheduler`), with two ticks picked by `SCHEDULER_MODE`. `enqueue`, the default, is one statement per tick: the due and `pending` seeded reminders become `queued` and one `send_reminder` job each with `run_at = now()`; it sends nothing. `naive` is the M1 send, unchanged — sequential, unbatched, claiming nothing, without graceful shutdown — kept so the M1 row stays reproducible. `SCHEDULER_NOW` fixes the instant a tick treats as now, which a measured run needs because the seed's target date is a fixed future date; the worker needs no such thing, because `run_at` is the enqueue instant.
- `apps/api/src/worker/` is the worker, N processes (`bun run dev:worker`, one per terminal) that claim `WORKER_BATCH_SIZE` jobs with `FOR UPDATE SKIP LOCKED`, send them concurrently through the same sink, and record each outcome in its own transaction. A failed send is retried `WORKER_BACKOFF_BASE_MS × 2^(attempts − 1)` later and dead-lettered at `WORKER_MAX_ATTEMPTS`; a batch left locked by a killed worker is reclaimed after `WORKER_LEASE_MS`, which makes delivery at-least-once and is why every reminder update carries `WHERE state = 'queued'`. `SIGTERM` or `SIGINT` finishes the batch in flight and exits 0 at once, an idle worker included: the poll sleep is cut short and its timer released, so nothing holds the process open after the loop returns.
- `apps/api/src/load/` is the measured run, in two modes: `bun run load:m1` (`LOAD_MODE=naive`) measures the naive scheduler and `bun run load:m2` (`LOAD_MODE=queue`) the enqueue tick plus N workers; `bun run load:m2:restart` adds `LOAD_WORKER_RESTART=1`, under which the harness kills one worker with `SIGKILL` mid-fan-out and reads what became of its batch. `README.md`'s M1 row is filled from one run log and its M2 row from two, a timing run and a restart run. The run log is schema 5: the verdict grades the sender record every delivery carries (#25) and the generator's offered rate (#26) beside the earlier checks, per mode, and a restart run on a ninth check.
- `supabase/config.toml` describes the local Supabase Auth stack (`bun run supabase:start`): auth, db, api, and the mail catcher are on; studio, realtime, storage, edge runtime, and analytics are off. It is a **heavy dependency**: Docker plus several containers. Run it alone, never next to a build or an emulator, and stop it with `bun run supabase:stop`. Its Postgres holds only Supabase Auth's schema; the application tables stay in the compose `postgres-primary`. M1 does not need it.
- `load/` holds `verify-peak.sql`, the query that proves the seeded peak is one minute wide, and `results/*.json`, one file per experiment; a superseded log is removed in the commit that adds its replacement. k6 is not used.
- `docker-compose.yml` runs a single `postgres-primary`. There is no read replica yet.

Redirect allow-list rule: Supabase Auth only redirects a magic link to URLs that match `[auth] site_url` or `additional_redirect_urls`, and it appends the tokens to the URL, so the app entry is the **pattern** `peakfanout://**`, never the exact `peakfanout://auth/callback`.

M1 ended with the contract in `design.md`, the two tables, a seed whose peak is proven by `load/verify-peak.sql`, the simulated sink, the naive scheduler, the harness, and one committed run log behind the filled M1 row of `README.md`'s measurement table.
M2 part 1 added the `jobs` table, the enqueue tick, and a worker that claims with `SKIP LOCKED`, retries with backoff, dead-letters, is reclaimed by lease and shuts down gracefully — all of it tested without Postgres.
M2 part 2 ends here: `deliveries.sender` and migration `0005`, the harness's two modes and its restart procedure (`src/load/restart.ts`), `RUN_LOG_SCHEMA_VERSION` 5 closing #25 and #26, an M1 row re-measured by the schema-5 writer, and the M2 row filled from a timing run and a restart run.
M2 imported `apps/api/src/push/simulated.ts` unchanged: it changed how sends are scheduled and not what a send costs, which is what keeps the M1 and M2 rows comparable.
M3 is next: the cache and the read replica. Until it lands, the M3 row stays empty.
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
bun run db:generate              # drizzle-kit generate from packages/db/src/schema.ts
bun run db:migrate               # drizzle-kit migrate against DATABASE_URL
bun run db:check                 # drizzle-kit check, offline
bun run db:seed                  # 50,000 users and their reminders for the target date; refuses a non-loopback DATABASE_URL
bun run db:verify-peak           # runs load/verify-peak.sql: the counts that prove the peak minute
bun run supabase:start           # local Supabase Auth stack (Docker, heavy); supabase:status, supabase:stop
docker compose up -d --wait      # postgres-primary on localhost:5432; returns once healthy
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

`DATABASE_URL`, `PORT`, `SUPABASE_URL`, and `SUPABASE_JWT_SECRET` come from the environment. `.env.example` lists them; copy it to `.env`, which is gitignored and which `bun run` loads.
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

- `src/app.ts` — `createApp({ users, jwt })` builds the Elysia app and `type App` is what the mobile app imports (`package.json` `exports` points here). Routes and their response schemas live here until a `src/routes/` split is worth it. Keep it free of Bun-only and database imports: `apps/mobile` typechecks this file.
- `src/auth.ts` — `verifySupabaseJwt(token, { secret, jwks })`, the single place that knows how a token is checked: HS256 with the shared secret, ES256 through the JWKS resolver (`createRemoteJWKSet` on `SUPABASE_URL/auth/v1/.well-known/jwks.json`, wired in `index.ts`). The local Supabase CLI issues ES256 tokens and cannot issue HS256 ones, so the JWKS branch is the live path. `readBearerToken` lives here too.
- `src/users.ts` — `UsersRepository` (`findByEmail`, `upsertByEmail`) and `UserRecord`; `src/users-drizzle.ts` implements it over `@peak-fanout/db`.
- `src/index.ts` — the entry point: `parsePort`, `requireEnv`, and, only under `import.meta.main`, the Drizzle wiring and `app.listen`.
- `src/app.test.ts` — exercises routes through `app.handle(new Request(...))` with an in-memory repository and tokens signed in the test; no network, no database. `src/index.test.ts` unit-tests `parsePort` and `requireEnv`.
- `src/push/` — `sink.ts` is the contract (`send`, `PushSendError`) and `simulated.ts` the only implementation. M2 imports both unchanged, so a change here is a change to the experiment: say so in the pull request, or leave the distribution alone. `sender.ts` is a sibling, not a change to the sink: `DeliverySender` is the shape of `deliveries.sender` and `describeSender(kind, sinkConfig)` builds it from the settings a sending process read, with snake_case keys because it is a database value.
- `src/scheduler/` — `tick.ts` is `runTick` over injected dependencies (the naive send, unchanged since M1), `enqueue.ts` is `enqueueTick` over the same due query plus one enqueue operation (and owns `SEND_REMINDER_KIND` and the `send_reminder` payload type, because it is the writer), `runner.ts` the non-overlap guard, the interval and `SCHEDULER_MODE`, `reminders-drizzle.ts` the three SQL statements (`createDrizzleRemindersRepository(db, sender)`; `recordAttempt` writes the sender record on every `deliveries` row and refuses to run without one), `index.ts` the process that picks the tick by mode and, in naive mode, builds the sender record with `describeSender('naive', sinkConfig)` from the sink settings it reads. Keep Drizzle and Bun-only imports out of `tick.ts`, `enqueue.ts` and `runner.ts`, which is what keeps their tests free of Postgres and of a timer that really waits a minute.
- `src/worker/` — `loop.ts` is `runWorkerLoop` over injected dependencies (the three repository operations, the sink, a clock, a sleep that is handed the shutdown `AbortSignal`, and the signal itself), plus `decideFailure`, the backoff arithmetic `design.md` tabulates, `readWorkerConfig`, and `sleepUnlessStopped`, the process's idle sleep, which clears its timer when the signal cuts it short — a timer left armed holds the process open for the rest of the poll after the loop has returned; `jobs-drizzle.ts` is the SQL — the claim statement from `design.md` with the lease, the completion, the retry and the dead-letter, each in one transaction, and `createDrizzleJobsRepository(db, sender)` writes the sender record on both `deliveries` inserts; `index.ts` the process, which builds that record with `describeSender('worker', sinkConfig)` and installs the `SIGTERM`/`SIGINT` handler; `idle-shutdown.fixture.ts` the child process `loop.test.ts` spawns, because whether a shutdown during an idle poll exits the process, and not only returns the loop, is visible only from outside it. Keep Drizzle and Bun-only imports out of `loop.ts`. Three rules hold in `jobs-drizzle.ts`: every reminder update carries `WHERE state = 'queued'` and every job update `WHERE done_at IS NULL`, so a second completion after a lease reclaim changes nothing; every transaction that touches both tables takes the job row before the reminder row, so two workers recording the same reclaimed job never deadlock; and every timestamp is the database's `now()`, never the process clock. The retry-or-dead-letter decision is `decideFailure` over the row's `attempts` re-read `FOR UPDATE` inside the failure's transaction, never over a count the claim returned — `ClaimedJob` carries none. The SQL is not unit-tested; validate it against the compose Postgres before a pull request opens and paste the output into the PR body.
- `src/load/` — `metrics.ts` (percentiles, the counter arithmetic), `run-log.ts` (the run log shape, its verdict per mode, `LoadMode`, the expected sender record from the sink module's constants, the offered-rate arithmetic and the file name per experiment) and `restart.ts` (the restart procedure: `chooseWorkerToKill` and `isWorkerCommand` are pure, `runRestartProcedure` takes its claims query, its `ps` read, its kill, its clock and its sleep as parameters, and `createRestartIntervention` is the hook the window loop calls once per poll) are tested without Postgres, a real timer or a signal; `m1.ts` holds the I/O, the SQL and the wiring, runs both milestones with `LOAD_MODE` as the parameter, and adds no metric of its own. The decisions inside `m1.ts` that a run log depends on — when a fan-out counts as stalled (with `queued` holding the window open beside `pending`), and what provenance a run can honestly claim, which `run` reads once at its entry beside `started_at` and never after the window — take their clock, their poll and their `git` as parameters, so they are tested without Postgres or a real wait. A new metric goes in `design.md`, then in `run-log.ts`, then in a README cell — never straight into a cell, and a change to the log's shape bumps `RUN_LOG_SCHEMA_VERSION`, which `run-log.ts` owns; an optional block (`queue`, `restart`) is omitted when absent and never written as `null`. Four rules hold inside `m1.ts`: its `GET /me` pool is owned by `users.load_pool` and never by a predicate over addresses; every count over `reminders`, `deliveries` or `jobs` — pending, queued, attempts, the fan-out's timestamps and send costs, the sender records, the workers and claims observed, the open claims the kill picks from — is scoped to the peak instant and `users.seeded`, the same ownership fact the scheduler selects by, never a predicate over values; a sink parameter is measured from the `deliveries` rows the sender wrote, and its record read from the same rows, rather than read from this process's environment; and one harness holds a database at a time, through a session advisory lock on a connection reserved for it (`withRunLock`), never through a count of reminders. The restart procedure signals a pid only after `ps -p <pid> -o command=` names a worker, because a pid read from a table can have been reused.

`packages/db/`:

- `src/schema.ts` — Drizzle tables, exactly the columns `design.md` lists. Change `design.md` first.
- `src/index.ts` — `createDb(url)` over the `postgres` driver, and re-exports the schema.
- `src/time.ts` — the local-time-to-UTC conversion, the TypeScript counterpart of the materializer's `AT TIME ZONE`. It matches the engine on every local time that occurs exactly once on its date, and its file header names the two daylight-saving cases where the two differ. Pure, and tested without a database.
- `src/seed-plan.ts` — the seed's numbers: the target instant, the timezone split, and which local time each of the 50,000 indices gets. Change this, not the SQL, to change the distribution.
- `src/seed-guard.ts` — refuses a `DATABASE_URL` whose host is not loopback, and one whose host the `postgres` driver would read differently from `new URL()`, before any client is constructed. Its file header owns why the host has to be read twice.
- `src/seed.ts` — the seed script (`bun run db:seed`) and the materializer. Both key on `users.seeded`, which the seed sets and the application never does, so the seed reads, writes and deletes only its own rows — every `jobs` row of its reminders included, done and dead-lettered ones too, which the users' cascade does not reach because `jobs` holds its reminder in `payload` and not in a foreign key, so the seed deletes them itself: users first, then every job whose reminder no longer exists, in that order because the cascade's row locks are what serialize the seed against an enqueue tick, and the reverse order left a job enqueued between the two statements with no reminder and nothing to ever remove it (`design.md` "The enqueue tick" walks the three orderings). One statement per segment over `generate_series`; never a row-at-a-time loop. The whole replacement is one transaction, so the delete cannot commit alone.
- `src/verify-peak.ts` — runs `load/verify-peak.sql` (`bun run db:verify-peak`); the seed calls it too, so both report the same query.
- `drizzle.config.ts` — reads `DATABASE_URL`; `generate` and `check` work without it.
- `drizzle/` — generated by `bun run db:generate`. Commit the SQL and `meta/` together; never edit them by hand.

## Boundaries

- Product names, copy, and content in this repository are original. Do not imitate any existing language-learning product's brand or content, and do not name any company in docs, code, or commits.
- Real multi-region deployment, VoIP, media extraction, and recommendation are out of scope. Mention them only in the README's "Next" section.
- Korean strings and comments, where they appear, are intentional. Do not translate them.
- Commit messages and identifiers are in English.
