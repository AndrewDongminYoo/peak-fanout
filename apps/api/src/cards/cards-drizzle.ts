// `CardsRepository` over Drizzle: the two statements of the day's pick, on `db.read`.
//
// `max(position)` is `n` and the rows at three positions are the cards; a pick by position is
// the predicate the unique index serves, which is why the pick is by position and not by id
// (design.md "The day's cards"). The SQL here is not unit-tested; it is validated against the
// compose Postgres before a pull request opens, and the pull request body carries that output.

import { expressions, type Db } from '@peak-fanout/db';
import { asc, inArray, max } from 'drizzle-orm';

import type { CardsRepository } from './service';

/** `db` is the read half of `createReadWriteDb`: the configured replica, or the shared primary. */
export function createDrizzleCardsRepository(db: Db): CardsRepository {
  return {
    async maxPosition() {
      const [row] = await db.select({ max: max(expressions.position) }).from(expressions);
      return row?.max ?? 0;
    },
    async byPositions(positions) {
      if (positions.length === 0) return [];
      return db
        .select({
          position: expressions.position,
          lang: expressions.lang,
          text: expressions.text,
          translation: expressions.translation,
          level: expressions.level,
        })
        .from(expressions)
        .where(inArray(expressions.position, positions))
        .orderBy(asc(expressions.position));
    },
  };
}
