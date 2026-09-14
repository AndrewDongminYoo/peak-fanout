import { describe, expect, it } from 'bun:test';

import { createReadWriteDb, endReadWriteDb, type ReadWriteDb } from './index';

// `postgres(url)` connects lazily, so a pair can be built and closed here without a server.
const WRITE_URL = 'postgres://peak:peak@localhost:5432/peak';
const READ_URL = 'postgres://peak:peak@localhost:5433/peak';

describe('createReadWriteDb', () => {
  it('makes read the very same client as write when no read URL is set', async () => {
    // design.md "Data model": no replica means no second pool to the primary, so a deployment
    // without one opens no connection it did not open before and the M2 connection figure stands.
    const db = createReadWriteDb({ writeUrl: WRITE_URL });

    expect(db.read).toBe(db.write);
    expect(db.read.$client).toBe(db.write.$client);

    await endReadWriteDb(db, { timeout: 0 });
  });

  it('opens a second client for the read URL when one is set', async () => {
    const db = createReadWriteDb({ writeUrl: WRITE_URL, readUrl: READ_URL });

    expect(db.read).not.toBe(db.write);
    expect(db.read.$client).not.toBe(db.write.$client);
    expect(db.read.$client.options.port).toEqual([5433]);
    expect(db.write.$client.options.port).toEqual([5432]);

    await endReadWriteDb(db, { timeout: 0 });
  });

  it('treats an empty read URL as unset, the way the API treats an empty variable', async () => {
    const db = createReadWriteDb({ writeUrl: WRITE_URL, readUrl: '' });

    expect(db.read).toBe(db.write);

    await endReadWriteDb(db, { timeout: 0 });
  });
});

describe('endReadWriteDb', () => {
  it('ends a shared pool once and two pools once each', async () => {
    const shared = createReadWriteDb({ writeUrl: WRITE_URL });
    let sharedEnds = 0;
    const sharedEnd = shared.write.$client.end.bind(shared.write.$client);
    shared.write.$client.end = async (options) => {
      sharedEnds += 1;
      return sharedEnd(options);
    };
    await endReadWriteDb(shared, { timeout: 0 });
    expect(sharedEnds).toBe(1);

    const pair = createReadWriteDb({ writeUrl: WRITE_URL, readUrl: READ_URL });
    const ended: string[] = [];
    for (const [name, db] of [
      ['write', pair.write],
      ['read', pair.read],
    ] as const) {
      const end = db.$client.end.bind(db.$client);
      db.$client.end = async (options) => {
        ended.push(name);
        return end(options);
      };
    }
    await endReadWriteDb(pair, { timeout: 0 });
    expect(ended.sort()).toEqual(['read', 'write']);
  });

  it('still ends the read pool when the write pool fails to close, then rethrows that failure', async () => {
    // The worker awaits this in its `finally`; a write `end` that rejects must not leave the read
    // pool open to hold the process up. The helper touches only `$client.end`, so a fake pair is
    // enough.
    const failure = new Error('write pool refused to close');
    let readEnds = 0;
    const pair = {
      write: {
        $client: {
          end: async () => {
            throw failure;
          },
        },
      },
      read: {
        $client: {
          end: async () => {
            readEnds += 1;
          },
        },
      },
    } as unknown as ReadWriteDb;

    await expect(endReadWriteDb(pair, { timeout: 0 })).rejects.toBe(failure);
    expect(readEnds).toBe(1);
  });

  it('ends a shared pool once when its close fails, and rethrows that failure', async () => {
    const failure = new Error('shared pool refused to close');
    let ends = 0;
    const client = {
      $client: {
        end: async () => {
          ends += 1;
          throw failure;
        },
      },
    };
    const shared = { write: client, read: client } as unknown as ReadWriteDb;

    await expect(endReadWriteDb(shared, { timeout: 0 })).rejects.toBe(failure);
    expect(ends).toBe(1);
  });
});
