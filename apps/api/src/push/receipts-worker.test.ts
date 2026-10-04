import { expect, it } from 'bun:test';

import {
  runWorkerLoop,
  WORKER_DEFAULTS,
  type ClaimedJob,
  type JobsRepository,
  type SendOutcome,
} from '../worker/loop';
import type { PushRegistration } from './sink';

it('carries each accepted ticket and its exact registration through a partially failed worker attempt', async () => {
  const shutdown = new AbortController();
  const registrations: PushRegistration[] = ['a', 'b', 'c'].map((id) => ({
    id,
    userId: 'owner',
    token: id,
    createdAt: '2026-10-04 12:00:00.123456+00',
  }));
  const job: ClaimedJob = {
    id: 'job',
    reminderId: 'reminder',
    reminder: {
      seeded: false,
      localDate: '2026-10-04',
      timezone: 'UTC',
      scheduledAt: new Date(),
      pushTokens: ['a', 'b', 'c'],
      pushRegistrations: registrations,
    },
  };
  let recorded: readonly SendOutcome[] = [];
  const jobs: JobsRepository = {
    async claim() {
      return [job];
    },
    async skipNoTarget() {
      throw new Error('registered user must be sent');
    },
    async complete() {
      throw new Error('must use mixed outcome path');
    },
    async retryOrDeadLetter(_, outcomes) {
      recorded = outcomes;
      shutdown.abort();
      return 'retry';
    },
  };
  await runWorkerLoop({
    jobs,
    cards: {
      async todayFor() {
        throw new Error('ordinary reminder must use its frozen local date');
      },
      async forDate(date) {
        expect(date).toBe('2026-10-04');
        return { date, cards: [] };
      },
    },
    sink: {
      async send(token) {
        if (token === 'b') throw new Error('rejected');
        return { latencyMs: 12, ticketId: `ticket-${token}` };
      },
    },
    config: WORKER_DEFAULTS,
    workerId: 'test',
    clock: () => 0,
    sleep: async () => {},
    shutdown: shutdown.signal,
    log: () => {},
  });
  expect(recorded[0]).toEqual({
    status: 'sent',
    latencyMs: 12,
    ticketId: 'ticket-a',
    registration: registrations[0],
  });
  expect(recorded[1]).toMatchObject({ status: 'failed' });
  expect(recorded[2]).toEqual({
    status: 'sent',
    latencyMs: 12,
    ticketId: 'ticket-c',
    registration: registrations[2],
  });
});
