import { describe, expect, it } from 'bun:test';

import {
  chooseWorkerToKill,
  createRestartIntervention,
  isUnderRepository,
  isWorkerCommand,
  killStrandedNothingReason,
  parseWorkerId,
  runRestartProcedure,
  type ClaimsReading,
  type OpenClaims,
  type RestartDeps,
} from './restart';

const HOST = 'mac-mini.local';
/** The harness's checkout, as `m1.ts` derives it: realpath-normalized, no trailing slash. */
const ROOT = '/Users/x/Development/peak-fanout';
/** Where a real worker runs: the `worker` script is started with `bun --cwd=apps/api`. */
const WORKER_CWD = `${ROOT}/apps/api`;

/** A clock the test moves, so nothing here waits on the real one. */
function fakeClock(startMs = 1_000_000) {
  let value = startMs;
  return {
    now: () => value,
    sleep: async (ms: number) => {
      value += ms;
    },
  };
}

/** The readings the claims query returns in order, repeating the last one forever. */
function replay(readings: ClaimsReading[]): () => Promise<ClaimsReading> {
  let index = 0;
  return async () => {
    const reading = readings[Math.min(index, readings.length - 1)] as ClaimsReading;
    index += 1;
    return reading;
  };
}

function held(lockedBy: string, count: number): OpenClaims {
  return { lockedBy, jobIds: Array.from({ length: count }, (_, i) => `${lockedBy}-job-${i}`) };
}

/**
 * The process functions a test hands the procedure: `describeProcess` answers from a table of
 * pid → command line, `readProcessCwd` from a table of pid → working directory (every pid in
 * the first table runs under the checkout unless the second says otherwise), and `kill` only
 * records. Nothing here signals anything.
 */
function processes(table: Record<number, string>, directories: Record<number, string> = {}) {
  const killed: number[] = [];
  const described: number[] = [];
  const cwdRead: number[] = [];
  return {
    killed,
    described,
    cwdRead,
    describeProcess: async (pid: number) => {
      described.push(pid);
      return table[pid] ?? '';
    },
    readProcessCwd: async (pid: number) => {
      cwdRead.push(pid);
      return directories[pid] ?? (pid in table ? WORKER_CWD : '');
    },
    kill: (pid: number) => {
      killed.push(pid);
    },
  };
}

