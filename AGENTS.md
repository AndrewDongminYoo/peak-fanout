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

The repository is at the **first half of M1** and is the Bun workspaces monorepo described in `README.md` under "Layout".

- `apps/mobile` (`@peak-fanout/mobile`) is the Expo SDK 57 app with the two M0 screens from `design.md`: magic-link login (`/login`, `/auth/callback`) and the Me screen (`/`, the Home tab) that calls `GET /me` through Eden treaty with TanStack Query. The session lives in `expo-secure-store` through the Supabase Expo guide's `LargeSecureStore` adapter.
- `apps/api` (`@peak-fanout/api`) is an Elysia app with `GET /health`, `POST /auth/session`, and `GET /me`. `src/app.ts` exports `createApp({ users, jwt })` and `type App`; `src/index.ts` wires Drizzle and listens only under `import.meta.main`, so tests build the app with an in-memory repository and never open a port or a database connection.
- `packages/db` (`@peak-fanout/db`) holds the Drizzle `users`, `reminders` and `deliveries` schema, `createDb(url)` over the `postgres` driver, three generated migrations under `drizzle/`, and the peak seed (`src/seed-plan.ts` decides the distribution, `src/seed.ts` writes it, `src/time.ts` converts local reminder times to UTC).
- `supabase/config.toml` describes the local Supabase Auth stack (`bun run supabase:start`): auth, db, api, and the mail catcher are on; studio, realtime, storage, edge runtime, and analytics are off. It is a **heavy dependency**: Docker plus several containers. Run it alone, never next to a build or an emulator, and stop it with `bun run supabase:stop`. Its Postgres holds only Supabase Auth's schema; the application tables stay in the compose `postgres-primary`.
- `load/` holds `verify-peak.sql`, the query that proves the seeded peak is one minute wide. There is no `load/results/` and no k6 scenario yet.
- `docker-compose.yml` runs a single `postgres-primary`. There is no read replica and no `jobs` table yet.

Redirect allow-list rule: Supabase Auth only redirects a magic link to URLs that match `[auth] site_url` or `additional_redirect_urls`, and it appends the tokens to the URL, so the app entry is the **pattern** `peakfanout://**`, never the exact `peakfanout://auth/callback`.

M1 part 1 ends here: the contract in `design.md`, the two tables, and a seed whose peak is proven by `load/verify-peak.sql`.
M1 part 2 (the per-minute scheduler, the inline push sink, the load harness, and the measured numbers in `README.md`) is next, and nothing of it is in the repository yet.
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
bun run dev:mobile               # expo start (press i / a / w for iOS / Android / web)
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

`packages/db/`:

- `src/schema.ts` — Drizzle tables, exactly the columns `design.md` lists. Change `design.md` first.
- `src/index.ts` — `createDb(url)` over the `postgres` driver, and re-exports the schema.
- `src/time.ts` — the local-time-to-UTC conversion, the TypeScript counterpart of the materializer's `AT TIME ZONE`. It matches the engine on every local time that occurs exactly once on its date, and its file header names the two daylight-saving cases where the two differ. Pure, and tested without a database.
- `src/seed-plan.ts` — the seed's numbers: the target instant, the timezone split, and which local time each of the 50,000 indices gets. Change this, not the SQL, to change the distribution.
- `src/seed-guard.ts` — refuses a `DATABASE_URL` whose host is not loopback, and one whose host the `postgres` driver would read differently from `new URL()`, before any client is constructed. Its file header owns why the host has to be read twice.
- `src/seed.ts` — the seed script (`bun run db:seed`) and the materializer. Both key on `users.seeded`, which the seed sets and the application never does, so the seed reads, writes and deletes only its own rows. One statement per segment over `generate_series`; never a row-at-a-time loop. The whole replacement is one transaction, so the delete cannot commit alone.
- `src/verify-peak.ts` — runs `load/verify-peak.sql` (`bun run db:verify-peak`); the seed calls it too, so both report the same query.
- `drizzle.config.ts` — reads `DATABASE_URL`; `generate` and `check` work without it.
- `drizzle/` — generated by `bun run db:generate`. Commit the SQL and `meta/` together; never edit them by hand.

## Boundaries

- Product names, copy, and content in this repository are original. Do not imitate any existing language-learning product's brand or content, and do not name any company in docs, code, or commits.
- Real multi-region deployment, VoIP, media extraction, and recommendation are out of scope. Mention them only in the README's "Next" section.
- Korean strings and comments, where they appear, are intentional. Do not translate them.
- Commit messages and identifiers are in English.
