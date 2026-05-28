/**
 * Job Snapshot Types and Factory
 * 
 * Domain types for job authorization snapshots used in async operations.
 */

import type { JobAuthorizationSnapshot } from "../secret-broker/types.js";

export type { JobAuthorizationSnapshot } from "../secret-broker/types.js";

/**
 * Repository interface for job authorization snapshots
 */
export interface JobSnapshotRepository {
  get(jobId: string): Promise<JobAuthorizationSnapshot | null>;
  put(snapshot: JobAuthorizationSnapshot): Promise<void>;
  delete(jobId: string): Promise<void>;
}

/**
 * Create a job snapshot for the current time
 */
export function createJobSnapshot(
  jobId: string,
  userId: string,
  workspaceId: string,
  allowedOperations: string[],
  expiryMs: number = 60 * 60 * 1000 // 1 hour default
): JobAuthorizationSnapshot {
  const now = Date.now();
  return {
    jobId,
    createdByUserId: userId,
    workspaceId,
    allowedOperations,
    createdAt: now,
    expiresAt: now + expiryMs,
    authorizationVersion: 1,
  };
}