function deps(overrides: Partial<RestartDeps> = {}): RestartDeps & { lines: string[] } {
  const clock = fakeClock();
  const lines: string[] = [];
  const fakes = processes({ 3322: 'bun src/worker/index.ts' });
  return {
    hostname: HOST,
    repositoryRoot: ROOT,
    claims: replay([{ attempts: 2_100, workers: [held(`${HOST}:3322`, 25)] }]),
    describeProcess: fakes.describeProcess,
    readProcessCwd: fakes.readProcessCwd,
    kill: fakes.kill,
    now: clock.now,
    sleep: clock.sleep,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

describe('isWorkerCommand', () => {
  it('accepts the worker as ps prints it for the pid in locked_by, and the scripts that run it', () => {
    // Read from a process tree started with `bun run dev:worker` on 2026-09-13: the pid the
    // worker writes to `locked_by` is `process.pid` of the leaf, whose `ps -p <pid> -o command=`
    // is exactly the first line; its parent prints the second and its grandparent the third.
    expect(isWorkerCommand('bun src/worker/index.ts')).toBe(true);
    expect(isWorkerCommand('bun --cwd=apps/api run worker')).toBe(true);
    expect(isWorkerCommand('bun run dev:worker')).toBe(true);
    // The executable by its path, the script by its path, and a flag before the script.
    expect(
      isWorkerCommand('/Users/x/.bun/bin/bun /Users/x/peak-fanout/apps/api/src/worker/index.ts'),
    ).toBe(true);
    expect(isWorkerCommand('bun --watch src/worker/index.ts')).toBe(true);
    expect(isWorkerCommand('/Users/x/.bun/bin/bun run --silent dev:worker')).toBe(true);
  });

  it('accepts the shape wherever the line points, because the working directory is the other check', () => {
    // A worker of this checkout, one of a worktree, and another project's `src/worker/index.ts`
    // print the same shape, and the pathless line (the shape the real worker prints) names no
    // directory at all, so the shape cannot scope the checkout and does not try to: that is
    // `isUnderRepository` over the pid's working directory, and `runRestartProcedure` requires
    // both. What this check alone keeps from SIGKILL is a reused pid running something that is
    // not a worker.
    expect(
      isWorkerCommand(
        '/Users/x/.bun/bin/bun /Users/x/Development/peak-fanout/apps/api/src/worker/index.ts',
      ),
    ).toBe(true);
    expect(
      isWorkerCommand(
        '/Users/x/.bun/bin/bun /Users/x/Development/peak-fanout-worktree/apps/api/src/worker/index.ts',
      ),
    ).toBe(true);
    expect(isWorkerCommand('/opt/other-project/node_modules/.bin/bun src/worker/index.ts')).toBe(
      true,
    );
  });

  it('refuses an empty line, which is a pid nobody holds', () => {
    // `ps -p 99999 -o command=` prints nothing and exits 1; the pid from the table has gone.
    expect(isWorkerCommand('')).toBe(false);
    expect(isWorkerCommand('   \n')).toBe(false);
  });

  it('refuses an unrelated command, which is a reused pid', () => {
    expect(isWorkerCommand('node /usr/local/bin/some-other-tool --watch')).toBe(false);
    expect(isWorkerCommand('bun src/scheduler/index.ts')).toBe(false);
    expect(isWorkerCommand('bun src/load/m1.ts')).toBe(false);
    // A path that merely contains the words is not the script.
    expect(isWorkerCommand('vim src/worker/index.ts.bak')).toBe(false);
  });

  it('refuses a line that names the worker file or script without being bun running it', () => {
    // The words alone are what an editor, a pager or an echo would show for a reused pid; the
    // check is the executable and its argument, not a substring anywhere in the line.
    expect(isWorkerCommand('vim src/worker/index.ts')).toBe(false);
    expect(isWorkerCommand('less /Users/x/src/worker/index.ts')).toBe(false);
    expect(isWorkerCommand('echo run worker')).toBe(false);
    expect(isWorkerCommand('sh -c "bun src/worker/index.ts"')).toBe(false);
    expect(isWorkerCommand('node bun src/worker/index.ts')).toBe(false);
    expect(isWorkerCommand('bunx src/worker/index.ts')).toBe(false);
  });

  it('refuses bun running something else with the worker named after it', () => {
    expect(isWorkerCommand('bun run dev:api src/worker/index.ts')).toBe(false);
    expect(isWorkerCommand('bun src/load/m1.ts src/worker/index.ts')).toBe(false);
    expect(isWorkerCommand('bun src/worker/index.ts --and-then something')).toBe(false);
    expect(isWorkerCommand('bun run dev:worker extra')).toBe(false);
    expect(isWorkerCommand('bun run worker:other')).toBe(false);
    // A flag whose value is a separate token is not understood, and the safe answer is no.
    expect(isWorkerCommand('bun --cwd apps/api run worker')).toBe(false);
  });
});

describe('parseWorkerId', () => {
  it('splits hostname:pid on the last colon, so a hostname may carry one of its own', () => {
    expect(parseWorkerId(`${HOST}:3322`)).toEqual({ host: HOST, pid: 3322 });
    expect(parseWorkerId('fe80::1%en0:77')).toEqual({ host: 'fe80::1%en0', pid: 77 });
  });

  it('refuses anything whose tail is not a pid', () => {
    expect(parseWorkerId(`${HOST}:`)).toBeNull();
    expect(parseWorkerId(`${HOST}:0`)).toBeNull();
    expect(parseWorkerId(`${HOST}:12a`)).toBeNull();
    expect(parseWorkerId(`${HOST}:-4`)).toBeNull();
    expect(parseWorkerId(':3322')).toBeNull();
    expect(parseWorkerId('3322')).toBeNull();
  });
});

describe('isUnderRepository', () => {
  it('accepts the root itself and a directory under it', () => {
    // `lsof -a -p <pid> -d cwd -Fn` on a worker started with `bun run dev:worker` from a checkout
    // on 2026-09-13 printed `n<root>/apps/api`: the `worker` script runs with `bun --cwd=apps/api`,
    // so the real worker is the second case, never the first.
    expect(isUnderRepository(ROOT, ROOT)).toBe(true);
    expect(isUnderRepository(WORKER_CWD, ROOT)).toBe(true);
    expect(isUnderRepository(`${ROOT}/apps/api/src/worker`, ROOT)).toBe(true);
  });

  it('refuses a sibling that extends the root by a suffix, which a bare prefix test would accept', () => {
    // A worktree named after its checkout sits beside it: `peak-fanout` and
    // `peak-fanout-m2-part-2-measured-comparison` share every byte of the shorter name.
    expect(isUnderRepository(`${ROOT}-2`, ROOT)).toBe(false);
    expect(isUnderRepository(`${ROOT}-worktree/apps/api`, ROOT)).toBe(false);
    expect(isUnderRepository(`${ROOT}.bak`, ROOT)).toBe(false);
  });

  it('refuses an unrelated path, the parent, and an empty directory', () => {
    expect(isUnderRepository('/opt/other-project', ROOT)).toBe(false);
    expect(isUnderRepository('/opt/other-project/apps/api', ROOT)).toBe(false);
    expect(isUnderRepository('/Users/x/Development', ROOT)).toBe(false);
    expect(isUnderRepository('/', ROOT)).toBe(false);
    expect(isUnderRepository('', ROOT)).toBe(false);
  });
});

describe('chooseWorkerToKill', () => {
  it('picks the worker holding the most open claims', () => {
    const choice = chooseWorkerToKill(
      [held(`${HOST}:11`, 3), held(`${HOST}:22`, 25), held(`${HOST}:33`, 12)],
      HOST,
    );

    expect(choice).toEqual({
      kind: 'chosen',
      workerId: `${HOST}:22`,
      pid: 22,
      jobIds: held(`${HOST}:22`, 25).jobIds,
    });
  });

  it('breaks a tie deterministically, on the smaller locked_by', () => {
    const a = [held(`${HOST}:22`, 25), held(`${HOST}:11`, 25)];
    const b = [held(`${HOST}:11`, 25), held(`${HOST}:22`, 25)];

    expect(chooseWorkerToKill(a, HOST)).toMatchObject({ workerId: `${HOST}:11` });
    expect(chooseWorkerToKill(b, HOST)).toMatchObject({ workerId: `${HOST}:11` });
  });

  it('returns null when no worker holds an open claim: a between-batches instant', () => {
    // A kill now would strand nothing and measure nothing, so the caller reads again.
    expect(chooseWorkerToKill([], HOST)).toBeNull();
    expect(chooseWorkerToKill([held(`${HOST}:11`, 0)], HOST)).toBeNull();
  });

  it('refuses a foreign hostname rather than signalling a pid on another machine', () => {
    // The pid is meaningful only on the host that wrote it; the run kills what it can see.
    const choice = chooseWorkerToKill([held('other-host:12', 25), held(`${HOST}:11`, 3)], HOST);

    expect(choice).toMatchObject({ kind: 'refused' });
    expect((choice as { reason: string }).reason).toContain('names host "other-host"');
  });

  it('refuses a non-numeric pid', () => {
    const choice = chooseWorkerToKill([held(`${HOST}:abc`, 25)], HOST);

    expect(choice).toMatchObject({ kind: 'refused' });
    expect((choice as { reason: string }).reason).toContain('not of the form hostname:pid');
  });
});

describe('runRestartProcedure', () => {
  it('kills once and records the id, the instant, the attempts and the held ids', async () => {
    const fakes = processes({ 3322: 'bun src/worker/index.ts' });
    const clock = fakeClock();
    const d = deps({ ...fakes, now: clock.now, sleep: clock.sleep });

    const record = await runRestartProcedure(d);

    expect(fakes.described).toEqual([3322]);
    expect(fakes.cwdRead).toEqual([3322]);
    expect(fakes.killed).toEqual([3322]);
    expect(record).toEqual({
      workerId: `${HOST}:3322`,
      pid: 3322,
      killedAt: new Date(1_000_000),
      attemptsAtKill: 2_100,
      jobsHeld: held(`${HOST}:3322`, 25).jobIds,
    });
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toContain(`killed worker ${HOST}:3322 with SIGKILL`);
    expect(d.lines[0]).toContain('held 25 jobs, at 2100 attempts');
  });

  it('reads the claims once more after the process check, and the record is that reading', async () => {
    // The `ps` read takes time and sends finish inside it: the reading that chose the worker
    // showed 25 held, the reading taken after the verification shows 7, and the record carries
    // the 7 — the jobs the signal can still strand — and that reading's attempts.
    const fakes = processes({ 3322: 'bun src/worker/index.ts' });
    const chosen = held(`${HOST}:3322`, 25);
    const last = { lockedBy: chosen.lockedBy, jobIds: chosen.jobIds.slice(18) };
    const d = deps({
      ...fakes,
      claims: replay([
        { attempts: 2_100, workers: [chosen] },
        { attempts: 2_118, workers: [last] },
      ]),
    });

    const record = await runRestartProcedure(d);

    expect(fakes.described).toEqual([3322]);
    expect(fakes.killed).toEqual([3322]);
    expect(record.jobsHeld).toEqual(last.jobIds);
    expect(record.jobsHeld).toHaveLength(7);
    expect(record.attemptsAtKill).toBe(2_118);
    expect(d.lines[0]).toContain('held 7 jobs, at 2118 attempts');
  });

  it('waits out a between-batches instant and kills on the first reading with a claim', async () => {
    // Every worker is between batches at the first two readings; the third shows a claim and
    // the fourth, taken after the process check, still does. The record carries the fourth.
    const fakes = processes({ 3322: 'bun src/worker/index.ts' });
    const clock = fakeClock();
    let readings = 0;
    const d = deps({
      ...fakes,
      now: clock.now,
      sleep: clock.sleep,
      claims: async () => {
        readings += 1;
        return readings < 3
          ? { attempts: 2_000 + readings, workers: [held(`${HOST}:3322`, 0)] }
          : { attempts: 2_010, workers: [held(`${HOST}:3322`, 7)] };
      },
    });

    const record = await runRestartProcedure(d);

    expect(readings).toBe(4);
    expect(record.attemptsAtKill).toBe(2_010);
    expect(record.jobsHeld).toHaveLength(7);
    // Two 50 ms waits after the two empty readings; the re-read after `ps` waits nothing.
    expect(record.killedAt.getTime()).toBe(1_000_100);
    expect(fakes.killed).toEqual([3322]);
  });

  it('waits out a worker whose batch finished during the process check, and chooses again', async () => {
    // The first reading shows 3322 holding a batch; by the reading after its `ps` check the batch
    // is done and it holds nothing, so nothing is signalled. The next pick finds 4411 holding,
    // its process is verified, the re-read still shows it holding, and that is the kill.
    const fakes = processes({
      3322: 'bun src/worker/index.ts',
      4411: 'bun src/worker/index.ts',
    });
    const clock = fakeClock();
    const d = deps({
      ...fakes,
      now: clock.now,
      sleep: clock.sleep,
      claims: replay([
        { attempts: 2_100, workers: [held(`${HOST}:3322`, 25), held(`${HOST}:4411`, 2)] },
        { attempts: 2_125, workers: [held(`${HOST}:3322`, 0), held(`${HOST}:4411`, 1)] },
        { attempts: 2_130, workers: [held(`${HOST}:3322`, 0), held(`${HOST}:4411`, 25)] },
        { attempts: 2_133, workers: [held(`${HOST}:3322`, 25), held(`${HOST}:4411`, 22)] },
      ]),
    });

    const record = await runRestartProcedure(d);

    expect(fakes.described).toEqual([3322, 4411]);
    expect(fakes.killed).toEqual([4411]);
    expect(record.workerId).toBe(`${HOST}:4411`);
    expect(record.jobsHeld).toHaveLength(22);
    expect(record.attemptsAtKill).toBe(2_133);
    // One 50 ms wait after the reading that found 3322 empty.
    expect(record.killedAt.getTime()).toBe(1_000_050);
    expect(d.lines[0]).toContain(`worker ${HOST}:3322 held nothing any more`);
    expect(d.lines[1]).toContain(`killed worker ${HOST}:4411 with SIGKILL`);
  });

  it('gives up after its bound when no reading ever shows a claim, signalling nothing', async () => {
    const fakes = processes({ 3322: 'bun src/worker/index.ts' });
    const clock = fakeClock();
    const d = deps({
      ...fakes,
      now: clock.now,
      sleep: clock.sleep,
      claims: replay([{ attempts: 2_000, workers: [] }]),
    });

    await expect(runRestartProcedure(d)).rejects.toThrow(
      "refusing to kill: no reading over 5s found a worker holding an open claim on the peak's " +
        'jobs at the instant before the signal',
    );
    expect(fakes.killed).toEqual([]);
    expect(fakes.described).toEqual([]);
    // The bound was waited out on the fake clock, in 50 ms steps.
    expect(clock.now() - 1_000_000).toBeGreaterThanOrEqual(5_000);
  });

  it('gives up after its bound when the chosen worker never still holds at the re-read', async () => {
    // Every pick finds 3322 holding and every re-read after its `ps` check finds it empty: the
    // procedure never has a batch to strand at the instant before the signal, and sends nothing.
    const fakes = processes({ 3322: 'bun src/worker/index.ts' });
    const clock = fakeClock();
    let readings = 0;
    const d = deps({
      ...fakes,
      now: clock.now,
      sleep: clock.sleep,
      claims: async () => {
        readings += 1;
        return readings % 2 === 1
          ? { attempts: 2_000 + readings, workers: [held(`${HOST}:3322`, 25)] }
          : { attempts: 2_000 + readings, workers: [held(`${HOST}:3322`, 0)] };
      },
    });

    await expect(runRestartProcedure(d)).rejects.toThrow('so there was no batch to strand');
    expect(fakes.killed).toEqual([]);
    expect(fakes.described.length).toBeGreaterThan(1);
    expect(clock.now() - 1_000_000).toBeGreaterThanOrEqual(5_000);
  });

  it('refuses when the pid is not a worker any more, without signalling it', async () => {
    // A pid read from a table can have been reused: the worker died, the machine handed its pid
    // to something else, and the table still says the worker holds a batch.
    const fakes = processes({ 3322: 'node /usr/local/bin/some-other-tool' });
    const d = deps(fakes);

    await expect(runRestartProcedure(d)).rejects.toThrow(
      /refusing to kill: pid 3322 from locked_by ".*:3322" is running "node \/usr\/local\/bin\/some-other-tool", which is not a worker\./,
    );
    expect(fakes.killed).toEqual([]);
  });

  it('refuses when the pid holds no process at all', async () => {
    const fakes = processes({});
    const d = deps(fakes);

    await expect(runRestartProcedure(d)).rejects.toThrow(
      /pid 3322 from locked_by ".*:3322" is not a running process/,
    );
    expect(fakes.cwdRead).toEqual([]);
    expect(fakes.killed).toEqual([]);
  });

  it('refuses a worker-shaped process running outside this repository, without signalling it', async () => {
    // The worker that wrote the claim died inside its lease, the machine handed its pid to
    // another project's worker — any repository with a `src/worker/index.ts` prints this line —
    // and the claim still names the pid. The shape passes; the working directory does not.
    const fakes = processes(
      { 3322: '/opt/other-project/node_modules/.bin/bun src/worker/index.ts' },
      { 3322: '/opt/other-project' },
    );
    const d = deps(fakes);

    await expect(runRestartProcedure(d)).rejects.toThrow(
      `refusing to kill: pid 3322 from locked_by "${HOST}:3322" is running ` +
        '"/opt/other-project/node_modules/.bin/bun src/worker/index.ts" from "/opt/other-project", ' +
        `which is not under this repository (${ROOT}).`,
    );
    expect(fakes.described).toEqual([3322]);
    expect(fakes.cwdRead).toEqual([3322]);
    expect(fakes.killed).toEqual([]);
  });

  it('refuses a worker of a sibling checkout, whose path extends the root by a suffix', async () => {
    // A worker of another checkout of this repository against the same database is a fleet
    // member in every sense but the one the check can prove, and the check fails closed: the
    // run ends without a log, and is repeated with the workers started from this checkout.
    const fakes = processes({ 3322: 'bun src/worker/index.ts' }, { 3322: `${ROOT}-2/apps/api` });
    const d = deps(fakes);

    await expect(runRestartProcedure(d)).rejects.toThrow(
      `from "${ROOT}-2/apps/api", which is not under this repository (${ROOT})`,
    );
    expect(fakes.killed).toEqual([]);
  });

  it('refuses when the working directory cannot be read, without signalling', async () => {
    // `lsof` printed nothing for the pid, or the directory it named no longer resolves: nothing
    // proves the process is this repository's, and the safe answer is no.
    const fakes = processes({ 3322: 'bun src/worker/index.ts' }, { 3322: '' });
    const d = deps(fakes);

    await expect(runRestartProcedure(d)).rejects.toThrow(
      `refusing to kill: pid 3322 from locked_by "${HOST}:3322" is running ` +
        `"bun src/worker/index.ts" but its working directory could not be read, so nothing ` +
        `proves it is a worker of this repository (${ROOT}).`,
    );
    expect(fakes.cwdRead).toEqual([3322]);
    expect(fakes.killed).toEqual([]);
  });

  it('refuses a worker on another host before reading any process', async () => {
    const fakes = processes({ 12: 'bun src/worker/index.ts' });
    const d = deps({
      ...fakes,
      claims: replay([{ attempts: 2_100, workers: [held('other-host:12', 25)] }]),
    });

    await expect(runRestartProcedure(d)).rejects.toThrow(
      'refusing to kill: locked_by "other-host:12" names host "other-host"',
    );
    expect(fakes.described).toEqual([]);
    expect(fakes.killed).toEqual([]);
  });
});

describe('createRestartIntervention', () => {
  it('does nothing below a quarter of the peak, kills at the first reading at or past it, then nothing more', async () => {
    const fakes = processes({ 3322: 'bun src/worker/index.ts' });
    let claimsRead = 0;
    const d = deps({
      ...fakes,
      claims: async () => {
        claimsRead += 1;
        return { attempts: 2_005, workers: [held(`${HOST}:3322`, 25)] };
      },
    });
    const intervention = createRestartIntervention(8_000, d);

    await intervention.intervene({ attempts: 0 });
    await intervention.intervene({ attempts: 1_999 });
    expect(claimsRead).toBe(0);
    expect(intervention.record()).toBeNull();

    // 2,000 of 8,000 is exactly a quarter: at, not past, and that reading acts: one reading to
    // choose, one after the process check for the record.
    await intervention.intervene({ attempts: 2_000 });
    expect(claimsRead).toBe(2);
    expect(fakes.killed).toEqual([3322]);
    expect(intervention.record()?.attemptsAtKill).toBe(2_005);

    await intervention.intervene({ attempts: 4_000 });
    await intervention.intervene({ attempts: 8_000 });
    expect(claimsRead).toBe(2);
    expect(fakes.killed).toEqual([3322]);
  });
});

describe('killStrandedNothingReason', () => {
  it('is null when at least one held job was reclaimed and finished by another worker', () => {
    expect(
      killStrandedNothingReason({
        jobsHeld: 25,
        finishedByKilledWorker: 4,
        finishedByAnotherWorker: 21,
        stillOpenAtClose: 0,
      }),
    ).toBeNull();
    expect(
      killStrandedNothingReason({
        jobsHeld: 25,
        finishedByKilledWorker: 24,
        finishedByAnotherWorker: 1,
        stillOpenAtClose: 0,
      }),
    ).toBeNull();
  });

  it('is null when a held job is still open at close: stranded, and the ninth check grades it', () => {
    // The stalled run is logged with its check missed, which is the reachability the verdict
    // relies on; refusing it here would swallow the case the check exists to record.
    expect(
      killStrandedNothingReason({
        jobsHeld: 25,
        finishedByKilledWorker: 4,
        finishedByAnotherWorker: 0,
        stillOpenAtClose: 21,
      }),
    ).toBeNull();
  });

  it('refuses a kill after which every held job was finished by the killed worker itself', () => {
    // The batch finished between the last reading and the signal: no reclaim, nothing open,
    // the lease never exercised, and 0 lost true by construction.
    const reason = killStrandedNothingReason({
      jobsHeld: 25,
      finishedByKilledWorker: 25,
      finishedByAnotherWorker: 0,
      stillOpenAtClose: 0,
    });

    expect(reason).toContain('the kill stranded nothing: all 25 jobs the killed worker held');
    expect(reason).toContain('25 recorded under its id, 0 reclaimed, 0 still open');
    expect(reason).toContain('no log is written');
  });
});
