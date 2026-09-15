# M3 part 3 implementation plan

## Owned paths

- `design.md`, `README.md`, and `AGENTS.md`
- `.env.example` and `package.json`
- `apps/api/src/cards/read-database.ts` and `apps/api/src/cards/read-database.test.ts`
- `apps/api/src/push/sender.ts` and `apps/api/src/push/sender.test.ts`
- `apps/api/src/worker/index.ts`
- `apps/api/src/load/run-log.ts` and `apps/api/src/load/run-log.test.ts`
- `apps/api/src/load/m1.ts` and `apps/api/src/load/m1.test.ts`
- `load/results/*-m3-*.json` created by this task

## Steps

1. Extend `design.md` before implementation with the schema-6 variant, sender, replica counter, filename, verdict, and evidence contracts.
2. Add focused sender and run-log tests for worker card provenance, variant validation, replica-block requirements, mode-specific notes, and filenames; run them and record the intended failures.
3. Implement the smallest sender and run-log changes that make those tests pass without touching the simulated sink or database schema.
4. Add harness configuration and window tests for `LOAD_VARIANT`, replica URL rules, standby verification, two counter samples, and variant-specific worker commands; observe their intended failures before implementation.
5. Wire one optional replica client into the existing harness and close both clients on every exit path.
6. Add root scripts for the three M3 timing variants and the cache-on replica restart run.
7. Run focused tests, `bun run check`, explicit-path formatting, `trunk check --all --no-fix`, and negative controls that prove the new refusal paths can fail.
8. Review the complete code candidate before any measured run and repair confirmed blockers sequentially.
9. Run cache-off primary, cache-off replica, cache-on replica, and cache-on replica restart experiments sequentially against Compose PostgreSQL, re-seeding and restarting detached sender processes between runs.
10. Validate every generated JSON against its declared variant, sender record, counter blocks, verdict, and restart contract; remove only superseded task-created failed-run artifacts.
11. Fill the M3 row and update the repository current-state section from the committed result files.
12. Run the final local gates and large-change adversarial review, create concern-grouped commits, push, open the PR, and process current-head CI and hosted review until ready for operator merge.

## Completion checks

```bash
bun run check
trunk check --all --no-fix
git diff --check
```

The database acceptance check is the four schema-6 JSON files plus direct primary and standby catalog and counter queries at the exact candidate.
