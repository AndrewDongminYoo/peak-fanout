// Runs load/verify-peak.sql and prints its rows.
// The seed calls verifyPeak() when it finishes, so the seed's report and `bun run db:verify-peak`
// are the same query rather than two counts that can drift apart.

import { join } from 'node:path';

import postgres from 'postgres';

import { peakInstant, seededEmails, TARGET_DATE } from './seed-plan';

type Client = ReturnType<typeof postgres>;

export type VerifyRow = {
  ord: number;
  key: string;
  metric: string;
  value: string;
};

const QUERY_PATH = join(import.meta.dir, '../../../load/verify-peak.sql');

export async function verifyPeak(
  sql: Client,
  targetDate: string = TARGET_DATE,
): Promise<VerifyRow[]> {
  const query = await Bun.file(QUERY_PATH).text();
  const rows = await sql.unsafe<VerifyRow[]>(query, [
    targetDate,
    peakInstant(targetDate).toISOString(),
    seededEmails(),
  ]);
  return [...rows];
}

export function formatVerifyRows(rows: VerifyRow[]): string {
  const width = Math.max(...rows.map((row) => row.metric.length));
  return rows.map((row) => `  ${row.metric.padEnd(width)}  ${row.value.padStart(6)}`).join('\n');
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');

  const sql = postgres(url);
  try {
    console.log(formatVerifyRows(await verifyPeak(sql)));
  } finally {
    await sql.end();
  }
}
