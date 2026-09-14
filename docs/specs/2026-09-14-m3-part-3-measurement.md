# M3 part 3 measurement

<!-- cspell:words nohup -->

## Problem

M3 routes card reads through a configurable cache and read database, but the measurement row is blank.
The schema-5 harness records only primary database counters and cannot identify the cache and read route that each worker used.
It also writes one topology note for both naive and queue runs, which makes a naive log mention workers that did not run.

## Scope

- Add one explicit load variant to every schema-6 run while retaining `LOAD_MODE` as the sender-mode contract.
- Add three M3 timing variants: cache off with primary reads, cache off with replica reads, and cache on with replica reads.
- Add one M3 restart run using cache-on replica reads.
- Record the cache configuration and cards read database in every worker delivery's sender record.
- Sample `xact_commit + xact_rollback` twice through `DATABASE_READ_URL` for replica variants and write the result in a separate `replica` block.
- Use a mode-specific run note and variant-specific result filename.
- Commit the four successful schema-6 logs and fill the M3 row from the cache-on replica timing and restart logs.
- Cite both cache-off controls in the README interpretation.

## Non-goals

- Do not change the cards query, cache implementation, replica topology, push latency distribution, queue behavior, or API traffic generator.
- Do not edit or replace schema-5 M1 and M2 result files.
- Do not add Redis, a provider SDK, a screen, or an M5 feature.
- Do not close issue #29 without separate issue-closure authority.

## Contract

`LOAD_VARIANT` is required for schema-6 runs and must agree with `LOAD_MODE`.
The supported values are `m1-naive`, `m2-queue`, `m3-primary-cache-off`, `m3-replica-cache-off`, and `m3-replica-cache-on`.
Only the last three values produce M3 logs.
The restart switch remains separate and is valid only in queue mode; the M3 restart command pairs it with `m3-replica-cache-on`.

Primary variants require `DATABASE_READ_URL` to be absent so a stale shell or `.env` value cannot silently route cards elsewhere.
Replica variants require a loopback `DATABASE_READ_URL` whose server reports `pg_is_in_recovery() = true` before the harness changes fixture state.
The harness samples that connection at the same two window boundaries as the primary counter.

The worker sender record contains the simulated sink settings, the full cards cache configuration, and `read_database` as `primary` or `replica`.
A replica worker verifies its own connected server is in recovery before it claims any job and records a credential-free `read_endpoint`.
The replica counter block records the same endpoint, so the verdict refuses a worker that sent from a different standby or a primary behind a separate URL.
The schema-6 verdict builds the expected record from pinned defaults and the declared variant, never from the harness process's cache environment.
The naive sender record remains free of worker-only card settings.

## Acceptance criteria

1. Invalid, missing, or mode-incompatible variants fail before a database client opens.
2. Replica variants fail before fixture mutation when `DATABASE_READ_URL` is absent, non-loopback, or not a standby, and each worker refuses to send when its own read URL is not a standby.
3. Primary variants write no replica block, and replica variants cannot write a log without two complete replica counter samples.
4. The sender-record verdict fails for the wrong cache switch or cards read database even when every delivery and timing check passes.
5. Schema-6 notes describe the actual mode, filenames identify the variant, restart filenames add `-restart`, and the restart switch is accepted only for `m2-queue` and `m3-replica-cache-on`.
6. The three timing logs and one restart log pass every verdict check and retain the pinned simulated sink distribution.
7. README fills the M3 row only from committed logs and explains that the replica transaction comparison demonstrates the cache effect while the cache's stale revalidation remains test evidence.

## Operational constraints

Run Compose, API, harness, scheduler, and four workers on this machine only.
Run one heavy experiment at a time and re-seed between runs after every sender process has stopped.
Start each measured process detached with `nohup` and retain its scratch log until the JSON and process exit are verified.
Stop the project Compose stack after the final database checks while preserving its named volumes.
