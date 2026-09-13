import { describe, expect, it } from 'bun:test';

import {
  createNonOverlappingTick,
  DEFAULT_INTERVAL_MS,
  formatTickLine,
  readSchedulerConfig,
  SKIPPED,
  startScheduler,
} from './runner';
import type { TickResult } from './tick';

const AT = new Date('2026-09-15T12:00:00.000Z');

function result(overrides: Partial<TickResult> = {}): TickResult {
  return { due: 0, sent: 0, failed: 0, elapsedMs: 0, ...overrides };
}

describe('readSchedulerConfig', () => {
  it('ticks every minute on the wall clock by default', () => {
    expect(readSchedulerConfig({})).toEqual({ intervalMs: DEFAULT_INTERVAL_MS, now: null });
  });

  it('reads SCHEDULER_INTERVAL_MS and refuses a value that is not a positive integer', () => {
    expect(readSchedulerConfig({ SCHEDULER_INTERVAL_MS: '1000' }).intervalMs).toBe(1000);
    expect(() => readSchedulerConfig({ SCHEDULER_INTERVAL_MS: '0' })).toThrow('positive integer');
    expect(() => readSchedulerConfig({ SCHEDULER_INTERVAL_MS: 'soon' })).toThrow(
      'positive integer',
    );
  });

  it('reads SCHEDULER_NOW as the instant a tick treats as the current time', () => {
    expect(readSchedulerConfig({ SCHEDULER_NOW: '2026-09-15T12:00:00Z' }).now).toEqual(AT);
    // The millisecond form is what the harness prints (`peak.toISOString()` in load/m1.ts).
    expect(readSchedulerConfig({ SCHEDULER_NOW: '2026-09-15T12:00:00.000Z' }).now).toEqual(AT);
    expect(readSchedulerConfig({ SCHEDULER_NOW: '2026-09-15T21:00:00+09:00' }).now).toEqual(AT);
    expect(() => readSchedulerConfig({ SCHEDULER_NOW: 'tonight' })).toThrow('ISO 8601 instant');
  });

  it('refuses a SCHEDULER_NOW that is not a complete instant', () => {
    // A date alone is midnight UTC, so `scheduled_at <= now` would select the day's earlier
    // reminders instead of the peak minute; a time without an offset is parsed in the machine's
    // local zone, so the same value means a different instant on every machine.
    expect(() => readSchedulerConfig({ SCHEDULER_NOW: '2026-09-15' })).toThrow('ISO 8601 instant');
    expect(() => readSchedulerConfig({ SCHEDULER_NOW: '2026-09-15T12:00:00' })).toThrow(
      'ISO 8601 instant',
    );
    // Shape alone is not enough: the value must also be a real instant.
    expect(() => readSchedulerConfig({ SCHEDULER_NOW: '2026-13-45T25:00:00Z' })).toThrow(
      'ISO 8601 instant',
    );
  });

  it('refuses a SCHEDULER_NOW that Date would normalize to a different instant', () => {
    // `new Date('2026-02-30T12:00:00Z')` is 2 March and `T24:00` the next day's midnight on this
    // runtime — a different instant from the one written, accepted in silence. The components have
    // to read back as written.
    for (const normalized of [
      '2026-02-30T12:00:00Z',
      '2026-04-31T12:00:00Z',
      '2026-09-15T24:00:00Z',
      '2026-09-15T12:00:00+99:00',
    ]) {
      expect(() => readSchedulerConfig({ SCHEDULER_NOW: normalized })).toThrow('ISO 8601 instant');
    }
    // A real leap day is not a normalization, and has to pass.
    expect(readSchedulerConfig({ SCHEDULER_NOW: '2028-02-29T12:00:00Z' }).now).toEqual(
      new Date('2028-02-29T12:00:00.000Z'),
    );
  });
});

describe('createNonOverlappingTick', () => {
  it('blocks a tick that starts while one is in flight instead of overlapping it', async () => {
    const gates: Array<() => void> = [];
    let running = 0;
    let mostConcurrent = 0;
    const tick = createNonOverlappingTick(async () => {
      running += 1;
      mostConcurrent = Math.max(mostConcurrent, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running -= 1;
      return 'ran';
    });

    const first = tick();
    await Bun.sleep(0);
    const second = tick();
    await Bun.sleep(0);

    // Checked before awaiting: the blocked tick never entered the body, so it never queued a
    // gate of its own. Without the guard this is 2 and the assertion fails here rather than
    // hanging on a second gate nobody releases.
    expect(gates.length).toBe(1);
    expect(await second).toBe(SKIPPED);

    (gates[0] as () => void)();
    expect(await first).toBe('ran');
    expect(mostConcurrent).toBe(1);
  });

  it('runs again once the tick in flight has finished', async () => {
    let ticks = 0;
    const tick = createNonOverlappingTick(async () => {
      ticks += 1;
      return ticks;
    });

    expect(await tick()).toBe(1);
    expect(await tick()).toBe(2);
  });

  it('releases the guard when the tick throws, so one failure does not wedge the scheduler', async () => {
    let ticks = 0;
    const tick = createNonOverlappingTick(async () => {
      ticks += 1;
      if (ticks === 1) throw new Error('database is gone');
      return 'ran';
    });

    await expect(tick()).rejects.toThrow('database is gone');
    expect(await tick()).toBe('ran');
  });
});

describe('formatTickLine', () => {
  it('reports what was due, what happened to it, and how long it took', () => {
    expect(
      formatTickLine(result({ due: 8000, sent: 7999, failed: 1, elapsedMs: 812_345 }), AT),
    ).toBe('2026-09-15T12:00:00.000Z tick due=8000 sent=7999 failed=1 elapsed=812.3s');
  });

  it('says a tick was skipped rather than printing zeros for it', () => {
    expect(formatTickLine(SKIPPED, AT)).toBe(
      '2026-09-15T12:00:00.000Z tick skipped: the previous tick is still sending',
    );
  });
});

describe('startScheduler', () => {
  it('ticks once immediately instead of waiting out the first interval', async () => {
    const lines: string[] = [];
    let ticks = 0;

    const timer = startScheduler({
      tick: async () => {
        ticks += 1;
        return result({ due: 0 });
      },
      intervalMs: DEFAULT_INTERVAL_MS,
      log: (line) => lines.push(line),
    });
    await Bun.sleep(20);
    clearInterval(timer);

    expect(ticks).toBe(1);
    expect(lines[0]).toContain('tick due=0 sent=0 failed=0');
  });

  it('hands a failed tick to onError and keeps the interval alive', async () => {
    const errors: unknown[] = [];

    const timer = startScheduler({
      tick: async () => {
        throw new Error('connection refused');
      },
      intervalMs: 10,
      log: () => {},
      onError: (error) => errors.push(error),
    });
    await Bun.sleep(40);
    clearInterval(timer);

    expect(errors.length).toBeGreaterThan(1);
    expect((errors[0] as Error).message).toBe('connection refused');
  });
});
