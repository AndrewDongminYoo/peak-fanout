// One tick of the enqueue scheduler: `SCHEDULER_MODE=enqueue`, the default since M2.
//
// The tick sends nothing. It materializes the current local day for ordinary users, unless
// seeded-only measurement mode is requested, then hands due ids to one statement that moves those
// reminders `pending -> queued` and inserts one `jobs` row per reminder it moved. The workers in
// `../worker/` do the sending.
// design.md "The enqueue tick" owns the contract; `tick.ts` stays the naive send, unchanged.
//
// Kept free of Drizzle and Bun-only imports so its tests run without Postgres.

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

/** The daily materialization, ids-only due read, and atomic enqueue statement. */
export interface EnqueueRepository {
  /** Insert ordinary users' current local day once, preserving any existing snapshot. */
  materializeOrdinary(now: Date): Promise<void>;
  /**
   * Reminder ids in scheduled order: due
   * (`scheduled_at <= now`) and `pending`, excluding load_pool rows, or seeded rows only when
   * `seededOnly` is set; one statement (design.md "The enqueue
   * tick"). Ids alone, because this tick sends nothing and reads no token.
   */
  dueReminderIds(now: Date, seededOnly?: boolean): Promise<string[]>;
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
  /** The measurement path: no ordinary materialization and seeded due rows only. */
  seededOnly?: boolean;
};

export type EnqueueTickResult = {
  due: number;
  enqueued: number;
  elapsedMs: number;
};

/**
 * Enqueue every due reminder.
 *
 * The ordinary path first materializes the local day. The seeded-only path keeps its one idle
 * read. Throwing is
 * left to the caller, as `runTick` leaves it: a tick that cannot reach the database is a tick
 * that failed, and the next one enqueues the same reminders because nothing moved.
 */
export async function enqueueTick({
  reminders,
  now,
  seededOnly = false,
}: EnqueueTickDeps): Promise<EnqueueTickResult> {
  const startedAt = Date.now();
  if (!seededOnly) await reminders.materializeOrdinary(now);
  const due = await reminders.dueReminderIds(now, seededOnly);
  if (due.length === 0) return { due: 0, enqueued: 0, elapsedMs: Date.now() - startedAt };

  const enqueued = await reminders.enqueue(due);
  return { due: due.length, enqueued, elapsedMs: Date.now() - startedAt };
}
