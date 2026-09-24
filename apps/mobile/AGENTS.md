# Mobile agent rules

These rules apply to `apps/mobile/**` in addition to the repository root `AGENTS.md`.

## Required context

Before writing Expo, EAS, or React Native code:

1. Read the installed Expo major from `package.json`.
2. Read the matching official Expo documentation.
3. Use the current source and colocated tests instead of relying on an SDK behavior from memory.

Run Expo commands from `apps/mobile` with `bunx`, not `npx`.
Prefer Expo modules over third-party native dependencies.
Use `bunx eas-cli <command>` where documentation uses `eas <command>`.

## Architecture

- Expo Router owns navigation.
  Route files belong in `src/app/`, `_layout.tsx` owns navigators, and components, hooks, constants, and libraries stay outside the route tree.
- Typed routes and React Compiler are enabled in `app.json`.
  Preserve both unless the task changes that configuration explicitly.
- Continuous Native Generation is enabled.
  Configure native behavior through `app.json` and config plugins; do not edit generated `ios/` or `android/` directories.
- A dependency with native code requires a development build rather than Expo Go.
- Expo-pinned packages move through `bunx expo install --fix`, with `node_modules/expo/bundledNativeModules.json` as the compatibility authority.
  Do not merge a Dependabot bump that raises an Expo-pinned package's manifest range; a `bun.lock`-only update inside the declared range is the SDK's own patch and may merge, and `.github/dependabot.yml` keeps Dependabot to that class.
- `@peak-fanout/api` is a type-only workspace dependency.
  Keep server values, Elysia runtime code, Bun-only imports, and database imports out of the mobile bundle.
- Use `@/*` and `@/assets/*` aliases for non-relative imports.
- Check for a `.web.*` twin whenever a native implementation changes.
- Use theme constants instead of literal colors.

The Supabase redirect allow-list entry is the HTTPS callback path with an `sb_flow_id` query wildcard; see `supabase/config.toml`.
Do not commit the generated `expo-env.d.ts` file.

## Verification

Run targeted mobile tests while iterating, then the root gate.
When changing `src/lib/api.ts`, export the web bundle and verify that server runtime code such as `elysia` is absent from `dist/`.
