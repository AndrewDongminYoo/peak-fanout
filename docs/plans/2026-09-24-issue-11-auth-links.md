# Issue 11 authenticated links implementation plan

## Owned paths

- `design.md`, `README.md`, and `supabase/config.toml`
- `apps/mobile/app.json`, `apps/mobile/src/lib/supabase.ts`, `apps/mobile/src/lib/auth-callback.ts`, `apps/mobile/src/lib/sign-in.ts`, `apps/mobile/src/app/auth/callback.tsx`, and focused mobile tests
- `apps/auth-links` and its Vercel configuration

## Steps

1. Use the approved `peak-fanout-links.vercel.app` production alias and obtain the Android signing fingerprint for package `kr.donminzzi.peakfanout`.
2. Update the login and callback contract in `design.md` before changing code; define the HTTPS route, URL rejection, success, empty, and error states.
3. Add focused failing tests for PKCE code parsing, wrong-host and legacy-link rejection, missing verifier, ordered attempts, account switch cleanup, and repeat handling.
4. Configure Supabase PKCE and exchange the callback code, preserving the session lane and app-user upsert behavior.
5. Add the two verified-link configurations and association files with actual app identifiers; update the narrow Supabase redirect allow-list.
6. Deploy the static host and inspect HTTP status, redirects, content type, JSON fields, and the final domain; test native link routing and a local Auth email flow.
7. Update the README's setup instructions, run focused tests and explicit-path formatting, then run `bun run check`, `trunk check --all --no-fix`, and `git diff --check`.
8. Review the complete candidate against the issue and contract, commit by concern, push, open the PR, and process current-head CI and hosted findings until ready for operator merge.

## Completion checks

```bash
bun --cwd=apps/mobile test
bun run check
trunk check --all --no-fix
git diff --check
```

The HTTP and native-link checks must read the deployed host and installed app; local JSON validation alone cannot prove either association works.
