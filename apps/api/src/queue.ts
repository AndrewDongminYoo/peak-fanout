/** Shared seeded queue counts; no per-job or user details leave the repository. */
export type QueueSnapshot = {
  waiting: number;
  running: number;
  failed: number;
};

/** A fresh primary snapshot using the server's configured worker lease. */
export interface QueueRepository {
  snapshotSeeded(): Promise<QueueSnapshot>;
}
