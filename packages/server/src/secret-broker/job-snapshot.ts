/**
 * Job Authorization Snapshot Repository
 * Stores job authorization snapshots for async operations (workflows)
 */

import type { JobAuthorizationSnapshot } from "./types.js";

export interface JobSnapshotRepository {
  get(jobId: string): Promise<JobAuthorizationSnapshot | null>;
  put(snapshot: JobAuthorizationSnapshot): Promise<void>;
  delete(jobId: string): Promise<void>;
}

/**
 * D1-based job snapshot repository
 */
export class D1JobSnapshotRepository implements JobSnapshotRepository {
  constructor(private readonly db: D1Database) {}

  async get(jobId: string): Promise<JobAuthorizationSnapshot | null> {
    const result = await this.db
      .prepare(
        `
        SELECT * FROM job_authorization_snapshots
        WHERE job_id = ?
      `
      )
      .bind(jobId)
      .first<{
        job_id: string;
        created_by_user_id: string;
        workspace_id: string;
        allowed_operations: string;
        created_at: number;
        expires_at: number;
        authorization_version: number;
      }>();

    if (!result) return null;

    return {
      jobId: result.job_id,
      createdByUserId: result.created_by_user_id,
      workspaceId: result.workspace_id,
      allowedOperations: JSON.parse(result.allowed_operations) as string[],
      createdAt: result.created_at,
      expiresAt: result.expires_at,
      authorizationVersion: result.authorization_version,
    };
  }

  async put(snapshot: JobAuthorizationSnapshot): Promise<void> {
    await this.db
      .prepare(
        `
        INSERT INTO job_authorization_snapshots
          (job_id, created_by_user_id, workspace_id, allowed_operations, created_at, expires_at, authorization_version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          created_by_user_id = excluded.created_by_user_id,
          workspace_id = excluded.workspace_id,
          allowed_operations = excluded.allowed_operations,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at,
          authorization_version = excluded.authorization_version
      `
      )
      .bind(
        snapshot.jobId,
        snapshot.createdByUserId,
        snapshot.workspaceId,
        JSON.stringify(snapshot.allowedOperations),
        snapshot.createdAt,
        snapshot.expiresAt,
        snapshot.authorizationVersion
      )
      .run();
  }

  async delete(jobId: string): Promise<void> {
    await this.db
      .prepare(
        `
        DELETE FROM job_authorization_snapshots
        WHERE job_id = ?
      `
      )
      .bind(jobId)
      .run();
  }
}

/**
 * Create or get the job snapshot repository
 */
export function getJobSnapshotRepository(db: D1Database): JobSnapshotRepository {
  return new D1JobSnapshotRepository(db);
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
