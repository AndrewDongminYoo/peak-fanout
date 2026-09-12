import { describe, expect, it } from 'bun:test';
import postgres from 'postgres';

import { requireLoopbackDatabaseUrl } from './seed-guard';

describe('requireLoopbackDatabaseUrl', () => {
  it('accepts a database on this machine', () => {
    const local = 'postgres://peak:peak@localhost:5432/peak';
    expect(requireLoopbackDatabaseUrl(local)).toBe(local);
    expect(requireLoopbackDatabaseUrl('postgres://peak:peak@127.0.0.1:5432/peak')).toContain(
      '127.0.0.1',
    );
    expect(requireLoopbackDatabaseUrl('postgres://peak:peak@127.2.3.4:5432/peak')).toContain(
      '127.2.3.4',
    );
    // Accepted, not usable: the driver dials the literal host `[` for a bracketed address, so this
    // URL fails to connect rather than reaching anything. seed-guard.ts says why it stays accepted.
    expect(requireLoopbackDatabaseUrl('postgres://peak:peak@[::1]:5432/peak')).toContain('::1');
    expect(requireLoopbackDatabaseUrl('postgres://peak:p%40ss%2C1@localhost:5432/peak')).toContain(
      'localhost',
    );
    const alias = 'postgresql://peak:peak@localhost:5432/peak';
    expect(requireLoopbackDatabaseUrl(alias)).toBe(alias);
  });

  // A scheme the URL parser treats as special ends the authority at a backslash while the driver
  // reads past it, so this URL's hostname is `localhost` and the driver's host list is two remote
  // entries. The first-`@`/last-`@` comparison cannot catch it: with one `@` both readings are the
  // same string, and the disagreement is about where the authority ends. Hence the scheme gate.
  it('refuses a scheme whose authority the URL parser ends at a backslash', () => {
    const hidden = 'https://localhost\\@db.example.test,db2.example.test/peak';
    expect(new URL(hidden).hostname).toBe('localhost');
    expect(postgres(hidden, { max: 1 }).options.host).toEqual([
      'db.example.test',
      'db2.example.test',
    ]);
    expect(() => requireLoopbackDatabaseUrl(hidden)).toThrow(
      /scheme "https:" is neither "postgres:" nor "postgresql:"/,
    );
    expect(() => requireLoopbackDatabaseUrl('http://localhost:5432/peak')).toThrow(
      /scheme "http:" is neither/,
    );
    expect(() => requireLoopbackDatabaseUrl('ws://localhost:5432/peak')).toThrow(
      /scheme "ws:" is neither/,
    );
    // The same backslash under a scheme the guard does own is refused by the loopback check:
    // `postgres:` is not special, so the authority runs to the `/` and the host is the remote one.
    expect(() =>
      requireLoopbackDatabaseUrl('postgres://localhost\\@evil.example.test/peak'),
    ).toThrow(/host "evil\.example\.test" is not a loopback address/);
  });

  it('refuses a host it cannot prove is local, and names it', () => {
    expect(() =>
      requireLoopbackDatabaseUrl('postgres://peak:peak@db.example.test:5432/peak'),
    ).toThrow(/host "db\.example\.test" is not a loopback address/);
    expect(() => requireLoopbackDatabaseUrl('postgres://peak:peak@10.0.0.5:5432/peak')).toThrow(
      /not a loopback address/,
    );
    expect(() =>
      requireLoopbackDatabaseUrl('postgres://peak:peak@127.0.0.1.example.test/peak'),
    ).toThrow(/not a loopback address/);
    expect(() =>
      requireLoopbackDatabaseUrl('postgres://peak:peak@localhost,db.example.test/peak'),
    ).toThrow(/not a loopback address/);
  });

  // The URL host is what follows the last `@`, the driver's host is what follows the first one,
  // so a URL that hides a remote host in what the URL calls the password would otherwise pass the
  // loopback check and then connect to db.example.test. seed-guard.ts explains the split.
  it('refuses a URL whose host the driver reads differently', () => {
    expect(() =>
      requireLoopbackDatabaseUrl('postgres://u:p@db.example.test,localhost@localhost/peak'),
    ).toThrow(/ambiguous about its host/);
    expect(() =>
      requireLoopbackDatabaseUrl('postgres://u:p@db.example.test,localhost@localhost/peak'),
    ).toThrow(
      /The URL says "localhost" and the postgres driver reads "db\.example\.test,localhost/,
    );
    expect(() => requireLoopbackDatabaseUrl('postgres://peak:p@ss@localhost:5432/peak')).toThrow(
      /Percent-encode "@" as %40/,
    );
  });

  // `new URL()` ends the authority at the first `#`, the driver reads on past it and then splits
  // on commas, so this URL's host is `localhost` to the URL and a two-entry list whose second
  // entry is remote to the driver. The driver dials the second once the first fails to resolve.
  it('refuses a URL whose authority the driver reads past a fragment', () => {
    const hidden = 'postgres://peak:peak@localhost#ignored,db.example.test/peak';
    expect(() => requireLoopbackDatabaseUrl(hidden)).toThrow(/ambiguous about its host/);
    expect(() => requireLoopbackDatabaseUrl(hidden)).toThrow(
      /The URL says "localhost" and the postgres driver reads "localhost#ignored,db\.example\.test"/,
    );
    expect(() => requireLoopbackDatabaseUrl(hidden)).toThrow(/"#" as %23/);
    // A `#` anywhere else in the authority moves the two readings apart just as well.
    expect(() => requireLoopbackDatabaseUrl('postgres://pe#ak:peak@localhost/peak')).toThrow(
      /ambiguous about its host/,
    );
    // A fragment after the path is outside the authority for both parsers, so it stays accepted.
    expect(requireLoopbackDatabaseUrl('postgres://peak:peak@localhost:5432/peak#frag')).toContain(
      '#frag',
    );
  });

  // The guard proves a property of `new URL().hostname`, but what the seed's DELETE reaches is the
  // driver's candidate list. This reads that list from the driver itself: constructing a client
  // parses the options without opening a socket, so it needs no database and runs in CI.
  it('leaves the driver no non-loopback host to dial', () => {
    const accepted: [url: string, candidates: string[]][] = [
      ['postgres://peak:peak@localhost:5432/peak', ['localhost']],
      ['postgres://peak:peak@127.0.0.1:5432/peak', ['127.0.0.1']],
      ['postgres://peak:peak@127.2.3.4:5432/peak', ['127.2.3.4']],
      ['postgres://peak:p%40ss%2C1@localhost:5432/peak', ['localhost']],
      ['postgresql://peak:peak@localhost:5432/peak', ['localhost']],
      // A `host=` parameter does not move the driver off the hostname it parsed, so the guard's
      // reading stays the one that gets dialled.
      ['postgres://peak:peak@localhost:5432/peak?host=db.example.test', ['localhost']],
      ['postgres://peak:peak@localhost:5432/peak#frag', ['localhost']],
      // Accepted but unusable rather than remote: for a bracketed address the driver dials the
      // literal host `[`, which resolves nowhere. seed-guard.ts says why it stays accepted.
      ['postgres://peak:peak@[::1]:5432/peak', ['[']],
    ];

    for (const [url, candidates] of accepted) {
      expect(requireLoopbackDatabaseUrl(url)).toBe(url);
      expect(postgres(url, { max: 1 }).options.host).toEqual(candidates);
    }
  });

  it('refuses a URL with no host at all', () => {
    expect(() => requireLoopbackDatabaseUrl('postgres:///peak?host=/tmp')).toThrow(
      /host "" is not a loopback address/,
    );
    // No `://` at all: `driverAuthorityOf` has no authority to slice, and the empty hostname is
    // what refuses it. Pinned because that safety is a side effect rather than an explicit branch.
    expect(() => requireLoopbackDatabaseUrl('postgres:peak')).toThrow(
      /host "" is not a loopback address/,
    );
  });

  it('refuses a missing or unparsable value', () => {
    expect(() => requireLoopbackDatabaseUrl(undefined)).toThrow(/DATABASE_URL is not set/);
    expect(() => requireLoopbackDatabaseUrl('')).toThrow(/DATABASE_URL is not set/);
    expect(() => requireLoopbackDatabaseUrl('not-a-url')).toThrow(/DATABASE_URL is not a URL/);
  });
});
