import { describe, expect, it } from 'bun:test';

import {
  buildM4RunLog,
  M4_EXPERIMENT_POSITIONS,
  M4_RUN_LOG_SCHEMA_VERSION,
  m4RunLogFileName,
  planNodeTypes,
} from './m4';

const BEFORE_PLAN = [
  {
    Plan: {
      'Node Type': 'Gather',
      Plans: [{ 'Node Type': 'Seq Scan' }],
    },
    'Planning Time': 0.15,
    'Execution Time': 91.25,
  },
];

const AFTER_PLAN = [
  {
    Plan: {
      'Node Type': 'Bitmap Heap Scan',
      Plans: [{ 'Node Type': 'Bitmap Index Scan', 'Index Name': 'expressions_position_unique' }],
    },
    'Planning Time': 0.2,
    'Execution Time': 0.08,
  },
];

describe('planNodeTypes', () => {
  it('walks every nested PostgreSQL plan node in display order', () => {
    expect(planNodeTypes(BEFORE_PLAN)).toEqual(['Gather', 'Seq Scan']);
    expect(planNodeTypes(AFTER_PLAN)).toEqual(['Bitmap Heap Scan', 'Bitmap Index Scan']);
  });

  it('refuses a value that is not one EXPLAIN FORMAT JSON document', () => {
    expect(() => planNodeTypes([])).toThrow(/one document/);
    expect(() => planNodeTypes([{ Plan: { Plans: [] } }])).toThrow(/Node Type/);
  });
});

describe('buildM4RunLog', () => {
  const input = {
    baseCommit: 'abc123',
    worktreeDirty: true,
    startedAt: new Date('2026-09-14T12:00:00.000Z'),
    endedAt: new Date('2026-09-14T12:00:04.000Z'),
    table: {
      rows: 5_000_000,
      distinctPositions: 5_000_000,
      minPosition: 1,
      maxPosition: 5_000_000,
    },
    constraintRestored: true,
    beforePlan: BEFORE_PLAN,
    afterPlan: AFTER_PLAN,
  };

  it('writes the verified table, access paths, timings, provenance, and verdict', () => {
    expect(buildM4RunLog(input)).toEqual({
      schema_version: M4_RUN_LOG_SCHEMA_VERSION,
      experiment: 'm4-expressions-index',
      base_commit: 'abc123',
      worktree_dirty: true,
      started_at: '2026-09-14T12:00:00.000Z',
      ended_at: '2026-09-14T12:00:04.000Z',
      note: expect.any(String),
      table: {
        rows: 5_000_000,
        distinct_positions: 5_000_000,
        min_position: 1,
        max_position: 5_000_000,
      },
      query: { positions: M4_EXPERIMENT_POSITIONS },
      before_index: {
        plan_node_types: ['Gather', 'Seq Scan'],
        execution_time_ms: 91.25,
        explain: BEFORE_PLAN,
      },
      after_index: {
        plan_node_types: ['Bitmap Heap Scan', 'Bitmap Index Scan'],
        execution_time_ms: 0.08,
        explain: AFTER_PLAN,
      },
      verdict: {
        passed: true,
        checks: [
          { name: 'exact M4 population', met: true },
          { name: 'dense positions 1..5000000', met: true },
          { name: 'before uses a sequential scan and no index', met: true },
          { name: 'after uses the position index', met: true },
          { name: 'unique constraint restored after rollback', met: true },
        ],
      },
    });
  });

  it('refuses a table that is not the exact dense M4 population', () => {
    expect(() => buildM4RunLog({ ...input, table: { ...input.table, rows: 4_999_999 } })).toThrow(
      /exactly 5000000/,
    );
    expect(() => buildM4RunLog({ ...input, table: { ...input.table, minPosition: 0 } })).toThrow(
      /dense positions/,
    );
  });

  it('refuses a before plan that already uses an index', () => {
    expect(() => buildM4RunLog({ ...input, beforePlan: AFTER_PLAN })).toThrow(
      /before plan must use Seq Scan and no index/,
    );
  });

  it('refuses an after plan that did not use an index', () => {
    expect(() => buildM4RunLog({ ...input, afterPlan: BEFORE_PLAN })).toThrow(
      /after plan must use the position index/,
    );
  });

  it('refuses an after plan backed by a different index', () => {
    const wrongIndex = structuredClone(AFTER_PLAN);
    wrongIndex[0]!.Plan.Plans[0]!['Index Name'] = 'another_index';
    expect(() => buildM4RunLog({ ...input, afterPlan: wrongIndex })).toThrow(
      /after plan must use the position index/,
    );
  });

  it('refuses to record a run whose rollback did not restore the constraint', () => {
    expect(() => buildM4RunLog({ ...input, constraintRestored: false })).toThrow(
      /constraint was not restored/,
    );
  });
});

describe('m4RunLogFileName', () => {
  it('names the M4 experiment from its start instant', () => {
    expect(m4RunLogFileName(new Date('2026-09-14T12:34:56.789Z'))).toBe(
      '2026-09-14T12-34-56Z-m4-expressions-index.json',
    );
  });
});
