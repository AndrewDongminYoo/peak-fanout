// The restart procedure of a `LOAD_WORKER_RESTART=1` run: pick the worker holding the most open
// claims, prove that the pid is a worker on this machine, send it SIGKILL, and remember what it
// held so the close read can say what became of it. design.md "Metric definitions and their
// sources" → "Jobs lost across worker restart" owns the definition and the procedure; this file
// is its implementation and decides nothing the section does not state.
//
// Everything with a side effect is a parameter — the claims query, the process read, the kill,
// the clock and the sleep — so the test never signals anything, never opens a connection and
// never waits on the real clock. `m1.ts` supplies the real ones.
//
// SIGKILL and not SIGTERM: the worker's drain makes "0 lost" true by construction, and a gate on
// a drained shutdown could only catch a broken drain. The lease is the harder property, and only
// a kill without a drain exercises it.

/** One worker's open claims at one instant: its `locked_by`, and the ids of the jobs it holds. */
export type OpenClaims = { lockedBy: string; jobIds: string[] };

/**
 * One reading of the claims query: the peak's delivery attempts and every worker's open claims,
 * from one statement so the two describe one instant.
 */
export type ClaimsReading = { attempts: number; workers: OpenClaims[] };

export type KillChoice =
  | { kind: 'chosen'; workerId: string; pid: number; jobIds: string[] }
  | { kind: 'refused'; reason: string };

/** How often the procedure re-reads the claims while no worker holds one, and for how long. */
export const RESTART_PICK_POLL_MS = 50;
export const RESTART_PICK_BOUND_MS = 5_000;

/**
 * `hostname:pid` as the worker writes it, split on the LAST colon: a hostname is what the
 * machine says it is, and nothing here forbids one that carries a colon of its own.
 */
export function parseWorkerId(lockedBy: string): { host: string; pid: number } | null {
  const at = lockedBy.lastIndexOf(':');
  if (at <= 0) return null;
  const host = lockedBy.slice(0, at);
  const rawPid = lockedBy.slice(at + 1);
  if (!/^[1-9]\d*$/.test(rawPid)) return null;
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid)) return null;
  return { host, pid };
}

/**
 * Whether a `ps -p <pid> -o command=` line has the shape of a worker: a `bun` command line —
 * the bare name or a path ending in it — whose first argument after any flags is the worker
 * script (`src/worker/index.ts`, bare or under a path) and nothing after it, or is `run` with
 * `worker` or `dev:worker` as its target. The executable and its argument, never a substring:
 * `vim src/worker/index.ts` and `echo run worker` name the same words and are not workers.
 *
 * The shape is all this line checks, and it is the whole check. It keeps a pid that was reused
 * by something that is not a worker — an editor, a pager, another project's server — from
 * SIGKILL. It does not prove that the process belongs to this checkout: a worker of the main
 * checkout and a worker of a worktree both print `bun src/worker/index.ts`, the same bytes, and
 * `ps` has nothing more to say. That is the right boundary rather than a gap, because the pid
 * came from `locked_by` on an open claim over this database's peak jobs, re-read just before
 * the signal (`runRestartProcedure`), and only one Postgres can listen on the port every
 * checkout's `DATABASE_URL` names, so a worker that stamps those claims is connected to this
 * database: it is part of the fleet under measurement whichever directory started it, and
 * refusing it would abort a run that was doing what it set out to do. What no read here can
 * tell apart is a pid the machine handed to a second worker: that process is a worker of the
 * same fleet, the record names the id the claims carried, and its held jobs are stranded
 * either way.
 *
 * Only `-flag` and `--flag=value` tokens are skipped as flags; a flag written `--flag value` is
 * not understood and the line is refused, which is the safe direction. An empty line is a pid
 * nobody holds, and anything else is a process this run must not touch.
 */
export function isWorkerCommand(commandLine: string): boolean {
  const tokens = commandLine.trim().split(/\s+/);
  const [executable, ...args] = tokens;
  if (executable === undefined || !/(^|\/)bun$/.test(executable)) return false;

  const skipFlags = (from: number): number => {
    let index = from;
    while (index < args.length && (args[index] as string).startsWith('-')) index += 1;
    return index;
  };
  const scriptAt = skipFlags(0);
  const script = args[scriptAt];
  if (script === undefined) return false;
  if (/(^|\/)src\/worker\/index\.ts$/.test(script)) return scriptAt === args.length - 1;
  if (script !== 'run') return false;
  const targetAt = skipFlags(scriptAt + 1);
  return targetAt === args.length - 1 && /^(dev:)?worker$/.test(args[targetAt] as string);
}

