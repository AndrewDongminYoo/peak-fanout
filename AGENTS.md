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

The repository is **mid-M0** and is the Bun workspaces monorepo described in `README.md` under "Layout".

- `apps/mobile` (`@peak-fanout/mobile`) is the Expo SDK 57 app, generated from the Expo template and lightly branded. It does not call the API yet.
- `apps/api` (`@peak-fanout/api`) is an Elysia app with one route, `GET /health`. `src/index.ts` exports `type App` and listens only under `import.meta.main`, so tests import it without opening a port.
- `packages/db` (`@peak-fanout/db`) holds the Drizzle `users` schema, `createDb(url)` over the `postgres` driver, and one generated migration under `drizzle/`.
- `docker-compose.yml` runs a single `postgres-primary`. There is no read replica, no `jobs` table, and no `load/` directory yet.

Still missing from M0: Supabase JWT verification, `GET /me`, the Eden treaty call from the app, and the two screens.
`design.md` has the API and data contracts, but its Screens section is still empty.
When one of these lands, update this section in the same commit.

## Gate rules

These rules are the deliverable of the repository as much as the code is.
They exist so that a pull request from a non-developer, written with an agent, is filtered by the repository before a person reads it.

1. **`design.md` is the single source of truth for screens, API, and data contracts.**
   Change `design.md` first, then change code.
   Give `design.md` to any agent as context before it touches a contract.
   Its Screens section is empty. Fill it before building the first screen in M0.
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

`DATABASE_URL` and `PORT` come from the environment. `.env.example` lists them; copy it to `.env`, which is gitignored and which `bun run` loads.

`tsc` in `apps/mobile` depends on `expo-env.d.ts`, which is gitignored and normally generated the first time the dev server starts.
The mobile `typecheck` script writes the same one-line file when it is missing, so a fresh clone typechecks without starting Metro.
Do not commit `expo-env.d.ts`.
`apps/api` and `packages/db` extend the root `tsconfig.base.json`; `apps/mobile` extends `expo/tsconfig.base` because Expo owns its JSX and module settings.

ESLint has one root entry, `eslint.config.mjs`, which trunk and the `eslint .` scripts use. It extends `apps/mobile/eslint.config.js` for the app, which stays in place because `expo lint` requires a config in the app root.

CI (`.github/workflows/ci.yml`) runs the same two gates on every push to `main` and every pull request: `bun run check` and `trunk check --all --no-fix`.
CI never formats. Run `trunk fmt` locally before pushing.
Action references are SHA-pinned by `pinact` with the version tag in a trailing comment. Write the exact patch tag and let `trunk check --fix --filter=pinact` resolve the SHA. Dependabot keeps the pins current.

Trunk is configured in `.trunk/trunk.yaml` with `trunk-fmt-pre-commit` and `trunk-check-pre-push` hooks.
Enabled linters are prettier, markdownlint, checkov, git-diff-check, oxipng, svgo, and trufflehog.
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

- `src/app/` — routes. `_layout.tsx` wraps the app in `ThemeProvider` and renders `AppTabs`. `index.tsx` and `explore.tsx` are the two tabs.
- `src/components/app-tabs.tsx` — the tab bar, built on `NativeTabs` from `expo-router/unstable-native-tabs`. It is an unstable API. Check the SDK 57 docs before changing it.
- `src/components/` — themed primitives (`ThemedText`, `ThemedView`) and template widgets.
- `src/constants/theme.ts` — `Colors` (light and dark), `Fonts`, spacing, and layout constants. Use these instead of literal colors.
- `src/hooks/` — `useColorScheme` and `useTheme`.
- **Platform splits use file suffixes.** `app-tabs.web.tsx`, `animated-icon.web.tsx`, and `use-color-scheme.web.ts` replace their native twins on web. When you change a native file, check whether a `.web.*` twin needs the same change.
- **Path aliases:** `@/*` maps to `./src/*` and `@/assets/*` maps to `./assets/*` (see `apps/mobile/tsconfig.json`). Use them for every non-relative import.

`apps/api/`:

- `src/index.ts` — builds the Elysia app, exports `app` and `type App`, and calls `app.listen` only under `import.meta.main`. Add routes here until a `src/routes/` split is worth it.
- `src/index.test.ts` — exercises routes through `app.handle(new Request(...))`, no network.

`packages/db/`:

- `src/schema.ts` — Drizzle tables, exactly the columns `design.md` lists. Change `design.md` first.
- `src/index.ts` — `createDb(url)` over the `postgres` driver, and re-exports the schema.
- `drizzle.config.ts` — reads `DATABASE_URL`; `generate` and `check` work without it.
- `drizzle/` — generated by `bun run db:generate`. Commit the SQL and `meta/` together; never edit them by hand.

## Boundaries

- Product names, copy, and content in this repository are original. Do not imitate any existing language-learning product's brand or content, and do not name any company in docs, code, or commits.
- Real multi-region deployment, VoIP, media extraction, and recommendation are out of scope. Mention them only in the README's "Next" section.
- Korean strings and comments, where they appear, are intentional. Do not translate them.
- Commit messages and identifiers are in English.
