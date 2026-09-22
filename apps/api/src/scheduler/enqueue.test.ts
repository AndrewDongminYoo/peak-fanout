import { describe, expect, it } from 'bun:test';

import {
  enqueueTick,
  isSendReminderJob,
  SEND_REMINDER_KIND,
  type EnqueueRepository,
} from './enqueue';

const PEAK = new Date('2026-09-15T12:00:00.000Z');
const LATER = new Date('2026-09-15T12:01:00.000Z');

type Row = {
  id: string;
  scheduledAt: Date;
  state: 'pending' | 'queued' | 'sent' | 'failed';
};

type Job = { kind: string; payload: { reminder_id: string }; runAt: Date; attempts: number };

/**
 * Reminders and jobs in memory, under the same predicates the Drizzle repository runs: the due
 * query is `pending` and `scheduled_at <= now`, and the enqueue statement moves only rows that are
 * still `pending`, inserting one job per row it moved.
 */
function createMemoryQueue(rows: Row[], now: Date) {
  const jobs: Job[] = [];
  const enqueueCalls: string[][] = [];
  const repository: EnqueueRepository = {
    async dueReminderIds(at) {
      return rows
        .filter((row) => row.state === 'pending' && row.scheduledAt <= at)
        .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
        .map(({ id }) => id);
    },
    async enqueue(reminderIds) {
      enqueueCalls.push(reminderIds);
      let inserted = 0;
      for (const id of reminderIds) {
        const row = rows.find((candidate) => candidate.id === id);
        if (!row || row.state !== 'pending') continue;
        row.state = 'queued';
        jobs.push({
          kind: SEND_REMINDER_KIND,
          payload: { reminder_id: id },
          runAt: now,
          attempts: 0,
        });
        inserted += 1;
      }
      return inserted;
    },
  };
  return { repository, rows, jobs, enqueueCalls };
}

function reminder(id: string, state: Row['state'] = 'pending', scheduledAt = PEAK): Row {
  return { id, scheduledAt, state };
}

describe('enqueueTick', () => {
  it('turns every due and pending reminder into a job and queued, in one repository call', async () => {
    const queue = createMemoryQueue([reminder('a'), reminder('b'), reminder('c')], PEAK);

    const result = await enqueueTick({ reminders: queue.repository, now: PEAK });

    expect(result).toMatchObject({ due: 3, enqueued: 3 });
    expect(queue.enqueueCalls).toEqual([['a', 'b', 'c']]);
    expect(queue.rows.map((row) => row.state)).toEqual(['queued', 'queued', 'queued']);
    expect(queue.jobs.map((job) => job.payload.reminder_id)).toEqual(['a', 'b', 'c']);
    // run_at is the enqueue instant, not the reminder's scheduled_at, and attempts start at 0.
    expect(queue.jobs.every((job) => job.kind === SEND_REMINDER_KIND && job.attempts === 0)).toBe(
      true,
    );
  });

  it('makes no enqueue call when nothing is due', async () => {
    const queue = createMemoryQueue([reminder('a', 'pending', LATER)], PEAK);

    const result = await enqueueTick({ reminders: queue.repository, now: PEAK });

    expect(result).toMatchObject({ due: 0, enqueued: 0 });
    expect(queue.enqueueCalls).toEqual([]);
    expect(queue.jobs).toEqual([]);
  });

  it('does not enqueue a reminder that is already queued, sent or failed', async () => {
    const queue = createMemoryQueue(
      [reminder('q', 'queued'), reminder('s', 'sent'), reminder('f', 'failed'), reminder('p')],
      PEAK,
    );

    const result = await enqueueTick({ reminders: queue.repository, now: PEAK });

    expect(result).toMatchObject({ due: 1, enqueued: 1 });
    expect(queue.enqueueCalls).toEqual([['p']]);
    expect(queue.jobs.map((job) => job.payload.reminder_id)).toEqual(['p']);
    expect(queue.rows.map((row) => row.state)).toEqual(['queued', 'sent', 'failed', 'queued']);
  });

  it('reports fewer enqueued than due when a reminder moved between the two statements', async () => {
    // The statement's `state = 'pending'` predicate is the guarantee; the tick only reports it.
    const queue = createMemoryQueue([reminder('a'), reminder('b')], PEAK);
    const racing: EnqueueRepository = {
      dueReminderIds: (at) => queue.repository.dueReminderIds(at),
      async enqueue(ids) {
        const b = queue.rows.find((row) => row.id === 'b');
        if (b) b.state = 'sent';
        return queue.repository.enqueue(ids);
      },
    };

    const result = await enqueueTick({ reminders: racing, now: PEAK });

    expect(result).toMatchObject({ due: 2, enqueued: 1 });
    expect(queue.jobs.map((job) => job.payload.reminder_id)).toEqual(['a']);
  });

  it('sends nothing: the repository is the only dependency', async () => {
    // Structural, but it is the whole point of the mode: there is no sink in the deps type, so a
    // tick that tried to send would not compile. The runtime check is that only two operations
    // are ever called.
    const calls: string[] = [];
    const repository: EnqueueRepository = {
      async dueReminderIds() {
        calls.push('dueReminderIds');
        return ['a'];
      },
      async enqueue() {
        calls.push('enqueue');
        return 1;
      },
    };

    await enqueueTick({ reminders: repository, now: PEAK });

    expect(calls).toEqual(['dueReminderIds', 'enqueue']);
  });
});

describe('isSendReminderJob', () => {
  it('accepts the shape the enqueue statement writes', () => {
    expect(isSendReminderJob({ kind: 'send_reminder', payload: { reminder_id: 'r1' } })).toBe(true);
  });

  it('refuses another kind, a missing id, and a payload that is not an object', () => {
    expect(isSendReminderJob({ kind: 'send_digest', payload: { reminder_id: 'r1' } })).toBe(false);
    expect(isSendReminderJob({ kind: 'send_reminder', payload: {} })).toBe(false);
    expect(isSendReminderJob({ kind: 'send_reminder', payload: { reminder_id: 7 } })).toBe(false);
    expect(isSendReminderJob({ kind: 'send_reminder', payload: null })).toBe(false);
    expect(isSendReminderJob({ kind: 'send_reminder', payload: 'r1' })).toBe(false);
  });
});
