// The day's pick: which `expressions` positions a calendar day gets.
//
// design.md "The day's cards" owns the rule. One set per calendar day, for everyone, picked from
// the date alone: the rows at positions `((d × 3 + i) mod n) + 1` for `i` in 0..2, where `d` is
// the day number of the local date and `n` is `max(position)`. By position and not by id, because
// three positions are a predicate an index serves, which is the predicate M4 runs EXPLAIN on.
// Pure, so the arithmetic is tested on small tables without a database.

/** How many cards one day gets when the table holds at least that many rows. */
export const CARDS_PER_DAY = 3;

/**
 * The positions day `dayNumber` reads from a table whose positions run `1..count`, in pick order.
 *
 * `count = 0` yields no positions. `count < 3` yields `count` distinct positions rather than three
 * with repeats: the pick takes `min(3, count)` consecutive offsets, and consecutive offsets mod
 * `count` are distinct while there are no more of them than `count`. The modulo is taken so that
 * a negative day number — a date before 1970 — still lands in `1..count`.
 */
export function positionsForDay(dayNumber: number, count: number): number[] {
  if (!Number.isInteger(dayNumber))
    throw new Error(`day number must be an integer, got ${dayNumber}`);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`position count must be a non-negative integer, got ${count}`);
  }
  if (count === 0) return [];
  const cards = Math.min(CARDS_PER_DAY, count);
  const first = dayNumber * CARDS_PER_DAY;
  const positions: number[] = [];
  for (let i = 0; i < cards; i += 1) {
    positions.push(((((first + i) % count) + count) % count) + 1);
  }
  return positions;
}
