import { describe, expect, it } from 'bun:test';

import { CARDS_PER_DAY, positionsForDay } from './pick';

describe('positionsForDay', () => {
  // design.md "The day's cards": the rows at ((d × 3 + i) mod n) + 1 for i in 0..2.
  it('gives a day three consecutive positions on a small table', () => {
    expect(CARDS_PER_DAY).toBe(3);
    expect(positionsForDay(0, 10)).toEqual([1, 2, 3]);
    expect(positionsForDay(1, 10)).toEqual([4, 5, 6]);
    expect(positionsForDay(2, 10)).toEqual([7, 8, 9]);
  });

  it('wraps around at the end of the table', () => {
    // Day 3 on ten rows starts at offset 9: positions 10, 1, 2.
    expect(positionsForDay(3, 10)).toEqual([10, 1, 2]);
    expect(positionsForDay(4, 10)).toEqual([3, 4, 5]);
    // Positions are always inside 1..n, whatever the day.
    for (let day = 0; day < 40; day += 1) {
      for (const position of positionsForDay(day, 10)) {
        expect(position).toBeGreaterThanOrEqual(1);
        expect(position).toBeLessThanOrEqual(10);
      }
    }
  });

  it('walks the seeded table on the peak date without leaving 1..1000', () => {
    const positions = positionsForDay(20711, 1_000);
    expect(positions).toHaveLength(3);
    expect(positions).toEqual([134, 135, 136]);
  });

  it('gives no positions for an empty table', () => {
    expect(positionsForDay(0, 0)).toEqual([]);
    expect(positionsForDay(20711, 0)).toEqual([]);
  });

  it('gives fewer than three, and distinct, positions for a table with fewer than three rows', () => {
    // Three offsets mod 2 would repeat one; the pick takes min(3, n) offsets instead.
    expect(positionsForDay(0, 2)).toEqual([1, 2]);
    expect(positionsForDay(1, 2)).toEqual([2, 1]);
    expect(positionsForDay(0, 1)).toEqual([1]);
    expect(positionsForDay(5, 1)).toEqual([1]);
    for (let day = 0; day < 10; day += 1) {
      const two = positionsForDay(day, 2);
      expect(new Set(two).size).toBe(2);
    }
  });

  it('is deterministic: the same day and count give the same positions', () => {
    expect(positionsForDay(20711, 1_000)).toEqual(positionsForDay(20711, 1_000));
    expect(positionsForDay(20712, 1_000)).not.toEqual(positionsForDay(20711, 1_000));
  });

  it('lands inside the table for a day before 1970, whose day number is negative', () => {
    expect(positionsForDay(-1, 10)).toEqual([8, 9, 10]);
    expect(positionsForDay(-4, 10)).toEqual([9, 10, 1]);
  });

  it('refuses a fractional day number or a negative count', () => {
    expect(() => positionsForDay(1.5, 10)).toThrow(/day number must be an integer/);
    expect(() => positionsForDay(0, -1)).toThrow(/non-negative integer/);
    expect(() => positionsForDay(0, 2.5)).toThrow(/non-negative integer/);
  });
});