/**
 * The worker to kill, from one reading of the open claims: the one holding the most, ties broken
 * by the smaller `locked_by` so two readings of one state pick one worker.
 *
 * `null` means no worker holds an open claim at this instant — every one is between batches — and
 * a kill now would strand nothing and measure nothing, so the caller reads again. A refusal is a
 * worker that must not be signalled: its host is not this machine, or its pid is not a pid.
 */
export function chooseWorkerToKill(workers: OpenClaims[], hostname: string): KillChoice | null {
  const holding = workers
    .filter((worker) => worker.jobIds.length > 0)
    .sort((a, b) =>
      b.jobIds.length !== a.jobIds.length
        ? b.jobIds.length - a.jobIds.length
        : a.lockedBy < b.lockedBy
          ? -1
          : a.lockedBy > b.lockedBy
            ? 1
            : 0,
    );
  const top = holding[0];
  if (!top) return null;

  const parsed = parseWorkerId(top.lockedBy);
  if (!parsed) {
    return {
      kind: 'refused',
      reason: `locked_by "${top.lockedBy}" is not of the form hostname:pid, so there is no process to signal`,
    };
  }
  if (parsed.host !== hostname) {
    return {
      kind: 'refused',
      reason:
        `locked_by "${top.lockedBy}" names host "${parsed.host}" and this machine is "${hostname}"; ` +
        'the run only kills a worker it can see',
    };
  }
  return { kind: 'chosen', workerId: top.lockedBy, pid: parsed.pid, jobIds: top.jobIds };
}

/** What the procedure recorded at the kill; the ids stay here for the close read and are not logged. */
export type RestartRecord = {
  workerId: string;
  pid: number;
  killedAt: Date;
  attemptsAtKill: number;
  jobsHeld: string[];
};

export type RestartDeps = {
  /** This machine's hostname, which the chosen worker's `locked_by` has to name. */
  hostname: string;
  /** One reading: the peak's attempts and every worker's open claims. `m1.ts` passes the query. */
  claims: () => Promise<ClaimsReading>;
  /** `ps -p <pid> -o command=`, trimmed; empty when no such process. */
  describeProcess: (pid: number) => Promise<string>;
  /** `process.kill(pid, 'SIGKILL')` in the process; whatever records the call in a test. */
  kill: (pid: number) => void | Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  pollMs?: number;
  boundMs?: number;
};

/**
 * Pick, verify, read again, kill, record — once.
 *
 * Reads the claims every `pollMs` until some worker holds an open claim, for at most `boundMs`:
 * a reading with no open claim is a between-batches instant, waited out rather than acted on.
 * The chosen worker's pid is then read back through `ps` and has to be a worker, because a pid
 * read from a table can have been reused by an unrelated process on a machine where other work
 * runs in parallel; a mismatch refuses the run rather than killing anything else.
 *
 * The process read spawned `ps` and waited for it, and a batch at 50–150 ms per send can finish
 * inside that wait: a record taken from the reading that chose the worker would then list jobs
 * the kill never stranded, and the close read would count them as finished by the killed worker.
 * So the claims are read once more after the verification, with nothing but the signal left
 * between that reading and the kill, and the record is that reading. A chosen worker that holds
 * nothing any more is a between-batches instant like any other: waited out, and the next
 * reading chooses again.
 */
