/**
 * Snapshot Data Types
 * 
 * Domain types for agent snapshot management.
 */

/**
 * Session runtime repository - manages workflow state and active flags
 */
export interface SessionRuntimeRepository {
  /** Get workflow ID for a session */
  getWorkflowId(sessionId: string): Promise<string | null>;

  /** Save workflow ID for a session */
  saveWorkflowId(sessionId: string, workflowId: string): Promise<void>;

  /** Check if session is currently active */
  isActive(sessionId: string): Promise<boolean>;

  /** Set session active status */
  setActive(sessionId: string, active: boolean): Promise<void>;

  /** Get workflow session snapshot */
  getWorkflowSession(sessionId: string): Promise<unknown | null>;

  /** Save workflow session snapshot */
  saveWorkflowSession(sessionId: string, session: unknown): Promise<void>;

  /** Get agent snapshot */
  getSnapshot(sessionId: string): Promise<unknown | null>;

  /** Save agent snapshot */
  saveSnapshot(sessionId: string, snapshot: unknown): Promise<void>;
}

/**
 * Snapshot repository - manages agent snapshots
 */
export interface SnapshotRepository {
  /** Save a snapshot */
  save(sessionId: string, snapshot: unknown): Promise<void>;

  /** Get a snapshot */
  get(sessionId: string): Promise<unknown | null>;

  /** Delete a snapshot */
  delete(sessionId: string): Promise<void>;
}
