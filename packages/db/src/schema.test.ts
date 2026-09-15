import { describe, expect, it } from 'bun:test';
import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
import { getTableConfig, PgDialect, PgTime } from 'drizzle-orm/pg-core';

import {
  deliveries,
  deliveryStatus,
  expressions,
  jobs,
  reminders,
  reminderState,
  users,
} from './schema';

const columnNames = (table: Table) =>
  Object.values(getTableColumns(table))
    .map((column) => column.name)
    .sort();

const nullableColumnNames = (table: Table) =>
  Object.values(getTableColumns(table))
    .filter((column) => !column.notNull)
    .map((column) => column.name);

describe('users schema', () => {
  it('maps to the users table', () => {
    expect(getTableName(users)).toBe('users');
  });

  it('has exactly the eight columns design.md lists', () => {
    expect(columnNames(users)).toEqual(
      [
        'created_at',
        'email',
        'expo_push_token',
        'id',
        'load_pool',
        'reminder_time',
        'seeded',
        'timezone',
      ].sort(),
    );
  });

  it('defaults seeded to false, so only the seed can claim a row', () => {
    // The seed's delete, materialize and verify all key on this flag, so a row the application
    // creates must start unmarked without the writer having to say so.
    expect(users.seeded.default).toBe(false);
    expect(users.seeded.notNull).toBe(true);
  });

  it('defaults load_pool to false, so only the load harness can claim a row', () => {
    // The harness's sweep and its delete key on this flag, and the harness is the only writer
    // that ever sets it: a row the application creates must start unmarked. It is a second
    // fixture flag and not a second seed flag — the API serves a `load_pool` row as the ordinary
    // user it is (design.md "The load harness owns its API pool the same way").
    expect(users.loadPool.default).toBe(false);
    expect(users.loadPool.notNull).toBe(true);
  });

  it('stores reminder_time as a time column', () => {
    expect(users.reminderTime).toBeInstanceOf(PgTime);
  });

  it('allows expo_push_token to be null and nothing else', () => {
    expect(nullableColumnNames(users)).toEqual(['expo_push_token']);
  });
});

describe('expressions schema', () => {
  it('has exactly the six columns design.md lists, none of them nullable', () => {
    expect(getTableName(expressions)).toBe('expressions');
    expect(columnNames(expressions)).toEqual(
      ['id', 'lang', 'level', 'position', 'text', 'translation'].sort(),
    );
    expect(nullableColumnNames(expressions)).toEqual([]);
  });

  it("holds one row per position, which is what the day's pick reads", () => {
    // A pick by position is a predicate the unique index serves (design.md "The day's cards");
    // the seed writes positions 1..n densely and nothing else writes the table. The constraint
    // is declared on the column, as `users.email`'s is, so it is read off the column here.
    expect(expressions.position.isUnique).toBe(true);
    expect(expressions.position.uniqueName).toBe('expressions_position_unique');
    expect(expressions.position.notNull).toBe(true);
    expect(getTableConfig(expressions).indexes).toHaveLength(0);
  });

  it('carries no seeded flag and no foreign key, because it has one writer and no parent', () => {
    // `users.seeded` tells a seed-written row from an application-written one; this table has
    // no application writer, so the whole-table delete is ownership (design.md "Data model").
    expect(columnNames(expressions)).not.toContain('seeded');
    expect(getTableConfig(expressions).foreignKeys).toHaveLength(0);
  });
});

describe('reminders schema', () => {
  it('has exactly the columns design.md lists, none of them nullable', () => {
    expect(getTableName(reminders)).toBe('reminders');
    expect(columnNames(reminders)).toEqual(
      ['created_at', 'id', 'scheduled_at', 'state', 'user_id'].sort(),
    );
    expect(nullableColumnNames(reminders)).toEqual([]);
  });

  it('starts in pending and walks pending, queued, then sent or failed', () => {
    // `queued` sits between pending and the terminal states: the enqueue tick writes it in the
    // statement that inserts the job, and a worker leaves it (design.md "reminders.state").
    expect(reminderState.enumValues).toEqual(['pending', 'queued', 'sent', 'failed']);
    expect(reminders.state.default).toBe('pending');
  });

  it('holds one row per user per scheduled instant', () => {
    const unique = getTableConfig(reminders).uniqueConstraints;

    expect(unique).toHaveLength(1);
    expect(unique[0]?.columns.map((column) => column.name)).toEqual(['user_id', 'scheduled_at']);
  });

  it('indexes the scheduler query: due and pending, ordered by scheduled_at', () => {
    const indexes = getTableConfig(reminders).indexes;

    expect(indexes).toHaveLength(1);
    expect(
      indexes[0]?.config.columns.map((column) => ('name' in column ? column.name : null)),
    ).toEqual(['scheduled_at']);
    // Partial: the index only carries the rows the scheduler is looking for.
    expect(indexes[0]?.config.where).toBeDefined();
  });

  it('goes away with its user', () => {
    const foreignKeys = getTableConfig(reminders).foreignKeys;

    expect(foreignKeys).toHaveLength(1);
    expect(foreignKeys[0]?.onDelete).toBe('cascade');
  });
});

