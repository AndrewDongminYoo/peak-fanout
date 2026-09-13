import { describe, expect, it } from 'bun:test';

import {
  describePoolInsertFailure,
  gitProvenance,
  poolEmail,
  readHarnessConfig,
  requireLoopbackApiUrl,
  runGit,
  runLockOnDatabase,
  schedulerCommand,
  startTraffic,
  verifyPoolThroughApi,
  waitForFanoutEnd,
  withApiLoadPool,
  withRunLock,
  type PoolUser,
} from './m1';

type Reading = { pending: number; attempts: number; connections: number };

/**
 * An API that accepts every connection and never answers: the promise settles only when the
 * signal the harness attached aborts, which is what the real `fetch` does with a hung connection.
 * Without a signal it never settles at all, so a call site that dropped its bound fails its test.
 */
function hangingFetch() {
  const calls: { method: string; path: string }[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path: new URL(String(input)).pathname });
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

/**
 * The error a promise rejects with, awaited directly rather than through `expect(...).rejects`:
 * bun's per-test timeout does not interrupt that matcher on a promise that never settles (bun
 * 1.3.14), so a bound that went missing would hang the whole run instead of failing one test.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(outcome instanceof Error)) throw new Error(`expected a rejection, got ${String(outcome)}`);
  return outcome;
}

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

/** The readings a poll returns in order, repeating the last one forever. */
function replay(readings: Reading[]): () => Promise<Reading> {
  let index = 0;
  return async () => {
    const reading = readings[Math.min(index, readings.length - 1)] as Reading;
    index += 1;
    return reading;
  };
}

describe('waitForFanoutEnd', () => {
  it('returns when the last reminder on the peak instant leaves pending', async () => {
    const clock = fakeClock();

    const end = await waitForFanoutEnd({
      poll: replay([
        { pending: 3, attempts: 1, connections: 2 },
        { pending: 1, attempts: 3, connections: 5 },
        { pending: 0, attempts: 4, connections: 3 },
      ]),
      opening: { pending: 4, attempts: 1, connections: 2 },
      stallTimeoutMs: 120_000,
      sleep: clock.sleep,
      now: clock.now,
      log: () => {},
    });

    // The peak connection count is the highest seen across the window, not the last one.
    expect(end).toEqual({ peakConnections: 5, attempts: 4, pending: 0, stalled: false });
  });

  it('returns a stalled fan-out instead of throwing, so the run still writes its log', async () => {
    // This is the test the whole injected-dependency shape exists for. When this threw, a run
    // that left reminders `pending` ended before `buildRunLog`, so `verdict.met` could not read
    // false on either fan-out check in any log the harness actually wrote.
    const clock = fakeClock();
    const lines: string[] = [];

    const end = await waitForFanoutEnd({
      poll: replay([{ pending: 5, attempts: 10, connections: 4 }]),
      opening: { pending: 5, attempts: 10, connections: 4 },
      stallTimeoutMs: 3_000,
      sleep: clock.sleep,
      now: clock.now,
      log: (line) => lines.push(line),
    });

    expect(end).toEqual({ peakConnections: 4, attempts: 10, pending: 5, stalled: true });
    // Both fan-out verdict checks read false off this: 5 still pending, and 10 attempts for the
    // reminders the run set out to send.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('10 attempted, 5 still pending');
  });

  it('keeps waiting as long as attempts are still being recorded', async () => {
    const clock = fakeClock();
    // Progress every poll, over far more elapsed time than the stall timeout allows between two
    // readings: a slow fan-out is not a stalled one.
    const end = await waitForFanoutEnd({
      poll: replay([
        { pending: 3, attempts: 1, connections: 1 },
        { pending: 2, attempts: 2, connections: 1 },
        { pending: 1, attempts: 3, connections: 1 },
        { pending: 0, attempts: 4, connections: 1 },
      ]),
      opening: { pending: 4, attempts: 1, connections: 1 },
      stallTimeoutMs: 1_500,
      sleep: async (ms) => clock.sleep(ms * 10),
      now: clock.now,
      log: () => {},
    });

    expect(end.stalled).toBe(false);
    expect(end.attempts).toBe(4);
  });

  it('counts the reading that opened the window in the peak connection count', async () => {
    // Connection usage crests as the fan-out begins: the poll that first saw a delivery read 7,
    // and every later poll read fewer. That first poll is inside the window, so the peak is 7 and
    // not the highest of the polls that followed it.
    const clock = fakeClock();

    const end = await waitForFanoutEnd({
      poll: replay([
        { pending: 2, attempts: 2, connections: 4 },
        { pending: 0, attempts: 4, connections: 3 },
      ]),
      opening: { pending: 3, attempts: 1, connections: 7 },
      stallTimeoutMs: 120_000,
      sleep: clock.sleep,
      now: clock.now,
      log: () => {},
    });

    expect(end.peakConnections).toBe(7);
  });
});