export async function runRestartProcedure({
  hostname,
  claims,
  describeProcess,
  kill,
  now,
  sleep,
  log,
  pollMs = RESTART_PICK_POLL_MS,
  boundMs = RESTART_PICK_BOUND_MS,
}: RestartDeps): Promise<RestartRecord> {
  const startedAt = now();
  const waitOrGiveUp = async () => {
    if (now() - startedAt >= boundMs) {
      throw new Error(
        `refusing to kill: no reading over ${boundMs / 1000}s found a worker holding an open ` +
          "claim on the peak's jobs at the instant before the signal, so there was no batch to " +
          'strand. Are the workers running against this database?',
      );
    }
    await sleep(pollMs);
  };
  for (;;) {
    const reading = await claims();
    const choice = chooseWorkerToKill(reading.workers, hostname);
    if (choice === null) {
      await waitOrGiveUp();
      continue;
    }
    if (choice.kind === 'refused') {
      throw new Error(`refusing to kill: ${choice.reason}. Nothing was signalled.`);
    }

    const command = await describeProcess(choice.pid);
    if (!isWorkerCommand(command)) {
      throw new Error(
        `refusing to kill: pid ${choice.pid} from locked_by "${choice.workerId}" is ` +
          (command.trim() === ''
            ? 'not a running process'
            : `running "${command.trim()}", which is not a worker`) +
          '. A pid read from a table can have been reused; nothing was signalled.',
      );
    }

    const last = await claims();
    const held = last.workers.find((worker) => worker.lockedBy === choice.workerId);
    if (!held || held.jobIds.length === 0) {
      log(
        `worker ${choice.workerId} held nothing any more once its process was verified; ` +
          'reading again',
      );
      await waitOrGiveUp();
      continue;
    }
    await kill(choice.pid);
    const killedAt = new Date(now());
    log(
      `killed worker ${choice.workerId} with SIGKILL at ${killedAt.toISOString()} while it held ` +
        `${held.jobIds.length} jobs, at ${last.attempts} attempts; nobody starts a replacement`,
    );
    return {
      workerId: choice.workerId,
      pid: choice.pid,
      killedAt,
      attemptsAtKill: last.attempts,
      jobsHeld: held.jobIds,
    };
  }
}

/** The fates of the held jobs at window close, as `m1.ts` reads them; they partition `jobsHeld`. */
export type HeldJobsFateCounts = {
  jobsHeld: number;
  finishedByKilledWorker: number;
  finishedByAnotherWorker: number;
  stillOpenAtClose: number;
};

/**
 * Why a completed restart run is refused rather than logged, or null when it measured the lease.
 *
 * A kill that stranded nothing — every job it held at the signal finished under the killed
 * worker's own id, none reclaimed and none still open — landed after the batch it was picked for
 * had finished, in the gap that remains after the last reading. The lease was never exercised
 * and "0 lost" would be true by construction, which is the SIGTERM outcome by another route; a log
 * named `-restart` would then fill the fourth cell with a run that measured nothing. A held job
 * still open at close is stranded, so that run is logged and its ninth check misses, which is
 * what the check is for.
 */
export function killStrandedNothingReason(fate: HeldJobsFateCounts): string | null {
  if (fate.finishedByAnotherWorker + fate.stillOpenAtClose > 0) return null;
  return (
    `the kill stranded nothing: all ${fate.jobsHeld} jobs the killed worker held at the signal ` +
    `were finished by the killed worker itself (${fate.finishedByKilledWorker} recorded under its ` +
    'id, 0 reclaimed, 0 still open), so the lease was never exercised, no restart was measured ' +
    'and no log is written'
  );
}

/** The part of a progress reading the intervention decides on. */
export type FanoutProgress = { attempts: number };

export type RestartIntervention = {
  /** Called once per poll of the fan-out window; acts on the first reading at or past the quarter. */
  intervene: (progress: FanoutProgress) => Promise<void>;
  /** What the kill recorded, or null while it has not happened. */
  record: () => RestartRecord | null;
};

/**
 * The hook `waitForFanoutEnd` calls once per poll in a restart run: it does nothing until the
 * first reading at or past one quarter of the peak's reminders attempted, runs the procedure
 * once, and does nothing after. The quarter is design.md's choice of "mid-fan-out": far enough
 * in that every worker is claiming, far enough from the end that the fleet still has work to
 * carry on with while the killed worker's batch waits out the lease.
 */
export function createRestartIntervention(
  reminders: number,
  deps: RestartDeps,
): RestartIntervention {
  let record: RestartRecord | null = null;
  return {
    async intervene(progress) {
      // The poll loop awaits this hook, so it never runs twice at once; a procedure that throws
      // ends the run through the loop, and a record once taken is final.
      if (record !== null || progress.attempts * 4 < reminders) return;
      record = await runRestartProcedure(deps);
    },
    record: () => record,
  };
}
