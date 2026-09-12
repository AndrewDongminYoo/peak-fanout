// The seed deletes every row it owns before inserting, so it refuses to talk to anything
// that is not on this machine. The check runs before the Postgres client is constructed.
//
// The scheme is pinned to `postgres:` / `postgresql:` first, because the rest of the check only
// holds for a scheme `new URL()` treats as non-special. For a special scheme such as `https:` the
// WHATWG parser reads a backslash as a path separator and ends the authority there, so
// `https://localhost\@db.example.test,db2.example.test/peak` has the URL hostname `localhost`
// while the driver reads past the backslash and comma-splits the rest into a remote host list.
// The first-`@`/last-`@` comparison below structurally cannot see that one: with a single `@`
// both readings yield the identical string, and the disagreement is about where the authority
// ENDS, which only `new URL()` honours for those schemes.
//
// The host then has to be read twice, because `new URL()` and the `postgres` driver disagree about
// both where the authority ends and where the host inside it starts (`parseUrl` in
// node_modules/postgres/src/index.js):
//
//   - the host starts after the LAST `@` of the authority for `new URL()`, and after the FIRST
//     one for the driver, which then splits it on commas into a list of hosts to try. So in
//     `postgres://u:p@db.example.test,localhost@localhost/db` the URL host is `localhost` while
//     the driver dials `db.example.test` first.
//   - the authority ends at the first `/`, `?` or `#` for `new URL()`, and at the first `/` or
//     `?` for the driver, which does not treat `#` as a delimiter. So in
//     `postgres://u:p@localhost#ignored,db.example.test/db` the URL host is `localhost` while
//     the driver builds the list `['localhost#ignored', 'db.example.test']` and, once the
//     unresolvable first entry fails, dials `db.example.test`.
//
// Either way a check that trusted the URL alone would let the seed's DELETE run against a remote
// database. So each parser's reading is derived with that parser's own authority boundary, and any
// URL the two read differently is refused rather than guessed at. That also refuses an unencoded
// `@`, `,` or `#` in the password; percent-encode those (`%40`, `%2C`, `%23`) and the two agree
// again. A `#` after the path (`.../db#frag`) is not in the authority for either parser and stays
// accepted.
//
// One known-harmless gap: for a bracketed IPv6 URL such as `postgres://u:p@[::1]:5432/db` the
// driver dials the literal host `[`, which resolves nowhere, so that URL is accepted here and
// then fails to connect. It cannot reach a remote database, so the guard leaves it alone.

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 === null) return false;
  // Every octet has to be in range, not just the first: `127.999.999.999` is four groups of
  // digits but not an address, so the OS sends it down name resolution instead of dialling it,
  // where a wildcard DNS zone or a search domain can answer with a remote address. The regex
  // already fixes the group count at four.
  const octets = ipv4.slice(1).map(Number);
  return octets[0] === 127 && octets.every((octet) => octet <= 255);
}

/**
 * The `user:pass@host:port` part of a URL as the `postgres` driver reads it: everything between
 * `://` and the first `/` or `?`. `new URL()` ends it one character set wider, at the first `/`,
 * `?` or `#`, which is why the caller cuts this result again at `#` for the URL's own reading.
 */
function driverAuthorityOf(raw: string): string {
  return raw.slice(raw.indexOf('://') + 3).split(/[?/]/)[0] ?? '';
}

/**
 * Returns `raw` when it points at a loopback database, and throws otherwise.
 *
 * An empty hostname (a Unix socket path, or a `host=` query parameter) is refused too:
 * the point of the check is a host this process can prove, not one it can guess.
 */
export function requireLoopbackDatabaseUrl(raw: string | undefined): string {
  if (!raw) {
    throw new Error('refusing to seed: DATABASE_URL is not set.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('refusing to seed: DATABASE_URL is not a URL.');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(
      `refusing to seed: DATABASE_URL scheme "${url.protocol}" is neither "postgres:" nor ` +
        '"postgresql:". For the schemes the URL parser treats as special a backslash ends the ' +
        'authority, which the postgres driver reads straight past, so the host this check proves ' +
        'would not be the host the seed connects to.',
    );
  }

  const hostname = url.hostname;
  const driverAuthority = driverAuthorityOf(raw);
  const urlAuthority = driverAuthority.split('#')[0] ?? '';
  const driverReads = driverAuthority.slice(driverAuthority.indexOf('@') + 1);
  const urlReads = urlAuthority.slice(urlAuthority.lastIndexOf('@') + 1);
  if (driverReads !== urlReads) {
    throw new Error(
      `refusing to seed: DATABASE_URL is ambiguous about its host. The URL says "${urlReads}" ` +
        `and the postgres driver reads "${driverReads}", so the host this check proves is not ` +
        'the host the seed would connect to. Percent-encode "@" as %40, "," as %2C and "#" as ' +
        '%23 in the password, leaving a single host after the last "@".',
    );
  }

  if (!isLoopbackHost(hostname)) {
    throw new Error(
      `refusing to seed: DATABASE_URL host "${hostname}" is not a loopback address. ` +
        'The seed deletes every row it owns before inserting, so it runs only against a ' +
        'database on this machine (localhost, 127.0.0.0/8 or ::1).',
    );
  }

  return raw;
}