describe('runGit', () => {
  // The bug this pins: a failed `git status` leaves nothing on stdout, and nothing on stdout is
  // what a clean tree also produces, so a runner that returned stdout regardless of exit code
  // would record `worktree_dirty: false` for a tree git could not read at all.
  it('throws on a non-zero exit instead of returning the empty stdout a failure leaves', async () => {
    await expect(
      runGit(['rev-parse', '--verify', 'refs/no-such-ref-for-this-test']),
    ).rejects.toThrow(/git rev-parse --verify refs\/no-such-ref-for-this-test exited 128/);
  });

  it('returns trimmed stdout on success', async () => {
    await expect(runGit(['rev-parse', '--is-inside-work-tree'])).resolves.toBe('true');
  });
});

describe('gitProvenance', () => {
  it('records the commit the run sat on top of and that the tree held uncommitted code', async () => {
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      return args[0] === 'rev-parse' ? '0123456789abcdef0123456789abcdef01234567' : ' M README.md';
    };

    await expect(gitProvenance(git)).resolves.toEqual({
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
      worktreeDirty: true,
    });
    expect(calls).toEqual([
      ['rev-parse', 'HEAD'],
      ['status', '--porcelain'],
    ]);
  });

  it('is clean only when git reports no change at all', async () => {
    const git = async (args: string[]) => (args[0] === 'rev-parse' ? 'abc' : '');

    await expect(gitProvenance(git)).resolves.toEqual({ baseCommit: 'abc', worktreeDirty: false });
  });

  it('refuses a tree it cannot read a commit from', async () => {
    await expect(gitProvenance(async () => '')).rejects.toThrow('could not read the current git');
  });
});

describe('readHarnessConfig', () => {
  it('refuses a database that is not on this machine, in this command own words', () => {
    expect(() =>
      readHarnessConfig({
        DATABASE_URL: 'postgres://peak:peak@db.example.test:5432/peak',
        SUPABASE_JWT_SECRET: 'secret',
      }),
    ).toThrow(/^refusing to run: DATABASE_URL host "db\.example\.test"/);
  });

  it('defaults the pool, the rate and the two timeouts', () => {
    const config = readHarnessConfig({
      DATABASE_URL: 'postgres://peak:peak@localhost:5432/peak',
      SUPABASE_JWT_SECRET: 'secret',
    });

    expect(config).toMatchObject({
      apiUrl: 'http://localhost:3000',
      poolUsers: 200,
      requestsPerSecond: 20,
      startTimeoutMs: 120_000,
      stallTimeoutMs: 120_000,
    });
  });
});

