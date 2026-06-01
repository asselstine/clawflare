/**
 * Job Snapshot Types and Factory
 * 
 * Domain types for job authorization snapshots used in async operations.
 */

import type { JobAuthorizationSnapshot } from "../modules/secrets/secrets.types.js";

export type { JobAuthorizationSnapshot } from "../modules/secrets/secrets.types.js";

/**
 * Create a job snapshot for the current time
 */
export function createJobSnapshot(
  jobId: string,
  userId: string,
  workspaceId: string,
  allowedOperations: string[],
  expiryMs: number = 60 * 60 * 1000
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

/**
 * Job Snapshot Repository
 * 
 * Drizzle-backed implementation of job authorization snapshot storage.
 */

import { createDb, type Db } from "./db.js";
import { jobAuthorizationSnapshots } from "./schema.js";
import { eq } from "drizzle-orm";

/**
 * Job snapshot repository
 */
export class JobSnapshotRepository {
  private readonly db: Db;

  constructor(db: Db | D1Database) {
    this.db = "query" in db ? db : createDb(db);
  }

  async get(jobId: string): Promise<JobAuthorizationSnapshot | null> {
    const result = await this.db.query.jobAuthorizationSnapshots.findFirst({
      where: eq(jobAuthorizationSnapshots.jobId, jobId),
    });

    if (!result) return null;

    return {
      jobId: result.jobId,
      createdByUserId: result.createdByUserId,
      workspaceId: result.workspaceId,
      allowedOperations: JSON.parse(result.allowedOperations) as string[],
      createdAt: result.createdAt,
      expiresAt: result.expiresAt,
      authorizationVersion: result.authorizationVersion,
    };
  }

  async put(snapshot: JobAuthorizationSnapshot): Promise<void> {
    const allowedOperations = JSON.stringify(snapshot.allowedOperations);
    await this.db
      .insert(jobAuthorizationSnapshots)
      .values({
        jobId: snapshot.jobId,
        createdByUserId: snapshot.createdByUserId,
        workspaceId: snapshot.workspaceId,
        allowedOperations,
        createdAt: snapshot.createdAt,
        expiresAt: snapshot.expiresAt,
        authorizationVersion: snapshot.authorizationVersion,
      })
      .onConflictDoUpdate({
        target: jobAuthorizationSnapshots.jobId,
        set: {
          createdByUserId: snapshot.createdByUserId,
          workspaceId: snapshot.workspaceId,
          allowedOperations,
          createdAt: snapshot.createdAt,
          expiresAt: snapshot.expiresAt,
          authorizationVersion: snapshot.authorizationVersion,
        },
      });
  }

  async delete(jobId: string): Promise<void> {
    await this.db
      .delete(jobAuthorizationSnapshots)
      .where(eq(jobAuthorizationSnapshots.jobId, jobId));
  }
}
