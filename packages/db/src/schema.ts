import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// design.md "Data model": users id, email, timezone, reminder_time (time), expo_push_token?, seeded, created_at
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  timezone: text('timezone').notNull().default('UTC'),
  reminderTime: time('reminder_time').notNull().default('21:00'),
  expoPushToken: text('expo_push_token'),
  // design.md "The seed owns its rows by a recorded flag, not by their address": true only for
  // a row `bun run db:seed` wrote. The seed's delete, materialize and verify all key on it,
  // because no predicate over `email` can tell a seed-written row from a login at that address.
  seeded: boolean('seeded').notNull().default(false),
  // design.md "The load harness owns its API pool the same way": true only for a row the load
  // harness wrote for its own `GET /me` traffic. The harness's sweep and its delete key on it,
  // for the same reason `seeded` exists. The API never reads it — a pool row is an ordinary user
  // and has to be served as one, which is the single way the two fixture flags differ.
  loadPool: boolean('load_pool').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// design.md "Reminders and delivery (M1)": pending on insert, then sent or failed. No other values in M1.
export const reminderState = pgEnum('reminder_state', ['pending', 'sent', 'failed']);

// A deliveries row exists only after an attempt finished, so it never holds pending.
export const deliveryStatus = pgEnum('delivery_status', ['sent', 'failed']);

// design.md "Data model": reminders id, user_id, scheduled_at (timestamptz, UTC), state, created_at
export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    state: reminderState('state').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per user per scheduled instant; with one materialization run per date, one row per user per date.
    unique('reminders_user_id_scheduled_at_unique').on(table.userId, table.scheduledAt),
    // The scheduler's only query: due and pending, ordered by scheduled_at.
    index('reminders_pending_scheduled_at_idx')
      .on(table.scheduledAt)
      .where(sql`${table.state} = 'pending'`),
  ],
);

// design.md "Data model": deliveries id, reminder_id, status, latency_ms, error?, created_at
export const deliveries = pgTable('deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  reminderId: uuid('reminder_id')
    .notNull()
    .references(() => reminders.id, { onDelete: 'cascade' }),
  status: deliveryStatus('status').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;
export type Delivery = typeof deliveries.$inferSelect;
export type NewDelivery = typeof deliveries.$inferInsert;