describe('requireLoopbackApiUrl', () => {
  it('accepts an API on this machine and keeps only its origin', () => {
    expect(requireLoopbackApiUrl('http://localhost:3000/ignored')).toBe('http://localhost:3000');
    expect(requireLoopbackApiUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });

  it('refuses anything the run would reach off this machine', () => {
    expect(() => requireLoopbackApiUrl('http://api.example.test')).toThrow(
      /host "api\.example\.test" is not a loopback address/,
    );
    expect(() => requireLoopbackApiUrl('not-a-url')).toThrow(/is not a URL/);
    expect(() => requireLoopbackApiUrl('ftp://localhost')).toThrow(/is not http or https/);
  });
});

describe('poolEmail', () => {
  it('is the harness pool own address and never a seeded one', () => {
    expect(poolEmail(0)).toBe('apiload-0@example.test');
    expect(poolEmail(199)).toBe('apiload-199@example.test');
  });
});

describe('withApiLoadPool', () => {
  function lifecycle(remove: () => Promise<number> = async () => 3) {
    const calls: string[] = [];
    const lines: string[] = [];
    return {
      calls,
      lines,
      deps: {
        create: async () => {
          calls.push('create');
          return [{ id: 'user-0', email: poolEmail(0), token: 'token' }];
        },
        remove: async () => {
          calls.push('remove');
          return remove();
        },
        log: (line: string) => lines.push(line),
      },
    };
  }

  it('deletes the pool when the measurement refuses, not only when it succeeds', async () => {
    // The finding this shape exists for: every refusal raised after the pool is created — a
    // scheduler that never sent, a stalled fan-out, an empty window — left its rows behind, and a
    // later run then found rows at its own addresses that it had not written.
    const { calls, deps } = lifecycle();

    await expect(
      withApiLoadPool(deps, async () => {
        throw new Error('the fan-out recorded no delivery for the peak instant');
      }),
    ).rejects.toThrow('the fan-out recorded no delivery');
    expect(calls).toEqual(['create', 'remove']);
  });

  it('deletes the pool when creating it fails halfway, which the insert has already written', async () => {
    // `createPool` writes all 200 rows in one statement and then verifies each through
    // `POST /auth/session`; a refusal from that second half would otherwise leave the pool.
    const { calls, deps } = lifecycle();
    const failing = {
      ...deps,
      create: async () => {
        calls.push('create');
        throw new Error('POST /auth/session answered 401 for apiload-5@example.test');
      },
    };

    await expect(withApiLoadPool(failing, async () => 1)).rejects.toThrow(
      'POST /auth/session answered 401',
    );
    expect(calls).toEqual(['create', 'remove']);
  });

  it('deletes the pool on the success path and returns what the measurement returned', async () => {
    const { calls, lines, deps } = lifecycle();

    await expect(withApiLoadPool(deps, async (pool) => pool.length)).resolves.toBe(1);
    expect(calls).toEqual(['create', 'remove']);
    expect(lines[0]).toContain('deleted 3 API-load users');
  });

  it('reports a cleanup failure without replacing the error that caused it', async () => {
    // A throwing `finally` would hide the refusal, which is the more useful of the two errors.
    const { lines, deps } = lifecycle(async () => {
      throw new Error('connection terminated');
    });

    await expect(
      withApiLoadPool(deps, async () => {
        throw new Error('no API request fell inside the fan-out window');
      }),
    ).rejects.toThrow('no API request fell inside the fan-out window');
    expect(lines[0]).toContain('could not delete the API-load users: connection terminated');
    // The rows carry the flag, so the next run's sweep is the remedy the message names.
    expect(lines[0]).toContain('next run sweeps them');
  });

  it('fails an otherwise successful run whose cleanup failed, keeping the cause', async () => {
    // The log is written inside `body`, so it stands; but a run that returned its verdict with
    // its rows still in the database would exit 0 against what it documents.
    const { calls, lines, deps } = lifecycle(async () => {
      throw new Error('connection terminated');
    });

    const outcome = withApiLoadPool(deps, async () => true);

    await expect(outcome).rejects.toThrow('API-load users were not deleted');
    await outcome.catch((error: Error) => {
      expect((error.cause as Error).message).toBe('connection terminated');
    });
    expect(calls).toEqual(['create', 'remove']);
    expect(lines[0]).toContain('could not delete the API-load users: connection terminated');
  });
});

describe('runLockOnDatabase', () => {
  /**
   * A client whose reserved connection is a tagged template that records each statement and
   * answers from a script — enough to see what the sweep asks and whether it reads the answer.
   */
  function fakeClient(answer: (statement: string) => unknown[]) {
    const statements: string[] = [];
    const session = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        void values;
        const statement = strings.raw.join('?').replace(/\s+/g, ' ').trim();
        statements.push(statement);
        return answer(statement);
      },
      { release: () => statements.push('release') },
    );
    return {
      statements,
      sql: { reserve: async () => session } as unknown as Parameters<typeof runLockOnDatabase>[0],
    };
  }

  it('asks the deleting backend whether it holds the lock in the same statement as the delete', async () => {
    // The driver reconnects a dropped connection object to serve the pool, so a reserved handle
    // can answer from a backend that never took the lock; and a check followed by a separate
    // delete leaves a gap for that to happen in. So the delete's predicate is the lock question,
    // on the reserved connection, in one statement — and the answer is read, not merely received.
    const { sql, statements } = fakeClient((statement) =>
      statement.includes('pg_try_advisory_lock')
        ? [{ locked: true }]
        : [{ held: false, deleted: 0 }],
    );
    const lock = runLockOnDatabase(sql);

    expect(await lock.tryLock()).toBe(true);
    expect(await lock.sweepWhileHeld()).toEqual({ held: false, deleted: 0 });
    expect(statements).toHaveLength(2);
    const sweep = statements[1] ?? '';
    expect(sweep).toContain('pg_locks');
    expect(sweep).toContain('pg_backend_pid()');
    expect(sweep).toContain('DELETE FROM users WHERE load_pool AND');
  });

  it('reports what the sweep removed while the deleting backend holds the lock', async () => {
    const { sql } = fakeClient((statement) =>
      statement.includes('pg_try_advisory_lock')
        ? [{ locked: true }]
        : [{ held: true, deleted: 200 }],
    );
    const lock = runLockOnDatabase(sql);

    expect(await lock.tryLock()).toBe(true);
    expect(await lock.sweepWhileHeld()).toEqual({ held: true, deleted: 200 });
  });
});

