# M5 Expo push sink implementation plan

## Owned paths

- `design.md`, `README.md`, and `AGENTS.md`
- `.env.example`, `package.json`, `apps/api/package.json`, and `bun.lock`
- `apps/api/src/push/expo.ts` and `apps/api/src/push/expo.test.ts`
- `apps/api/src/push/sender.ts` and `apps/api/src/push/sender.test.ts`
- `apps/api/src/push/send-expo.ts` and `apps/api/src/push/send-expo.test.ts`
- `apps/api/src/worker/index.ts`
- `apps/api/src/load/m1.ts` and `apps/api/src/load/m1.test.ts`

## Steps

1. Extend `design.md` before implementation with provider selection, credential handling, failure, provenance, measurement-isolation, and one-message contracts.
2. Add focused tests for sink selection, token validation, payload delivery, ticket handling, sender provenance, load command isolation, and one-message configuration.
3. Run the focused tests and record that they fail because the new behavior is absent.
4. Add `expo-server-sdk` through the API workspace and regenerate `bun.lock` with Bun.
5. Implement the smallest Expo sink and one-message command that satisfy the tests.
6. Wire the worker selector without changing the naive scheduler or simulated sink.
7. Make the existing load worker command select `PUSH_SINK=simulated` and update its focused test.
8. Update environment documentation and current-state documentation without claiming that a real device received a notification.
9. Run focused tests, explicit-path formatting, `bun run check`, `trunk check --all --no-fix`, and `git diff --check`.
10. Review the complete candidate, create concern-grouped conventional commits, push the branch, open the pull request, and process current-head CI and hosted review until the branch is ready for operator merge.

## Completion checks

```bash
bun test apps/api/src/push/expo.test.ts apps/api/src/push/send-expo.test.ts apps/api/src/push/sender.test.ts apps/api/src/load/m1.test.ts
bun run check
trunk check --all --no-fix
git diff --check
```

The local checks must not call the Expo Push API.
The external device check remains pending after this pull request.
