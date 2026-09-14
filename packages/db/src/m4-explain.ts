// The M4 experiment: explain the cards' three-position predicate over exactly 5,000,000 rows,
// first without the position constraint's index and then with it. The constraint changes exist
// only inside one transaction that is always rolled back; design.md "Expression index experiment
// (M4)" owns the contract and the result shape.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import postgres from 'postgres';

import { requireLoopbackDatabaseUrl } from './seed-guard';
import {
  assertM4TableShape,
  buildM4RunLog,
  M4_EXPERIMENT_POSITIONS,
  m4RunLogFileName,
  type M4TableShape,
} from './m4';

type Client = ReturnType<typeof postgres>;
type ReservedClient = Awaited<ReturnType<Client['reserve']>>;

const REPOSITORY_ROOT = join(import.meta.dir, '../../..');
const RESULTS_DIR = join(REPOSITORY_ROOT, 'load/results');

type ConstraintState = {
  validated: boolean;
  indexValid: boolean;
  indexUnique: boolean;
};

type GitProvenance = { baseCommit: string; worktreeDirty: boolean };

async function runGit(args: string[]): Promise<string> {
  const process = Bun.spawn(['git', '-C', REPOSITORY_ROOT, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout.trim();
}

async function gitProvenance(): Promise<GitProvenance> {
  const [baseCommit, porcelain] = await Promise.all([
    runGit(['rev-parse', 'HEAD']),
    runGit(['status', '--porcelain']),
  ]);
  if (!baseCommit) throw new Error('could not read the current git commit');
  return { baseCommit, worktreeDirty: porcelain.length > 0 };
}

async function readTableShape(sql: Client | ReservedClient): Promise<M4TableShape> {
  const [row] = await sql<
    {
      rows: number;
      distinct_positions: number;
      min_position: number;
      max_position: number;
    }[]
  >`
    SELECT
      count(*)::int AS rows,
      count(DISTINCT position)::int AS distinct_positions,
      min(position)::int AS min_position,
      max(position)::int AS max_position
    FROM expressions
  `;
  if (!row) throw new Error('the expressions shape query returned no row');
  return {
    rows: row.rows,
    distinctPositions: row.distinct_positions,
    minPosition: row.min_position,
    maxPosition: row.max_position,
  };
}

async function readConstraintState(sql: Client | ReservedClient): Promise<ConstraintState | null> {
  const [row] = await sql<{ validated: boolean; index_valid: boolean; index_unique: boolean }[]>`
    SELECT
      c.convalidated AS validated,
      i.indisvalid AS index_valid,
      i.indisunique AS index_unique
    FROM pg_constraint AS c
    JOIN pg_index AS i ON i.indexrelid = c.conindid
    WHERE c.conrelid = 'expressions'::regclass
      AND c.conname = 'expressions_position_unique'
      AND c.contype = 'u'
  `;
  return row
    ? { validated: row.validated, indexValid: row.index_valid, indexUnique: row.index_unique }
    : null;
}

function isValidConstraint(state: ConstraintState | null): boolean {
  return state?.validated === true && state.indexValid === true && state.indexUnique === true;
}

async function explainCardsPredicate(sql: ReservedClient): Promise<unknown> {
  const rows = await sql<{ 'QUERY PLAN': unknown }[]>`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT id, position, lang, text, translation, level
    FROM expressions
    WHERE position IN ${sql([...M4_EXPERIMENT_POSITIONS])}
  `;
  const plan = rows[0]?.['QUERY PLAN'];
  if (plan === undefined) throw new Error('EXPLAIN returned no JSON plan');
  return plan;
}

async function measureBeforeAndAfter(
  sql: Client,
): Promise<{ table: M4TableShape; before: unknown; after: unknown }> {
  const session = await sql.reserve();
  let transactionStarted = false;
  let result: { table: M4TableShape; before: unknown; after: unknown } | null = null;
  let runError: unknown;

  try {
    await session`BEGIN`;
    transactionStarted = true;
    await session`LOCK TABLE expressions IN ACCESS EXCLUSIVE MODE`;
    const table = await readTableShape(session);
    assertM4TableShape(table);
    const initialConstraint = await readConstraintState(session);
    if (!isValidConstraint(initialConstraint)) {
      throw new Error('M4 needs the valid expressions_position_unique constraint before it starts');
    }
    await session`ANALYZE expressions`;
    await session`ALTER TABLE expressions DROP CONSTRAINT expressions_position_unique`;
    const before = await explainCardsPredicate(session);
    await session`
      ALTER TABLE expressions
      ADD CONSTRAINT expressions_position_unique UNIQUE (position)
    `;
    const after = await explainCardsPredicate(session);
    result = { table, before, after };
  } catch (error) {
    runError = error;
  } finally {
    try {
      if (transactionStarted) await session`ROLLBACK`;
    } catch (rollbackError) {
      runError = runError
        ? new AggregateError([runError, rollbackError], 'M4 experiment and rollback both failed')
        : rollbackError;
    } finally {
      session.release();
    }
  }

  if (runError) throw runError;
  if (!result) throw new Error('the M4 experiment produced no plans');
  return result;
}

async function writeResult(path: string, value: unknown): Promise<void> {
  const file = Bun.file(path);
  if (await file.exists()) throw new Error(`refusing to overwrite M4 result: ${path}`);
  await mkdir(RESULTS_DIR, { recursive: true });
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function run(databaseUrl: string): Promise<string> {
  const startedAt = new Date();
  const provenance = await gitProvenance();
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const plans = await measureBeforeAndAfter(sql);
    const constraintRestored = isValidConstraint(await readConstraintState(sql));
    const endedAt = new Date();
    const log = buildM4RunLog({
      ...provenance,
      startedAt,
      endedAt,
      table: plans.table,
      constraintRestored,
      beforePlan: plans.before,
      afterPlan: plans.after,
    });
    const path = join(RESULTS_DIR, m4RunLogFileName(startedAt));
    await writeResult(path, log);
    return path;
  } finally {
    await sql.end();
  }
}

function databaseUrlOrExit(): string {
  try {
    return requireLoopbackDatabaseUrl(process.env.DATABASE_URL, 'run M4 experiment');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) {
  try {
    const path = await run(databaseUrlOrExit());
    console.log(`wrote ${path}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
