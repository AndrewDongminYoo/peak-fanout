import { describe, expect, it } from 'bun:test';

import { describeEmailCollision } from './seed';

describe('describeEmailCollision', () => {
  // The `seeded` flag means the seed never deletes a row it did not create, and the price is that
  // an address collision surfaces as a unique-index error instead. This turns that into a message
  // naming the address, so the refusal reads as a decision rather than a crash.
  const collision = {
    code: '23505',
    constraint_name: 'users_email_unique',
    detail: 'Key (email)=(load-0@example.test) already exists.',
  };

  it('names the colliding address and says nothing was changed', () => {
    const described = describeEmailCollision(collision);
    expect(described).toBeInstanceOf(Error);
    expect((described as Error).message).toContain('load-0@example.test');
    expect((described as Error).message).toContain('Nothing was changed');
    expect((described as Error).cause).toBe(collision);
  });

  it('passes every other failure through untouched, so a real fault is not disguised', () => {
    for (const other of [
      new Error('connection terminated'),
      { code: '23505', constraint_name: 'reminders_user_id_scheduled_at_unique' },
      { code: '23503', constraint_name: 'users_email_unique' },
      undefined,
    ]) {
      expect(describeEmailCollision(other)).toBe(other);
    }
  });
});
