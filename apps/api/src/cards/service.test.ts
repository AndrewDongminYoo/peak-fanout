import { describe, expect, it } from 'bun:test';

import { REMINDER_MESSAGE } from '../scheduler/tick';
import { createPassThroughCache, createSwrCache } from './cache';
import {
  createCardsService,
  messageFor,
  type CardsRepository,
  type ExpressionCard,
} from './service';

/** An `expressions` table of `count` rows in memory, answering the two statements the pick needs. */
function memoryRepository(count: number) {
  const rows: ExpressionCard[] = Array.from({ length: count }, (_, index) => ({
    position: index + 1,
    lang: 'en',
    text: `expression ${index + 1}`,
    translation: `translation ${index + 1}`,
    level: ((index + 1) % 5) + 1,
  }));
  const calls = { maxPosition: 0, byPositions: [] as number[][] };
  const repository: CardsRepository = {
    async maxPosition() {
      calls.maxPosition += 1;
      return count;
    },
    async byPositions(positions) {
      calls.byPositions.push(positions);
      return rows
        .filter((row) => positions.includes(row.position))
        .sort((a, b) => a.position - b.position);
    },
  };
  return { repository, calls };
}

const card = (position: number, text = `expression ${position}`): ExpressionCard => ({
  position,
  lang: 'en',
  text,
  translation: `translation ${position}`,
  level: 1,
});

describe('messageFor', () => {
  it('names the count in the title and lists the texts in the body', () => {
    expect(messageFor([card(1), card(2), card(3)])).toEqual({
      title: '3 expressions are waiting',
      body: 'expression 1 · expression 2 · expression 3',
    });
  });

  it('uses the singular for one card', () => {
    expect(messageFor([card(9, 'break the ice')])).toEqual({
      title: '1 expression is waiting',
      body: 'break the ice',
    });
  });

  it('falls back to the M1 copy when there are no cards, so the push still goes out', () => {
    // design.md "The day's cards": a database seeded without expressions still delivers.
    expect(messageFor([])).toBe(REMINDER_MESSAGE);
  });
});

describe('createCardsService', () => {
  it('picks the date’s positions and returns the repository’s rows in position order', async () => {
    const table = memoryRepository(10);
    const service = createCardsService({
      repository: table.repository,
      cache: createPassThroughCache(),
    });

    // Day 3 on ten rows is positions 10, 1, 2 in pick order; the response is in position order.
    const day = await service.forDate('1970-01-04');

    expect(day.date).toBe('1970-01-04');
    expect(day.cards.map((c) => c.position)).toEqual([1, 2, 10]);
    expect(day.cards[0]).toEqual({
      position: 1,
      lang: 'en',
      text: 'expression 1',
      translation: 'translation 1',
      level: 2,
    });
    expect(table.calls.byPositions).toEqual([[10, 1, 2]]);
  });

  it('reads today as the local date in the user’s timezone, not the UTC date', async () => {
    const table = memoryRepository(1_000);
    const service = createCardsService({
      repository: table.repository,
      cache: createPassThroughCache(),
    });
    // 21:00 in New York on the 15th is 01:00Z on the 16th.
    const evening = new Date('2026-09-16T01:00:00.000Z');

    const newYork = await service.todayFor(evening, 'America/New_York');
    const utc = await service.todayFor(evening, 'UTC');
    const seoul = await service.todayFor(new Date('2026-09-15T12:00:00.000Z'), 'Asia/Seoul');

    expect(newYork.date).toBe('2026-09-15');
    expect(utc.date).toBe('2026-09-16');
    expect(seoul.date).toBe('2026-09-15');
    expect(newYork.cards).toEqual(seoul.cards);
    expect(newYork.cards).not.toEqual(utc.cards);
    expect(seoul.cards.map((c) => c.position)).toEqual([134, 135, 136]);
  });

  it('returns fewer cards when the table is small and none when it is empty, without a second query', async () => {
    const two = memoryRepository(2);
    const twoService = createCardsService({
      repository: two.repository,
      cache: createPassThroughCache(),
    });
    expect((await twoService.forDate('2026-09-15')).cards.map((c) => c.position)).toEqual([1, 2]);

    const empty = memoryRepository(0);
    const emptyService = createCardsService({
      repository: empty.repository,
      cache: createPassThroughCache(),
    });
    expect(await emptyService.forDate('2026-09-15')).toEqual({ date: '2026-09-15', cards: [] });
    expect(empty.calls.maxPosition).toBe(1);
    expect(empty.calls.byPositions).toEqual([]);
  });

  it('reads through the cache keyed by the local date alone, so one date is one query', async () => {
    const table = memoryRepository(1_000);
    const service = createCardsService({
      repository: table.repository,
      cache: createSwrCache({ freshMs: 60_000, staleMs: 600_000, maxEntries: 64, clock: () => 0 }),
    });

    // Two users in one zone, and a third zone on the same local date, share one entry.
    await Promise.all([
      service.todayFor(new Date('2026-09-15T12:00:00.000Z'), 'Asia/Seoul'),
      service.todayFor(new Date('2026-09-15T12:00:00.000Z'), 'Asia/Seoul'),
      service.todayFor(new Date('2026-09-15T12:00:00.000Z'), 'UTC'),
    ]);
    await service.forDate('2026-09-15');

    expect(table.calls.maxPosition).toBe(1);
    expect(table.calls.byPositions).toHaveLength(1);

    // Another local date is another key.
    await service.forDate('2026-09-16');
    expect(table.calls.maxPosition).toBe(2);
  });

  it('lets a repository error through to the caller', async () => {
    const service = createCardsService({
      repository: {
        async maxPosition() {
          throw new Error('connection refused');
        },
        async byPositions() {
          return [];
        },
      },
      cache: createPassThroughCache(),
    });

    await expect(service.forDate('2026-09-15')).rejects.toThrow('connection refused');
  });
});
