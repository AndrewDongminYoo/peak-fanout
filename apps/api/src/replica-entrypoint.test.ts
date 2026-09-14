import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ENTRYPOINT = resolve(import.meta.dir, '../../../docker/postgres/replica-entrypoint.sh');
const temporaryRoots: string[] = [];

async function exists(file: string) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function writeExecutable(file: string, source: string) {
  await writeFile(file, source);
  await chmod(file, 0o755);
}

function runEntrypoint(bin: string, pgdata: string, result: string) {
  return Bun.spawnSync({
    cmd: ['bash', ENTRYPOINT],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PGDATA: pgdata,
      POSTGRES_REPLICATION_USER: 'peak_replica',
      POSTGRES_REPLICATION_PASSWORD: 'peak',
      TEST_RESULT: result,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('replica entrypoint', () => {
  it('replaces an interrupted base backup, then reuses only the completed one', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'peak-replica-entrypoint-'));
    temporaryRoots.push(fixtureRoot);
    const bin = join(fixtureRoot, 'bin');
    const pgdata = join(fixtureRoot, 'pgdata');
    const result = join(fixtureRoot, 'started');
    await Promise.all([mkdir(bin), mkdir(pgdata)]);

    await writeExecutable(
      join(bin, 'docker-entrypoint.sh'),
      '#!/usr/bin/env bash\n[[ -f "$PGDATA/.basebackup-complete" ]] || exit 90\nprintf "started\\n" > "$TEST_RESULT"\n',
    );
    await writeExecutable(
      join(bin, 'pg_basebackup'),
      '#!/usr/bin/env bash\nprintf "16\\n" > "$PGDATA/PG_VERSION"\ntouch "$PGDATA/partial-sentinel"\nexit 23\n',
    );

    const interrupted = runEntrypoint(bin, pgdata, result);
    expect(interrupted.exitCode).toBe(23);
    expect(await exists(join(pgdata, 'PG_VERSION'))).toBe(true);
    expect(await exists(join(pgdata, '.basebackup-complete'))).toBe(false);

    await writeExecutable(
      join(bin, 'pg_basebackup'),
      '#!/usr/bin/env bash\n[[ ! -e "$PGDATA/partial-sentinel" ]] || exit 91\nprintf "16\\n" > "$PGDATA/PG_VERSION"\ntouch "$PGDATA/base-backed-up"\n',
    );

    const recovered = runEntrypoint(bin, pgdata, result);
    expect(recovered.exitCode).toBe(0);
    expect(await exists(join(pgdata, '.basebackup-complete'))).toBe(true);
    expect(await exists(join(pgdata, 'base-backed-up'))).toBe(true);
    expect(await readFile(result, 'utf8')).toBe('started\n');

    await unlink(result);
    await writeExecutable(join(bin, 'pg_basebackup'), '#!/usr/bin/env bash\nexit 92\n');

    const reused = runEntrypoint(bin, pgdata, result);
    expect(reused.exitCode).toBe(0);
    expect(await readFile(result, 'utf8')).toBe('started\n');
  });
});
