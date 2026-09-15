# M5 architecture diagram implementation plan

## Owned paths

- `README.md`
- `AGENTS.md`
- `docs/specs/2026-09-15-m5-architecture-diagram.md`
- `docs/plans/2026-09-15-m5-architecture-diagram.md`

## Steps

1. Freeze the diagram contract and non-goals in the spec.
2. Run a read-only validator that requires the new diagram markers and record the expected failure.
3. Add one Mermaid flowchart under the README `Architecture` section.
4. Add short prose that states the seeded-only scheduler scope, read fallback, and sink isolation.
5. Update the M5 part 3 current-state prose in `README.md` and `AGENTS.md` without marking M5 complete.
6. Run the same validator and verify that it passes.
7. Run `bun run check`, `trunk check --all --no-fix`, and `git diff --check`.
8. Review the complete diff against the current code and the frozen spec.
9. Create concern-grouped conventional commits.
10. Push the branch and open a pull request.
11. Process exact-head CI and hosted review findings within the recorded round budget.
12. Ask the operator to approve the rendered diagram at the exact PR head.
13. Stop for the operator to merge after all readiness gates pass.

## Completion checks

```bash
bun run check
trunk check --all --no-fix
git diff --check
```

The local checks do not send a notification and do not write to a device.
