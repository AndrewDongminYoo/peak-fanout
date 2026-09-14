import { M4_EXPRESSION_COUNT } from './seed-plan';

export const M4_RUN_LOG_SCHEMA_VERSION = 1;
export const M4_EXPERIMENT_POSITIONS = [1, 2_500_000, 5_000_000] as const;

export const M4_RUN_LOG_NOTE =
  'Single-machine localhost PostgreSQL 16 run over the expressions table. The execution times ' +
  'describe these two access paths on this machine and are not fan-out measurements.';

const INDEX_NODE_TYPES = new Set(['Index Scan', 'Index Only Scan', 'Bitmap Index Scan']);

type JsonObject = Record<string, unknown>;

export type M4TableShape = {
  rows: number;
  distinctPositions: number;
  minPosition: number;
  maxPosition: number;
};

export type M4RunLogInput = {
  baseCommit: string;
  worktreeDirty: boolean;
  startedAt: Date;
  endedAt: Date;
  table: M4TableShape;
  constraintRestored: boolean;
  beforePlan: unknown;
  afterPlan: unknown;
};

function object(value: unknown, name: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function explainDocument(value: unknown): { raw: unknown[]; document: JsonObject } {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('EXPLAIN FORMAT JSON must contain exactly one document');
  }
  return { raw: parsed, document: object(parsed[0], 'EXPLAIN document') };
}

type PlanSummary = { nodeTypes: string[]; indexNames: string[] };

function visitPlan(nodeValue: unknown, result: PlanSummary): void {
  const node = object(nodeValue, 'EXPLAIN plan node');
  const nodeType = node['Node Type'];
  if (typeof nodeType !== 'string' || nodeType.length === 0) {
    throw new Error('every EXPLAIN plan node must have a Node Type');
  }
  result.nodeTypes.push(nodeType);
  if (INDEX_NODE_TYPES.has(nodeType)) {
    const indexName = node['Index Name'];
    if (typeof indexName === 'string') result.indexNames.push(indexName);
  }

  const children = node.Plans;
  if (children === undefined) return;
  if (!Array.isArray(children)) throw new Error('EXPLAIN plan node Plans must be an array');
  for (const child of children) visitPlan(child, result);
}

function summarizePlan(value: unknown): PlanSummary {
  const { document } = explainDocument(value);
  const result: PlanSummary = { nodeTypes: [], indexNames: [] };
  visitPlan(document.Plan, result);
  return result;
}

/** Returns every plan-node type from one PostgreSQL `EXPLAIN (FORMAT JSON)` document. */
export function planNodeTypes(value: unknown): string[] {
  return summarizePlan(value).nodeTypes;
}

function executionTimeMs(value: unknown): number {
  const { document } = explainDocument(value);
  const executionTime = document['Execution Time'];
  if (typeof executionTime !== 'number' || !Number.isFinite(executionTime)) {
    throw new Error('EXPLAIN document must have a finite Execution Time');
  }
  return executionTime;
}

function rawExplain(value: unknown): unknown[] {
  return explainDocument(value).raw;
}

function exactM4Population(table: M4TableShape): boolean {
  return table.rows === M4_EXPRESSION_COUNT;
}

function denseM4Positions(table: M4TableShape): boolean {
  return (
    table.distinctPositions === M4_EXPRESSION_COUNT &&
    table.minPosition === 1 &&
    table.maxPosition === M4_EXPRESSION_COUNT
  );
}

/** Refuses any table other than the exact population the M4 plans are defined over. */
export function assertM4TableShape(table: M4TableShape): void {
  if (!exactM4Population(table)) {
    throw new Error(`M4 needs exactly ${M4_EXPRESSION_COUNT} expressions`);
  }
  if (!denseM4Positions(table)) {
    throw new Error(`M4 needs dense positions 1..${M4_EXPRESSION_COUNT}`);
  }
}

/** Builds the only JSON shape a successful M4 index experiment may write. */
export function buildM4RunLog(input: M4RunLogInput) {
  assertM4TableShape(input.table);
  const beforeSummary = summarizePlan(input.beforePlan);
  const afterSummary = summarizePlan(input.afterPlan);
  const beforeNodeTypes = beforeSummary.nodeTypes;
  const afterNodeTypes = afterSummary.nodeTypes;
  const beforeUsesIndex = beforeNodeTypes.some((nodeType) => INDEX_NODE_TYPES.has(nodeType));
  const afterUsesPositionIndex = afterSummary.indexNames.includes('expressions_position_unique');
  const beforeUsesSeqScan = beforeNodeTypes.includes('Seq Scan');

  if (!beforeUsesSeqScan || beforeUsesIndex) {
    throw new Error('the before plan must use Seq Scan and no index');
  }
  if (!afterUsesPositionIndex) {
    throw new Error('the after plan must use the position index');
  }
  if (!input.constraintRestored) {
    throw new Error('the expressions position constraint was not restored after rollback');
  }

  return {
    schema_version: M4_RUN_LOG_SCHEMA_VERSION,
    experiment: 'm4-expressions-index',
    base_commit: input.baseCommit,
    worktree_dirty: input.worktreeDirty,
    started_at: input.startedAt.toISOString(),
    ended_at: input.endedAt.toISOString(),
    note: M4_RUN_LOG_NOTE,
    table: {
      rows: input.table.rows,
      distinct_positions: input.table.distinctPositions,
      min_position: input.table.minPosition,
      max_position: input.table.maxPosition,
    },
    query: { positions: M4_EXPERIMENT_POSITIONS },
    before_index: {
      plan_node_types: beforeNodeTypes,
      execution_time_ms: executionTimeMs(input.beforePlan),
      explain: rawExplain(input.beforePlan),
    },
    after_index: {
      plan_node_types: afterNodeTypes,
      execution_time_ms: executionTimeMs(input.afterPlan),
      explain: rawExplain(input.afterPlan),
    },
    verdict: {
      passed: true,
      checks: [
        { name: 'exact M4 population', met: true },
        { name: `dense positions 1..${M4_EXPRESSION_COUNT}`, met: true },
        { name: 'before uses a sequential scan and no index', met: true },
        { name: 'after uses the position index', met: true },
        { name: 'unique constraint restored after rollback', met: true },
      ],
    },
  };
}

export function m4RunLogFileName(startedAt: Date): string {
  const instant = startedAt
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${instant}-m4-expressions-index.json`;
}
