import { deliveries, pushReceipts, pushTokens, type Db } from '@peak-fanout/db';
import { inArray } from 'drizzle-orm';

import type { SendOutcome } from '../worker/loop';
import type { DeliverySender } from './sender';

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Called after the job lock; delivery insertion takes the reminder FK lock before token locks. */
export async function recordWorkerSends(
  tx: Transaction,
  reminderId: string,
  outcomes: readonly SendOutcome[],
  sender: DeliverySender,
): Promise<void> {
  const values = outcomes.map((outcome) => ({
    reminderId,
    status: outcome.status,
    latencyMs: outcome.latencyMs,
    error: outcome.status === 'failed' ? outcome.error : null,
    sender,
  }));
  if (sender.sink.kind !== 'expo') {
    // Preserve the measured single insert; no RETURNING, extra reads, or receipt writes.
    await tx.insert(deliveries).values(values);
    return;
  }
  const identified = values.map((value) => ({ ...value, id: crypto.randomUUID() }));
  await tx.insert(deliveries).values(identified);
  const accepted = outcomes.flatMap((outcome, index) => {
    const delivery = identified[index];
    return outcome.status === 'sent' && outcome.ticketId && delivery
      ? [
          {
            deliveryId: delivery.id,
            ticketId: outcome.ticketId,
            registration: outcome.registration,
          },
        ]
      : [];
  });
  if (accepted.length === 0) return;
  const tokenIds = accepted.flatMap(({ registration }) => (registration ? [registration.id] : []));
  // A token may have disappeared during the SDK send. Lock existing rows before taking the
  // nullable FK so deletion either happened already (NULL) or waits and later SETs NULL.
  const existing =
    tokenIds.length === 0
      ? []
      : await tx
          .select({ id: pushTokens.id })
          .from(pushTokens)
          .where(inArray(pushTokens.id, tokenIds))
          .orderBy(pushTokens.id)
          .for('key share');
  const present = new Set(existing.map(({ id }) => id));
  await tx.insert(pushReceipts).values(
    accepted.map(({ deliveryId, ticketId, registration }) => ({
      deliveryId,
      ticketId,
      pushTokenId: registration && present.has(registration.id) ? registration.id : null,
      registrationUserId: registration?.userId ?? null,
      registrationCreatedAt: registration?.createdAt ?? null,
    })),
  );
}
