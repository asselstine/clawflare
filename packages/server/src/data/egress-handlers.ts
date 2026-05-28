/**
 * Egress Handler Data Types
 * 
 * Domain types for egress handler management.
 */

/**
 * Egress handler metadata - workspace scoped
 */
export interface EgressHandlerMetadata {
  workspaceId: string;
  name: string;
  description: string;
  domains: string[];
  enabled: boolean;
  config: unknown;
  updatedAt: number;
}

/**
 * Parameters for upserting egress handler
 */
export interface UpsertEgressHandlerParams {
  workspaceId: string;
  name: string;
  description: string;
  domains: string[];
  enabled?: boolean;
  config?: unknown;
}

/**
 * Egress handler repository - manages egress handler metadata, workspace scoped
 */
export interface EgressHandlerRepository {
  /** Upsert an egress handler in a workspace */
  upsert(params: UpsertEgressHandlerParams): Promise<void>;

  /** Get handler by name within a workspace */
  get(workspaceId: string, name: string): Promise<EgressHandlerMetadata | null>;

  /** List egress handlers in a workspace */
  list(workspaceId: string, enabledOnly?: boolean): Promise<EgressHandlerMetadata[]>;

  /** Search egress handlers within a workspace */
  search(workspaceId: string, query: string, limit: number): Promise<EgressHandlerMetadata[]>;
}