describe('jobs schema', () => {
  it('has exactly the ten columns design.md lists', () => {
    expect(getTableName(jobs)).toBe('jobs');
    expect(columnNames(jobs)).toEqual(
      [
        'attempts',
        'dead_at',
        'done_at',
        'id',
        'kind',
        'last_error',
        'locked_at',
        'locked_by',
        'payload',
        'run_at',
      ].sort(),
    );
  });

  it('leaves nullable exactly what an open, unclaimed, never-failed job has not written yet', () => {
    expect(nullableColumnNames(jobs).sort()).toEqual(
      ['dead_at', 'done_at', 'last_error', 'locked_at', 'locked_by'].sort(),
    );
  });

  it('starts attempts at 0 and gives run_at no default, so every writer states the instant', () => {
    // run_at is the next permitted attempt and not the reminder's scheduled_at; a default would
    // let an insert leave it unsaid (design.md "Data model").
    expect(jobs.attempts.default).toBe(0);
    expect(jobs.attempts.notNull).toBe(true);
    expect(jobs.runAt.default).toBeUndefined();
    expect(jobs.runAt.notNull).toBe(true);
  });

  it('indexes the claim: open jobs ordered by run_at', () => {
    const indexes = getTableConfig(jobs).indexes;

    expect(indexes).toHaveLength(1);
    expect(
      indexes[0]?.config.columns.map((column) => ('name' in column ? column.name : null)),
    ).toEqual(['run_at']);
    // Partial on done_at IS NULL: a finished job leaves the index.
    expect(indexes[0]?.config.where).toBeDefined();
  });

  it('carries no foreign key, because the reminder lives in payload', () => {
    // Which is why the seed deletes the jobs of its reminders itself, done ones included
    // (design.md "The enqueue tick").
    expect(getTableConfig(jobs).foreignKeys).toHaveLength(0);
  });
});

describe('deliveries schema', () => {
  it('has exactly the columns design.md lists, with only error and sender nullable', () => {
    expect(getTableName(deliveries)).toBe('deliveries');
    expect(columnNames(deliveries)).toEqual(
      ['created_at', 'error', 'id', 'latency_ms', 'reminder_id', 'sender', 'status'].sort(),
    );
    expect(nullableColumnNames(deliveries)).toEqual(['error', 'sender']);
  });

  it('gives sender no default, so a row without a record says its sender recorded nothing', () => {
    // A default would be a value no sender wrote; NULL is what the verdict reads as "not the
    // pinned experiment" (design.md "Data model"). Nullable so migration 0005 applies to a table
    // already holding rows from an earlier run.
    expect(deliveries.sender.default).toBeUndefined();
    expect(deliveries.sender.notNull).toBe(false);
  });

  it('records only finished attempts, so it never holds pending', () => {
    expect(deliveryStatus.enumValues).toEqual(['sent', 'failed']);
    expect(deliveries.status.default).toBeUndefined();
  });

  it('rejects a negative latency while keeping zero valid', () => {
    const checks = getTableConfig(deliveries).checks;

    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe('deliveries_latency_ms_nonnegative');
    expect(new PgDialect().sqlToQuery(checks[0]!.value).sql).toBe('"deliveries"."latency_ms" >= 0');
  });

  it('goes away with its reminder', () => {
    const foreignKeys = getTableConfig(deliveries).foreignKeys;

    expect(foreignKeys).toHaveLength(1);
    expect(foreignKeys[0]?.onDelete).toBe('cascade');
  });
});
