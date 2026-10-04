import { pushReceipts, pushTokens, type Db } from '@peak-fanout/db';
import { and, eq, sql } from 'drizzle-orm';

import type { ReceiptsRepository } from './receipts';

export function createDrizzleReceiptsRepository(db: Db): ReceiptsRepository {
  return {
    async claim(limit, leaseMs) {
      const rows = await db.execute(sql`
        WITH due AS MATERIALIZED (
          SELECT delivery_id FROM push_receipts
          WHERE status = 'pending' AND next_check_at <= now()
          ORDER BY next_check_at, delivery_id
          LIMIT ${limit}::int FOR UPDATE SKIP LOCKED
        )
        UPDATE push_receipts AS receipt
        SET next_check_at = CASE
              WHEN receipt.accepted_at + interval '24 hours' <= now()
                THEN now() + (${leaseMs}::int * interval '1 millisecond')
              ELSE least(now() + (${leaseMs}::int * interval '1 millisecond'),
                         receipt.accepted_at + interval '24 hours')
            END,
            attempts = receipt.attempts + 1
        FROM due WHERE receipt.delivery_id = due.delivery_id AND receipt.status = 'pending'
        RETURNING receipt.delivery_id, receipt.ticket_id, receipt.attempts, receipt.accepted_at::text
      `);
      return rows.map((row) => ({
        deliveryId: String(row.delivery_id),
        ticketId: String(row.ticket_id),
        attempts: Number(row.attempts),
        acceptedAt: new Date(String(row.accepted_at)),
      }));
    },
    async finish(row, update) {
      await db.transaction(async (tx) => {
        // Token before receipt: DELETE token's SET NULL also locks the receipt. Taking the
        // opposite order here would deadlock with sign-out. An unlocked read locates the token;
        // the guarded UPDATE below is the authority for whether this claim may finish/prune.
        const prune = update.status === 'error' && update.errorCode === 'DeviceNotRegistered';
        const [snapshot] = prune
          ? await tx.select().from(pushReceipts).where(eq(pushReceipts.deliveryId, row.deliveryId))
          : [];
        if (snapshot?.pushTokenId) {
          await tx
            .select({ id: pushTokens.id })
            .from(pushTokens)
            .where(eq(pushTokens.id, snapshot.pushTokenId))
            .for('update');
        }
        const [written] = await tx
          .update(pushReceipts)
          .set(update)
          .where(
            and(
              eq(pushReceipts.deliveryId, row.deliveryId),
              eq(pushReceipts.status, 'pending'),
              eq(pushReceipts.attempts, row.attempts),
            ),
          )
          .returning();
        if (
          prune &&
          written?.pushTokenId &&
          written.registrationUserId &&
          written.registrationCreatedAt
        ) {
          await tx.delete(pushTokens).where(
            and(
              eq(pushTokens.id, written.pushTokenId),
              eq(pushTokens.userId, written.registrationUserId),
              // Compare in PostgreSQL: Date would truncate microseconds and miss/exceed a version.
              sql`${pushTokens.createdAt} = ${written.registrationCreatedAt}::timestamptz`,
            ),
          );
        }
      });
    },
  };
}
