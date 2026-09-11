import { pgTable, text, time, timestamp, uuid } from 'drizzle-orm/pg-core';

// design.md "Data model": users id, email, timezone, reminder_time (time), expo_push_token?, created_at
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  timezone: text('timezone').notNull().default('UTC'),
  reminderTime: time('reminder_time').notNull().default('21:00'),
  expoPushToken: text('expo_push_token'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
