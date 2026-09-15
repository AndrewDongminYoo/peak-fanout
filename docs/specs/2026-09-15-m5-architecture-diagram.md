# M5 architecture diagram

## Problem

The M5 milestone requires one architecture diagram, but `README.md` has no diagram.
The repository already contains the final measurement table and the implemented M0 through M5 part 2 paths.
A reader must currently reconstruct the runtime and measurement topology from several prose sections.

## Scope

- Add one Mermaid flowchart under `README.md` `Architecture`.
- Show the current mobile, authentication, API, scheduler, worker, cache, database, push, and load-harness paths.
- Distinguish primary writes from replica-tolerant reads.
- Distinguish the simulated measurement sink from the opt-in Expo sink.
- Update the current-state sections in `README.md` and `AGENTS.md` for M5 part 3.

## Non-goals

- Do not change a screen, API, data, environment, or command contract.
- Do not implement `GET /admin/queue` or a dashboard.
- Do not add ordinary-user reminder materialization.
- Do not change a measurement or run log.
- Do not send an Expo notification or write to a physical device.
- Do not mark M5 complete.

## Diagram contract

The diagram describes the implemented system at the current revision.
It contains these paths:

1. The Expo mobile app uses Supabase Auth for magic-link authentication.
2. The mobile app calls the Elysia API with the access token.
3. The API reads and writes user identity and settings on the primary database.
4. The API reads cards and the shared delivery sample through the read path.
5. The scheduler enqueues due seeded reminders on the primary database.
6. The worker fleet claims jobs and records outcomes on the primary database.
7. The API and workers read cards through the cards service and a per-process LRU cache.
8. The primary database streams WAL to the read replica.
9. The read path uses the primary when `DATABASE_READ_URL` is unset and uses the configured read endpoint when it is set.
10. Each worker verifies that a configured read endpoint is a replica before it claims a job.
11. Workers use the simulated sink by default and use the Expo sink only when `PUSH_SINK=expo`.
12. The explicit `bun run push:expo` command sends one message through the Expo sink.
13. The load harness drives API traffic and samples the databases while the operator runs the sender processes.

The diagram labels the scheduler path as measurement-only because current enqueue SQL selects `users.seeded` rows.
The diagram does not imply that an ordinary application user enters that queue.
The diagram labels the simulated sink as the source of committed measurements.
The Expo sink remains an opt-in provider path with real-device observation pending.

## Acceptance criteria

1. GitHub Markdown renders one Mermaid flowchart in the README `Architecture` section.
2. Every diagram node and edge maps to current code, configuration, or committed infrastructure.
3. The primary, read route, and replica relationship is explicit.
4. The scheduler and worker path is explicit and remains limited to seeded measurement reminders.
5. The diagram distinguishes the simulated measurement sink from the opt-in Expo sink.
6. `README.md` and `AGENTS.md` keep M5 in progress and record M5 part 3.
7. An adversarial contract check rejects a diagram that omits the measurement-only scheduler label, read fallback, or sink distinction.
8. `bun run check`, `trunk check --all --no-fix`, and `git diff --check` pass.

## Visual acceptance

The operator must approve the rendered Mermaid diagram at the exact PR head before merge readiness.
CI and text inspection do not replace this visual approval.
