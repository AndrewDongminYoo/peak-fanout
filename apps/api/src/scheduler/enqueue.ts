// One tick of the enqueue scheduler: `SCHEDULER_MODE=enqueue`, the default since M2.
//
// The tick sends nothing. It asks the same due-and-pending question the naive tick asks, then
// hands the ids to one statement that moves those reminders `pending -> queued` and inserts one
// `jobs` row per reminder it moved. The workers in `../worker/` do the sending.
// design.md "The enqueue tick" owns the contract; `tick.ts` stays the naive send, unchanged.
//
// Kept free of Drizzle and Bun-only imports so its tests run without Postgres.

import type { RemindersRepository } from './tick';

/** The one job kind in the repository. A worker refuses a row of any other kind, loudly. */
export const SEND_REMINDER_KIND = 'send_reminder';

/**
 * What a `send_reminder` job's `payload` holds. The column is untyped jsonb in the schema; this
 * is the shape the enqueue statement writes, so the type lives here beside it.
 */
export type SendReminderPayload = {
  reminder_id: string;
};

/** Whether a row read back from `jobs` is a `send_reminder` job with the payload this tick writes. */
export function isSendReminderJob(job: {
  kind: string;
  payload: unknown;
}): job is { kind: typeof SEND_REMINDER_KIND; payload: SendReminderPayload } {
  if (job.kind !== SEND_REMINDER_KIND) return false;
  const payload = job.payload;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as Record<string, unknown>).reminder_id === 'string'
  );
}

/** The persistence one enqueue tick needs: the naive tick's due query, plus the enqueue statement. */
export interface EnqueueRepository extends Pick<RemindersRepository, 'dueReminders'> {
  /**
   * One statement: those reminders `pending -> queued`, and one `send_reminder` job per reminder
   * it moved, with `run_at = now()`. Returns how many jobs it inserted, which is how many
   * reminders were still `pending` — a reminder another writer moved first is skipped, not
   * enqueued twice (design.md "The enqueue tick").
   */
  enqueue(reminderIds: string[]): Promise<number>;
}

export type EnqueueTickDeps = {
  reminders: EnqueueRepository;
  /** The instant this tick treats as the current time; the runner passes the wall clock. */
  now: Date;
};

export type EnqueueTickResult = {
  due: number;
  enqueued: number;
  elapsedMs: number;
};

/**
 * Enqueue every due reminder.
 *
 * Nothing due means no write at all, so an idle scheduler costs one read per tick. Throwing is
 * left to the caller, as `runTick` leaves it: a tick that cannot reach the database is a tick
 * that failed, and the next one enqueues the same reminders because nothing moved.
 */
export async function enqueueTick({ reminders, now }: EnqueueTickDeps): Promise<EnqueueTickResult> {
  const startedAt = Date.now();
  const due = await reminders.dueReminders(now);
  if (due.length === 0) return { due: 0, enqueued: 0, elapsedMs: Date.now() - startedAt };

  const enqueued = await reminders.enqueue(due.map((reminder) => reminder.id));
  return { due: due.length, enqueued, elapsedMs: Date.now() - startedAt };
}
