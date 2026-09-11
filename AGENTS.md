# AGENTS.md

Operating rules for every coding agent (Claude Code, Codex, or a human following the same gate) in this repository.
`CLAUDE.md` imports this file, so keep all shared guidance here and nothing in `CLAUDE.md` that would drift from it.

## What this repository is

**PeakCall** is a language-learning reminder demo.
A user picks a daily time such as 21:00, and at that time the backend picks three expression cards and sends one push notification.
The point of the demo is not the domain.
It is the fan-out problem: tens of thousands of reminders fall on the same evening minute, and the repository shows, with measured numbers, how a job queue, a cache, and a read replica absorb that peak.

`README.md` owns the plan: stack decisions, target layout, data model, API surface, milestones, and the measurement table.
Read it before any change that is larger than a typo.
This file owns only the rules for working here.

## Current state versus target state

The repository is at **pre-M0**.
It is a single Expo SDK 57 app at the repository root, generated from the Expo template and lightly branded.
There is no API, no database package, and no `load/` directory yet.
`design.md` exists with the API and data contracts, but its Screens section is still empty.

The target is the Bun workspaces monorepo described in `README.md` under "Target layout".
Do not describe that layout as if it existed.
When you move the app into `apps/mobile`, update this section in the same commit.

## Gate rules

These rules are the deliverable of the repository as much as the code is.
They exist so that a pull request from a non-developer, written with an agent, is filtered by the repository before a person reads it.

1. **`design.md` is the single source of truth for screens, API, and data contracts.**
   Change `design.md` first, then change code.
   Give `design.md` to any agent as context before it touches a contract.
   Its Screens section is empty. Fill it before building the first screen in M0.
2. **Every agent-produced change must pass `bun run check` before it is committed.**
   Today `check` is typecheck + lint.
   Extend it with test and `drizzle-kit check` as those tools arrive, in the same commit that adds them.
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

The project uses Bun (`bun.lock` is present).
Use `bunx`, not `npx`, for every Expo command.

```bash
bun install                      # install dependencies
bunx expo start                  # dev server (press i / a / w for iOS / Android / web)
bun run ios                      # expo start --ios
bun run android                  # expo start --android
bun run web                      # expo start --web
bun run check                    # the gate: typecheck + lint
bun run typecheck                # tsc --noEmit (creates expo-env.d.ts first if missing)
bun run lint                     # expo lint
bunx expo-doctor                 # dependency and config diagnosis
bunx expo install <package>      # add a dependency at the SDK-compatible version
bunx expo install --fix          # repair incompatible versions
trunk fmt && trunk check         # formatting and lint gate (also runs as git hooks)
```

There is no test runner yet.
Run `bun run check` before declaring any task done.

`tsc` depends on `expo-env.d.ts`, which is gitignored and normally generated the first time the dev server starts.
The `typecheck` script writes the same one-line file when it is missing, so a fresh clone typechecks without starting Metro.
Do not commit `expo-env.d.ts`.

Trunk is configured in `.trunk/trunk.yaml` with `trunk-fmt-pre-commit` and `trunk-check-pre-push` hooks.
Enabled linters are prettier, markdownlint, checkov, git-diff-check, oxipng, svgo, and trufflehog.
Prettier settings live in `.prettierrc.mjs`: 2-space indent, single quotes, print width 100.

## Expo rules

Expo ships breaking changes every SDK release, and this project is on **SDK 57** with React Native 0.86, React 19.2, and TypeScript 6.
Do not write Expo, EAS, or React Native code from memory.

1. Confirm the major version in `package.json`.
2. Read the matching docs at `https://docs.expo.dev/versions/v57.0.0/`.
3. For anything else, start from `https://docs.expo.dev/llms.txt` and follow its links.

Rules that follow from the project setup:

- **Expo Router owns navigation.** Routes live in `src/app/`. Every file there is a screen, and `_layout.tsx` defines the navigator. Keep components, hooks, and constants outside `src/app/`.
- `app.json` enables `typedRoutes` and `reactCompiler` under `experiments`. Route names are type-checked, so a renamed file surfaces as a compile error.
- **Continuous Native Generation is on.** `ios/` and `android/` are gitignored and generated. Configure native behavior in `app.json` and config plugins, never by editing generated folders.
- Expo Go covers only its bundled native modules. After adding a library with native code, use a development build: `bunx expo run:ios`, `bunx expo run:android`, or `bunx eas-cli build --profile development`.
- Prefer Expo modules over third-party libraries, and check the available skills before adding a dependency.
- For EAS, run `bunx eas-cli <command>` where the docs say `eas <command>`.

## Code layout (current app)

- `src/app/` — routes. `_layout.tsx` wraps the app in `ThemeProvider` and renders `AppTabs`. `index.tsx` and `explore.tsx` are the two tabs.
- `src/components/app-tabs.tsx` — the tab bar, built on `NativeTabs` from `expo-router/unstable-native-tabs`. It is an unstable API. Check the SDK 57 docs before changing it.
- `src/components/` — themed primitives (`ThemedText`, `ThemedView`) and template widgets.
- `src/constants/theme.ts` — `Colors` (light and dark), `Fonts`, spacing, and layout constants. Use these instead of literal colors.
- `src/hooks/` — `useColorScheme` and `useTheme`.
- **Platform splits use file suffixes.** `app-tabs.web.tsx`, `animated-icon.web.tsx`, and `use-color-scheme.web.ts` replace their native twins on web. When you change a native file, check whether a `.web.*` twin needs the same change.
- **Path aliases:** `@/*` maps to `./src/*` and `@/assets/*` maps to `./assets/*` (see `tsconfig.json`). Use them for every non-relative import.

## Boundaries

- Product names, copy, and content in this repository are original. Do not imitate any existing language-learning product's brand or content, and do not name any company in docs, code, or commits.
- Real multi-region deployment, VoIP, media extraction, and recommendation are out of scope. Mention them only in the README's "Next" section.
- Korean strings and comments, where they appear, are intentional. Do not translate them.
- Commit messages and identifiers are in English.
