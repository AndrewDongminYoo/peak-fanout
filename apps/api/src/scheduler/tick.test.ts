import { describe, expect, it } from 'bun:test';

import { PushSendError, type PushMessage, type PushSink } from '../push/sink';
import { REMINDER_MESSAGE, runTick, type DeliveryAttempt, type RemindersRepository } from './tick';

const PEAK = new Date('2026-09-15T12:00:00.000Z');
const LATER = new Date('2026-09-15T12:01:00.000Z');

type Row = {
  id: string;
  scheduledAt: Date;
  state: 'pending' | 'sent' | 'failed';
  pushToken: string | null;
};

/**
 * Reminders in memory, under the same predicate the Drizzle repository runs: due
 * (`scheduled_at <= now`) and `pending`, ordered by `scheduled_at`. A row in another state is
 * invisible to a tick here for the same reason it is invisible in SQL.
 */
function createMemoryReminders(rows: Row[]) {
  const attempts: DeliveryAttempt[] = [];
  const repository: RemindersRepository = {
    async dueReminders(now) {
      return rows
        .filter((row) => row.state === 'pending' && row.scheduledAt <= now)
        .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
        .map(({ id, scheduledAt, pushToken }) => ({ id, scheduledAt, pushToken }));
    },
    async recordAttempt(attempt) {
      attempts.push(attempt);
      const row = rows.find((candidate) => candidate.id === attempt.reminderId);
      if (row) row.state = attempt.status;
    },
  };
  return { repository, rows, attempts };
}

type SinkCall = { token: string | null; message: PushMessage };

function fakeSink(behavior: (call: number) => number | Error) {
  const calls: SinkCall[] = [];
  const sink: PushSink = {
    async send(token, message) {
      calls.push({ token, message });
      const outcome = behavior(calls.length);
      if (outcome instanceof Error) throw outcome;
      return { latencyMs: outcome };
    },
  };
  return { sink, calls };
}

function pending(id: string, scheduledAt = PEAK, pushToken: string | null = null): Row {
  return { id, scheduledAt, state: 'pending', pushToken };
}

describe('runTick', () => {
  it('sends a due and pending reminder and records the attempt', async () => {
    const reminders = createMemoryReminders([pending('a', PEAK, 'ExponentPushToken[abc]')]);
    const { sink, calls } = fakeSink(() => 70);

    const result = await runTick({ reminders: reminders.repository, sink, now: PEAK });

    expect(result).toMatchObject({ due: 1, sent: 1, failed: 0 });
    expect(calls).toEqual([{ token: 'ExponentPushToken[abc]', message: REMINDER_MESSAGE }]);
    expect(reminders.attempts).toEqual([
      { reminderId: 'a', status: 'sent', latencyMs: 70, error: null },
    ]);
    expect(reminders.rows[0]?.state).toBe('sent');
  });

  it('hands the sink a null push token as it is, because seeded users have none', async () => {
    const reminders = createMemoryReminders([pending('a')]);
    const { sink, calls } = fakeSink(() => 50);

    await runTick({ reminders: reminders.repository, sink, now: PEAK });

    expect(calls[0]?.token).toBeNull();
  });

  it('writes a failed reminder and a deliveries row carrying the error', async () => {
    const reminders = createMemoryReminders([pending('a')]);
    const { sink } = fakeSink(() => new PushSendError('simulated push failure after 90ms', 90));

    const result = await runTick({ reminders: reminders.repository, sink, now: PEAK });

    expect(result).toMatchObject({ due: 1, sent: 0, failed: 1 });
    expect(reminders.attempts[0]).toEqual({
      reminderId: 'a',
      status: 'failed',
      latencyMs: 90,
      error: 'PushSendError: simulated push failure after 90ms',
    });
    expect(reminders.rows[0]?.state).toBe('failed');
  });

  it('records a failure with no latency of its own as zero rather than as nothing', async () => {
    const reminders = createMemoryReminders([pending('a')]);
    const { sink } = fakeSink(() => new Error('socket closed'));

    await runTick({ reminders: reminders.repository, sink, now: PEAK });

    expect(reminders.attempts[0]).toMatchObject({ latencyMs: 0, error: 'Error: socket closed' });
  });

  it('keeps going after a failure, so one bad send does not end the fan-out', async () => {
    const reminders = createMemoryReminders([pending('a'), pending('b'), pending('c')]);
    const { sink } = fakeSink((call) => (call === 2 ? new PushSendError('nope', 10) : 60));

    const result = await runTick({ reminders: reminders.repository, sink, now: PEAK });

    expect(result).toMatchObject({ due: 3, sent: 2, failed: 1 });
    expect(reminders.rows.map((row) => row.state)).toEqual(['sent', 'failed', 'sent']);
  });

  it('does not send a reminder that is already sent', async () => {
    const reminders = createMemoryReminders([
      { id: 'a', scheduledAt: PEAK, state: 'sent', pushToken: null },
    ]);
    const { sink, calls } = fakeSink(() => 60);

    const result = await runTick({ reminders: reminders.repository, sink, now: PEAK });

    expect(result).toMatchObject({ due: 0, sent: 0, failed: 0 });
    expect(calls).toEqual([]);
    expect(reminders.attempts).toEqual([]);
  });

  it('sends nothing when nothing is due yet', async () => {
    const reminders = createMemoryReminders([pending('a', LATER)]);
    const { sink, calls } = fakeSink(() => 60);

    const result = await runTick({ reminders: reminders.repository, sink, now: PEAK });

    expect(result).toMatchObject({ due: 0, sent: 0, failed: 0 });
    expect(calls).toEqual([]);
  });

  it('lets a database error through instead of recording the send it just made as failed', async () => {
    // The shape that matters: the send SUCCEEDED and recording it is what broke. Building the
    // attempt inside the try meant the failure branch recorded that same reminder a second time
    // with `status: 'failed'`, `latencyMs: 0` and the database's error text in `deliveries.error`
    // — a delivered push written down as a failed one, in the columns M1 exists to measure.
    const written: DeliveryAttempt[] = [];
    const reminders: RemindersRepository = {
      async dueReminders() {
        return [{ id: 'a', scheduledAt: PEAK, pushToken: null }];
      },
      async recordAttempt(attempt) {
        written.push(attempt);
        throw new Error(
          'write CONFLICT: terminating connection due to idle-in-transaction timeout',
        );
      },
    };
    const { sink, calls } = fakeSink(() => 120);

    await expect(runTick({ reminders, sink, now: PEAK })).rejects.toThrow('write CONFLICT');

    expect(calls.length).toBe(1);
    expect(written).toEqual([{ reminderId: 'a', status: 'sent', latencyMs: 120, error: null }]);
  });

  it('sends in scheduled_at order, one at a time', async () => {
    const early = new Date('2026-09-15T11:00:00.000Z');
    const reminders = createMemoryReminders([pending('late', PEAK), pending('early', early)]);
    const { sink, calls } = fakeSink(() => 60);

    await runTick({ reminders: reminders.repository, sink, now: PEAK });

    expect(calls.length).toBe(2);
    expect(reminders.attempts.map((attempt) => attempt.reminderId)).toEqual(['early', 'late']);
  });
});
