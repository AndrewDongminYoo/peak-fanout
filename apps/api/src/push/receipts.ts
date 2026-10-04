// Database-free polling contract. Expo receipts confirm provider handoff, not device arrival.
export const RECEIPT_DEFAULTS = {
  batchSize: 1_000,
  leaseMs: 300_000,
  pollMs: 60_000,
  maxAttempts: 8,
  maxAgeMs: 86_400_000,
} as const;

export function readReceiptConfig(env: Record<string, string | undefined>) {
  if (env.PUSH_SINK !== 'expo') throw new Error('push:receipts requires PUSH_SINK=expo');
  return RECEIPT_DEFAULTS;
}

export type ClaimedReceipt = {
  deliveryId: string;
  ticketId: string;
  attempts: number;
  acceptedAt: Date;
};
export type ReceiptUpdate = {
  status: 'pending' | 'ok' | 'error' | 'expired';
  errorCode: string | null;
  lastError: string | null;
  checkedAt: Date;
  nextCheckAt: Date;
};
export interface ReceiptsRepository {
  claim(limit: number, leaseMs: number): Promise<ClaimedReceipt[]>;
  finish(row: ClaimedReceipt, update: ReceiptUpdate): Promise<void>;
}
export interface ExpoReceiptsClient {
  getPushNotificationReceiptsAsync(ids: string[]): Promise<Record<string, unknown>>;
}
export type ReceiptPollDeps = {
  repository: ReceiptsRepository;
  client: ExpoReceiptsClient;
  now: () => Date;
  /** SDK maximum is 1,000; a smaller size is useful for mock chunk tests. */
  chunkSize?: number;
};

function resultFor(
  row: ClaimedReceipt,
  receipt: unknown,
  now: Date,
  failure?: string,
): ReceiptUpdate {
  const base = { errorCode: null, lastError: null, checkedAt: now, nextCheckAt: now };
  if (!failure && receipt !== undefined) {
    if (typeof receipt === 'object' && receipt !== null && 'status' in receipt) {
      if (receipt.status === 'ok') return { ...base, status: 'ok' };
      if (
        receipt.status === 'error' &&
        'message' in receipt &&
        typeof receipt.message === 'string'
      ) {
        // The SDK validates the receipt map, not each entry. Validate error fields before
        // making the result terminal or allowing its code to prune a registration.
        const details = 'details' in receipt ? receipt.details : undefined;
        if (details === undefined) return { ...base, status: 'error' };
        if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
          const code = 'error' in details ? details.error : undefined;
          const token = 'expoPushToken' in details ? details.expoPushToken : undefined;
          if (
            (code === undefined || typeof code === 'string') &&
            (token === undefined || typeof token === 'string')
          ) {
            return { ...base, status: 'error', errorCode: code ?? null };
          }
        }
      }
    }
    failure = 'ReceiptMalformed';
  }
  return {
    ...base,
    status:
      row.attempts >= RECEIPT_DEFAULTS.maxAttempts ||
      now.getTime() - row.acceptedAt.getTime() >= RECEIPT_DEFAULTS.maxAgeMs
        ? 'expired'
        : 'pending',
    lastError: failure ?? 'ReceiptMissing',
    nextCheckAt: new Date(
      Math.min(
        now.getTime() + Math.min(60, 2 ** (row.attempts - 1)) * 60_000,
        row.acceptedAt.getTime() + RECEIPT_DEFAULTS.maxAgeMs,
      ),
    ),
  };
}

export async function pollReceiptBatch({
  repository,
  client,
  now,
  chunkSize = 1_000,
}: ReceiptPollDeps): Promise<number> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 1_000)
    throw new Error('receipt chunk size must be 1..1000');
  const rows = await repository.claim(RECEIPT_DEFAULTS.batchSize, RECEIPT_DEFAULTS.leaseMs);
  const active: ClaimedReceipt[] = [];
  const writes: Promise<void>[] = [];
  // Attach rejection handlers immediately; let every result settle before propagating DB errors.
  const record = (row: ClaimedReceipt, update: ReceiptUpdate) => {
    writes.push(repository.finish(row, update));
    void writes[writes.length - 1]?.catch(() => {});
  };
  for (const row of rows) {
    const instant = now();
    if (
      row.attempts > RECEIPT_DEFAULTS.maxAttempts ||
      instant.getTime() - row.acceptedAt.getTime() >= RECEIPT_DEFAULTS.maxAgeMs
    ) {
      record(row, resultFor(row, undefined, instant, 'ReceiptExpired'));
    } else active.push(row);
  }
  for (let offset = 0; offset < active.length; offset += chunkSize) {
    const chunk = active.slice(offset, offset + chunkSize);
    let receipts: Record<string, unknown> = {};
    let failure: string | undefined;
    try {
      receipts = await client.getPushNotificationReceiptsAsync(chunk.map((row) => row.ticketId));
      if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts)) {
        receipts = {};
        failure = 'ReceiptMalformed';
      }
    } catch {
      failure = 'ReceiptRequestFailed';
    }
    for (const row of chunk) record(row, resultFor(row, receipts[row.ticketId], now(), failure));
  }
  const results = await Promise.allSettled(writes);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return rows.length;
}

export async function runReceiptLoop(
  deps: ReceiptPollDeps & {
    shutdown: AbortSignal;
    sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    log: (line: string) => void;
  },
): Promise<void> {
  while (!deps.shutdown.aborted) {
    const count = await pollReceiptBatch(deps);
    if (count === 0) await deps.sleep(RECEIPT_DEFAULTS.pollMs, deps.shutdown);
    else deps.log(`receipts checked=${count}`);
  }
}
