import { describe, expect, it } from 'bun:test';
import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
import { getTableConfig, PgTime } from 'drizzle-orm/pg-core';

import { deliveries, deliveryStatus, reminders, reminderState, users } from './schema';

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

  it('has exactly the six columns design.md lists', () => {
    expect(columnNames(users)).toEqual(
      ['created_at', 'email', 'expo_push_token', 'id', 'reminder_time', 'timezone'].sort(),
    );
  });

  it('stores reminder_time as a time column', () => {
    expect(users.reminderTime).toBeInstanceOf(PgTime);
  });

  it('allows expo_push_token to be null and nothing else', () => {
    expect(nullableColumnNames(users)).toEqual(['expo_push_token']);
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

  it('starts in pending and holds no state outside the M1 set', () => {
    expect(reminderState.enumValues).toEqual(['pending', 'sent', 'failed']);
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

describe('deliveries schema', () => {
  it('has exactly the columns design.md lists, with only error nullable', () => {
    expect(getTableName(deliveries)).toBe('deliveries');
    expect(columnNames(deliveries)).toEqual(
      ['created_at', 'error', 'id', 'latency_ms', 'reminder_id', 'status'].sort(),
    );
    expect(nullableColumnNames(deliveries)).toEqual(['error']);
  });

  it('records only finished attempts, so it never holds pending', () => {
    expect(deliveryStatus.enumValues).toEqual(['sent', 'failed']);
    expect(deliveries.status.default).toBeUndefined();
  });

  it('goes away with its reminder', () => {
    const foreignKeys = getTableConfig(deliveries).foreignKeys;

    expect(foreignKeys).toHaveLength(1);
    expect(foreignKeys[0]?.onDelete).toBe('cascade');
  });
});