describe('withRunLock', () => {
  /** One database's lock, as a flag: held by whichever run took it first, until that run unlocks. */
  function lock(unlock: () => Promise<void> = async () => {}) {
    let held = false;
    let connected = true;
    const calls: string[] = [];
    const lines: string[] = [];
    return {
      calls,
      lines,
      /** What the server does when the reserved connection drops: the lock is simply gone. */
      dropConnection: () => {
        connected = false;
        held = false;
      },
      deps: {
        tryLock: async () => {
          calls.push('tryLock');
          if (held) return false;
          held = true;
          return true;
        },
        sweepWhileHeld: async () => {
          calls.push('sweepWhileHeld');
          return { held: connected && held, deleted: connected && held ? 3 : 0 };
        },
        unlock: async () => {
          calls.push('unlock');
          held = false;
          await unlock();
        },
        log: (line: string) => lines.push(line),
      },
    };
  }

  it('hands the run its sweep, which deletes nothing once the connection has dropped', async () => {
    // A session lock ends with its connection and the server tells nobody. The only defense a run
    // has is a sweep that asks the lock in the same statement, so it must be reachable from inside
    // `body`, and it must report the lock gone rather than delete.
    const { calls, deps, dropConnection } = lock();

    await withRunLock(deps, async ({ sweepWhileHeld }) => {
      expect(await sweepWhileHeld()).toEqual({ held: true, deleted: 3 });
      dropConnection();
      expect(await sweepWhileHeld()).toEqual({ held: false, deleted: 0 });
    });
    expect(calls).toEqual(['tryLock', 'sweepWhileHeld', 'sweepWhileHeld', 'unlock']);
  });

  it('refuses a second run while the first still holds the database, before it does anything', async () => {
    // The finding this exists for: the due-and-pending count is not a run lock. Every peak
    // reminder stays `pending` until the scheduler's first delivery, so a second harness started
    // while the first waited for the scheduler passed every check, and its sweep deleted the
    // first run's pool.
    const { calls, deps } = lock();
    let finishFirst!: () => void;
    const first = withRunLock(
      deps,
      () =>
        new Promise<string>((resolve) => {
          finishFirst = () => resolve('first');
        }),
    );
    let secondRan = false;

    await expect(
      withRunLock(deps, async () => {
        secondRan = true;
        return 'second';
      }),
    ).rejects.toThrow('another `bun run load:m1` holds this database');
    expect(secondRan).toBe(false);
    // The refusal touched nothing, so it has nothing to unlock: the first run still holds it.
    expect(calls).toEqual(['tryLock', 'tryLock']);

    finishFirst();
    await expect(first).resolves.toBe('first');
    expect(calls).toEqual(['tryLock', 'tryLock', 'unlock']);
  });

  it('unlocks after the run own cleanup, however the run ends', async () => {
    // The pool delete sits inside `body`, so an unlock that came first would open the stretch
    // the lock exists to close: another run sweeping a pool that has not been deleted yet.
    const { calls, deps } = lock();

    await expect(
      withRunLock(deps, async () => {
        calls.push('delete pool');
        throw new Error('the fan-out recorded no delivery for the peak instant');
      }),
    ).rejects.toThrow('the fan-out recorded no delivery');
    expect(calls).toEqual(['tryLock', 'delete pool', 'unlock']);

    // And the database is free again for the run after it.
    await expect(
      withRunLock(deps, async () => {
        calls.push('delete pool');
        return true;
      }),
    ).resolves.toBe(true);
    expect(calls).toEqual(['tryLock', 'delete pool', 'unlock', 'tryLock', 'delete pool', 'unlock']);
  });

  it('reports a failed unlock without replacing the error that caused it', async () => {
    // As with the pool cleanup: the refusal is the more useful of the two errors, and the lock
    // goes with the connection whether or not the unlock statement reached the database.
    const { lines, deps } = lock(async () => {
      throw new Error('connection terminated');
    });

    await expect(
      withRunLock(deps, async () => {
        throw new Error('no API request fell inside the fan-out window');
      }),
    ).rejects.toThrow('no API request fell inside the fan-out window');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('could not release the run lock: connection terminated');
  });
});

