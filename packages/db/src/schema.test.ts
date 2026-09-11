import { describe, expect, it } from 'bun:test';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { PgTime } from 'drizzle-orm/pg-core';

import { users } from './schema';

describe('users schema', () => {
  it('maps to the users table', () => {
    expect(getTableName(users)).toBe('users');
  });

  it('has exactly the six columns design.md lists', () => {
    const columns = Object.values(getTableColumns(users)).map((column) => column.name);

    expect(columns.sort()).toEqual(
      ['created_at', 'email', 'expo_push_token', 'id', 'reminder_time', 'timezone'].sort(),
    );
  });

  it('stores reminder_time as a time column', () => {
    expect(users.reminderTime).toBeInstanceOf(PgTime);
  });

  it('allows expo_push_token to be null and nothing else', () => {
    const nullable = Object.values(getTableColumns(users))
      .filter((column) => !column.notNull)
      .map((column) => column.name);

    expect(nullable).toEqual(['expo_push_token']);
  });
});
