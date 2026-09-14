// The cards service: the day's cards for a local date, read through the cache, and the push
// message built from them. design.md "The day's cards" and "The cards cache" own the contract.
//
// `app.ts` imports this file's type, and `apps/mobile` typechecks `app.ts` through `type App`,
// so this file imports the pure `@peak-fanout/db/time` and never the package's root, which
// carries the Drizzle and `postgres` driver types (the rule `users.ts` follows). Its import of
// `REMINDER_MESSAGE` puts `scheduler/tick.ts` and `push/sink.ts` in that typecheck program too;
// both are kept free of Drizzle and Bun-only imports by the rule that keeps the tick's tests off
// Postgres (AGENTS.md, `src/scheduler/`). The repository over Drizzle is `cards-drizzle.ts`, a
// sibling.

import { dayNumber, localDate } from '@peak-fanout/db/time';

import type { PushMessage } from '../push/sink';
import { REMINDER_MESSAGE } from '../scheduler/tick';
import type { CardsCache } from './cache';
import { positionsForDay } from './pick';

/** One `expressions` row as a card: what `GET /cards/today` returns and a push is built from. */
export type ExpressionCard = {
  position: number;
  lang: string;
  text: string;
  translation: string;
  level: number;
};

/** The day's set: the local date the pick was made for, and its cards in position order. */
export type DayCards = {
  date: string;
  cards: ExpressionCard[];
};

/** The two statements the pick needs, both on `db.read`. Tests pass an in-memory one. */
export interface CardsRepository {
  /** `max(position)`, and 0 when the table is empty. */
  maxPosition(): Promise<number>;
  /** The rows at `positions`, ordered by position. */
  byPositions(positions: number[]): Promise<ExpressionCard[]>;
}

export type CardsService = {
  /** The cards for a `YYYY-MM-DD` local date, through the cache. */
  forDate(localDate: string): Promise<DayCards>;
  /** The cards for the date `instant` falls on in `timezone`: the reminder's, or now. */
  todayFor(instant: Date, timezone: string): Promise<DayCards>;
};

export type CardsServiceDeps = {
  repository: CardsRepository;
  /** The SWR cache, or the pass-through under `CARDS_CACHE=off`. */
  cache: CardsCache<DayCards>;
};

/**
 * A read of the day's cards that failed at the repository: the database, and not the input.
 *
 * The worker stops claiming on this class and on nothing else (design.md "The worker reads the
 * cards"), which is why the service names it: what `localDate` refuses — a timezone the runtime
 * does not know — is that reminder's own failure, is thrown as the runtime threw it, and never
 * holds a worker. `cause` is what the repository threw, and the message carries the date the
 * read was for.
 */
export class CardsReadError extends Error {
  constructor(date: string, cause: unknown) {
    const described = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    super(`cards for ${date}: ${described}`, { cause });
    this.name = 'CardsReadError';
  }
}

/** One repository statement, whose throw is named as the read's (`CardsReadError`). */
async function reading<T>(date: string, statement: () => Promise<T>): Promise<T> {
  try {
    return await statement();
  } catch (error) {
    throw new CardsReadError(date, error);
  }
}

/**
 * The cache key is the local date alone — one set per calendar day, for everyone — so two users
 * in one timezone, or the worker's 25 concurrent sends for one date, read one query.
 */
export function createCardsService({ repository, cache }: CardsServiceDeps): CardsService {
  const load = async (date: string): Promise<DayCards> => {
    const count = await reading(date, () => repository.maxPosition());
    const positions = positionsForDay(dayNumber(date), count);
    const cards =
      positions.length === 0 ? [] : await reading(date, () => repository.byPositions(positions));
    return { date, cards };
  };
  const forDate = (date: string) => cache.get(date, () => load(date));
  return {
    forDate,
    todayFor: (instant, timezone) => forDate(localDate(instant, timezone)),
  };
}

/**
 * The push a reminder carries: the title names the count and the body lists the cards' text in
 * position order. With no cards — a database seeded without expressions — it is the M1 copy, so
 * the push still goes out (design.md "The day's cards").
 */
export function messageFor(cards: ExpressionCard[]): PushMessage {
  if (cards.length === 0) return REMINDER_MESSAGE;
  const count = cards.length;
  return {
    title: count === 1 ? '1 expression is waiting' : `${count} expressions are waiting`,
    body: cards.map((card) => card.text).join(' · '),
  };
}