describe('verifyPoolThroughApi', () => {
  const apiUrl = 'http://localhost:3000';

  /** Three pool rows as the insert returned them; the token doubles as the fake API's lookup key. */
  function pool(): PoolUser[] {
    return [0, 1, 2].map((index) => ({
      id: `db-a-${index}`,
      email: poolEmail(index),
      token: `token-${index}`,
    }));
  }

  type Call = { method: string; path: string; token: string };

  /**
   * A fake API on one database: `rows` maps a token to the id the API would serve for it, and a
   * token it does not know answers 404 from `GET /me` and creates a fresh id from the upsert.
   */
  function fakeApi(rows: Record<string, string>, options: { status?: number } = {}) {
    const calls: Call[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const token = (headers.get('authorization') ?? '').replace('Bearer ', '');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, token });
      if (options.status) return new Response('', { status: options.status });
      const served = rows[token];
      if (method === 'GET') {
        return served
          ? Response.json({ timezone: 'UTC', reminder_time: '21:00:00', push_token: null })
          : Response.json({ error: 'not_found' }, { status: 404 });
      }
      return Response.json({ id: served ?? `db-b-created-for-${token}`, email: 'x' });
    }) as typeof fetch;
    return { calls, fetchFn };
  }

  it('passes when the API serves every pool row by the id this run inserted', async () => {
    const api = fakeApi({ 'token-0': 'db-a-0', 'token-1': 'db-a-1', 'token-2': 'db-a-2' });

    await expect(verifyPoolThroughApi(apiUrl, pool(), api.fetchFn)).resolves.toBeUndefined();
    // One read-only probe, then one session call per row.
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /me',
      'POST /auth/session',
      'POST /auth/session',
      'POST /auth/session',
    ]);
  });

  it('refuses an API on another database before asking it to upsert anything', async () => {
    // The finding this exists for: `POST /auth/session` upserts, so an API on a different
    // database with the same secret would create the row there and answer 200, and the run would
    // measure `GET /me` against one database and everything else against another. The empty
    // fake API is that other database: it holds none of this run's rows.
    const api = fakeApi({});

    await expect(verifyPoolThroughApi(apiUrl, pool(), api.fetchFn)).rejects.toThrow(
      /GET \/me answered 404 for apiload-0@example\.test.*different DATABASE_URL.*Nothing was written/s,
    );
    // The refusal came from the probe alone, so that database gained no `load_pool = false` row.
    expect(api.calls).toEqual([{ method: 'GET', path: '/me', token: 'token-0' }]);
  });

  it('refuses when the API serves the address from a row this run did not create', async () => {
    // The other database already holds a stray row at the first address — the state a run
    // before this check left behind — so the probe passes and only the id tells the two apart.
    const api = fakeApi({ 'token-0': 'db-b-stray' });

    await expect(verifyPoolThroughApi(apiUrl, pool(), api.fetchFn)).rejects.toThrow(
      /served apiload-0@example\.test from a row this run did not create \(the API returned id db-b-stray; this run's insert returned db-a-0\)/,
    );
    // It stops at the first mismatch: the upsert that mismatched found an existing row, and no
    // later address was sent to an API that would have created one.
    expect(api.calls).toHaveLength(2);
  });

  it('refuses a 200 that carries no user id, which is not this repository API', async () => {
    const { calls, fetchFn } = fakeApi({ 'token-0': 'db-a-0' });
    const fetchNoId = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetchFn(input, init);
      return init?.method === 'POST' ? Response.json({ ok: true }) : response;
    }) as typeof fetch;

    await expect(verifyPoolThroughApi(apiUrl, pool(), fetchNoId)).rejects.toThrow(
      /answered 200 for apiload-0@example\.test without a user id/,
    );
    expect(calls).toHaveLength(2);
  });

  it('names the secret when the API refuses the token, before any session call', async () => {
    const api = fakeApi({}, { status: 401 });

    await expect(verifyPoolThroughApi(apiUrl, pool(), api.fetchFn)).rejects.toThrow(
      /GET \/me answered 401 for apiload-0@example\.test.*SUPABASE_JWT_SECRET/s,
    );
    expect(api.calls).toHaveLength(1);
  });

  it('refuses an empty pool rather than reporting it verified', async () => {
    const api = fakeApi({});

    await expect(verifyPoolThroughApi(apiUrl, [], api.fetchFn)).rejects.toThrow(
      'the API-load pool is empty',
    );
    expect(api.calls).toHaveLength(0);
  });

  it('refuses when the API accepts the probe and never answers, instead of waiting forever', async () => {
    // Before the bound, this call never settled: the pool delete and the lock release that run
    // after it could not run either, and the process sat there until someone killed it.
    const { calls, fetchFn } = hangingFetch();

    const error = await rejectionOf(verifyPoolThroughApi(apiUrl, pool(), fetchFn, 20));

    expect(error.message).toMatch(
      /^refusing to run: GET \/me for apiload-0@example\.test got no answer within 0\.02s/,
    );
    expect(calls).toEqual([{ method: 'GET', path: '/me' }]);
  });

  it('bounds the session calls the same way, not only the probe', async () => {
    const api = fakeApi({ 'token-0': 'db-a-0' });
    const hung = hangingFetch();
    const fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
      init?.method === 'POST'
        ? hung.fetchFn(input, init)
        : api.fetchFn(input, init)) as typeof fetch;

    const error = await rejectionOf(verifyPoolThroughApi(apiUrl, pool(), fetchFn, 20));

    expect(error.message).toMatch(
      /^refusing to run: POST \/auth\/session for apiload-0@example\.test got no answer within 0\.02s/,
    );
    expect(hung.calls).toEqual([{ method: 'POST', path: '/auth/session' }]);
  });

  it('passes a refused connection through unchanged rather than calling it a timeout', async () => {
    const fetchFn = (async (input: string | URL | Request): Promise<Response> => {
      throw new Error(`Unable to connect to ${String(input)}. Is the computer able to access it?`);
    }) as typeof fetch;

    const error = await rejectionOf(verifyPoolThroughApi(apiUrl, pool(), fetchFn, 20));

    expect(error.message).toBe(
      'Unable to connect to http://localhost:3000/me. Is the computer able to access it?',
    );
  });
});

