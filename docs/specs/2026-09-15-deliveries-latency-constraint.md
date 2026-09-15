# Deliveries latency constraint

## Problem

`deliveries.latency_ms` is the source for send-cost and fan-out measurements, but the database currently accepts negative values.
The simulated and Expo push sinks now both have paths that write this column, so the database must reject an impossible latency regardless of which sender produced it.

## Scope

- State the nonnegative latency contract in `design.md`.
- Add one named PostgreSQL check constraint through the Drizzle schema.
- Generate the migration with the repository command.
- Verify the constraint through both schema inspection and PostgreSQL behavior.

## Non-goals

- Do not change how a push sink measures latency.
- Do not change the relationship between delivery status and error text.
- Do not rewrite existing delivery rows during migration.
- Do not add mobile push-token registration or send a real notification.
- Do not change the state of GitHub issue #16.

## Acceptance criteria

1. `deliveries.latency_ms` has a named check constraint requiring a value greater than or equal to zero.
2. A latency of zero remains valid.
3. A negative latency fails at the PostgreSQL constraint boundary.
4. The generated migration contains the same named predicate and passes the migration-history check.
5. The repository gates pass without changing push-sink behavior or committed measurement results.

## Material constraints

The Drizzle schema is the migration source and generated migration files are not edited by hand.
Applying the migration to a database that already contains a negative latency must fail instead of silently replacing evidence used by the measurement harness.
No visual approval is required because this change has no rendered output.
