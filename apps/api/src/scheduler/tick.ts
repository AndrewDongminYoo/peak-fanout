// One tick of the naive M1 send.
//
// READ THE INTENT BEFORE THE LOOP. This is deliberately the shape a first implementation would
// have: one process, one reminder at a time, nothing claimed — no SKIP LOCKED, no batching, no
// retry, no backoff, no dead-letter, no graceful shutdown. design.md "What M1 deliberately does
// not do" decided that, and design.md "The scheduler" owns this contract. The measured numbers in
// README.md only mean something if the baseline really is the naive one, so an optimization here
// is a change to the experiment, not an improvement to the code.
//
// The one non-obvious constraint: `recordAttempt` must be one transaction per attempt.
// `deliveries.created_at` defaults to `now()`, which in Postgres is the transaction timestamp, so
// several attempts recorded in one transaction would share a timestamp and collapse the fan-out
// duration this milestone exists to measure.

import { PushSendError, type PushMessage, type PushSink } from '../push/sink';

/** A reminder the tick is about to send, with the token the sink is handed. */
export type DueReminder = {
  id: string;
  scheduledAt: Date;
  /** `users.expo_push_token`, which is null for every seeded user. */
  pushToken: string | null;
};

export type DeliveryAttempt = {
  reminderId: string;
  status: 'sent' | 'failed';
  latencyMs: number;
  /** The send failure, or null on success; `deliveries.error` holds it. */
  error: string | null;
};

/** The persistence one tick needs. Tests pass an in-memory one, `index.ts` passes Drizzle. */
export interface RemindersRepository {
  /**
   * Due (`scheduled_at <= now`) and `pending`, ordered by `scheduled_at`, seeded rows only.
   * design.md "The scheduler" says why the seeded flag is part of the query.
   */
  dueReminders(now: Date): Promise<DueReminder[]>;
  /** One `deliveries` row plus that reminder's terminal state, in one transaction. */
  recordAttempt(attempt: DeliveryAttempt): Promise<void>;
}

export type TickDeps = {
  reminders: RemindersRepository;
  sink: PushSink;
  /** The instant this tick treats as the current time; the runner passes the wall clock. */
  now: Date;
};

export type TickResult = {
  due: number;
  sent: number;
  failed: number;
  elapsedMs: number;
};

/** The copy every M1 reminder carries. The demo's domain is not the point of the repository. */
export const REMINDER_MESSAGE: PushMessage = {
  title: 'Three expressions are waiting',
  body: 'Two minutes tonight beats an hour on the weekend.',
};

function describeSendFailure(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Send every due reminder, one at a time, and record each attempt.
 *
 * Throwing is left to the caller: a tick that cannot reach the database is a tick that failed,
 * and M1 has no retry to hide it behind.
 *
 * Only the send is caught. `recordAttempt` sits outside the catch on purpose: when it is inside,
 * a database error while recording a send that SUCCEEDED lands in the failure branch, which
 * records that same reminder a second time as `failed` with a latency of 0 and the database's
 * error text in `deliveries.error` — a push that went out, written down as a push that did not,
 * in exactly the columns this milestone exists to measure. A database error now propagates
 * instead, which is what the paragraph above says a failed tick does.
 */
export async function runTick({ reminders, sink, now }: TickDeps): Promise<TickResult> {
  const startedAt = Date.now();
  const due = await reminders.dueReminders(now);
  let sent = 0;
  let failed = 0;

  for (const reminder of due) {
    let attempt: DeliveryAttempt;
    try {
      const { latencyMs } = await sink.send(reminder.pushToken, REMINDER_MESSAGE);
      attempt = { reminderId: reminder.id, status: 'sent', latencyMs, error: null };
    } catch (error) {
      attempt = {
        reminderId: reminder.id,
        status: 'failed',
        latencyMs: error instanceof PushSendError ? error.latencyMs : 0,
        error: describeSendFailure(error),
      };
    }

    await reminders.recordAttempt(attempt);
    if (attempt.status === 'sent') sent += 1;
    else failed += 1;
  }

  return { due: due.length, sent, failed, elapsedMs: Date.now() - startedAt };
}