describe('startTraffic', () => {
  const config = { apiUrl: 'http://localhost:3000', requestsPerSecond: 1000 };
  const pool: PoolUser[] = [{ id: 'db-a-0', email: poolEmail(0), token: 'token-0' }];

  it('stops once every hung request has hit its bound, recording each as an error', async () => {
    // Before the bound, `stop` spun on the in-flight count forever, so a run whose fan-out had
    // finished never reached the run log.
    const { calls, fetchFn } = hangingFetch();
    const traffic = startTraffic(config, pool, fetchFn, 20);
    await Bun.sleep(15);

    // Raced against a cap for the same reason `rejectionOf` exists: an unbounded `stop` must
    // fail this test, not hold the run open.
    const stopped = await Promise.race([
      traffic.stop().then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);

    expect(stopped).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(traffic.samples).toHaveLength(calls.length);
    expect(traffic.samples.every((sample) => sample.status === 0)).toBe(true);
  });

  it('lets a request in flight at stop finish with its real status', async () => {
    // Such a request started inside the window, and the verdict grades its status, so `stop`
    // drains rather than aborts: an abort would record a harness-made error against the API.
    const fetchFn = (async (input: string | URL | Request) => {
      await Bun.sleep(30);
      return new Response(String(input));
    }) as typeof fetch;
    const traffic = startTraffic({ ...config, requestsPerSecond: 100 }, pool, fetchFn);
    await Bun.sleep(15);

    await traffic.stop();

    expect(traffic.samples.length).toBeGreaterThan(0);
    expect(traffic.samples.every((sample) => sample.status === 200)).toBe(true);
  });
});

describe('schedulerCommand', () => {
  it('sets SCHEDULER_NOW and nothing else, so .env can supply DATABASE_URL in a fresh terminal', () => {
    // A `DATABASE_URL="$DATABASE_URL"` prefix here set the variable to "" in the fourth terminal
    // README describes, Bun then kept that empty value over the one in `.env`, and `requireEnv`
    // rejected it: the scheduler died at startup and the harness timed out waiting for it.
    const line = schedulerCommand(new Date('2026-09-15T12:00:00Z'));

    expect(line).toBe('SCHEDULER_NOW=2026-09-15T12:00:00.000Z bun run dev:scheduler');
    expect(line).not.toContain('DATABASE_URL');
  });
});

describe('describePoolInsertFailure', () => {
  it('refuses when an address the pool needs is held by a row the run did not write', () => {
    const message = describePoolInsertFailure({
      code: '23505',
      detail: 'Key (email)=(apiload-3@example.test) already exists.',
      message: 'duplicate key value violates unique constraint "users_email_unique"',
    });

    expect(message).toContain('already held by a row this run did not create');
    expect(message).toContain('apiload-3@example.test');
    // Ownership is the flag, so the harness says what it will not do rather than deleting it.
    expect(message).toContain('does not carry `users.load_pool`');
  });

  it('passes any other failure through as itself', () => {
    expect(describePoolInsertFailure(new Error('connection refused'))).toBe(
      'could not create the API-load pool: connection refused',
    );
  });
});
