/** One public delivery-log row, with private reminder and sender details omitted. */
export type DeliveryRecord = {
  id: string;
  status: 'sent' | 'failed';
  latencyMs: number;
  createdAt: Date;
};

/** Reads the shared load-test delivery sample in newest-first order. */
export interface DeliveriesRepository {
  recentSeeded(limit: number): Promise<DeliveryRecord[]>;
}
