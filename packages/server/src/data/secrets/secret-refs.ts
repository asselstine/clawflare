/**
 * Secret Reference Helpers
 * 
 * Utilities for creating and parsing secret references used in model connections.
 */

/**
 * Create the storage key/reference for a model connection secret
 * This becomes both the "ref" and the actual key in storage
 */
export function createModelConnectionSecretRef(
  workspaceId: string,
  connectionId: string,
  key: string
): string {
  return `workspaces_${workspaceId}_mc_${connectionId}_${key}`;
}

/**
 * Parse a secret ref to extract workspace and connection info
 * Returns null if the ref format is unrecognized
 */
export function parseModelConnectionSecretRef(
  ref: string
): { workspaceId: string; connectionId: string; key: string } | null {
  const match = ref.match(/^workspaces_(.+)_mc_(.+)_(.+)$/);
  if (!match) return null;
  
  const [, workspaceId, connectionId, key] = match;
  if (!workspaceId || !connectionId || !key) return null;
  
  return { workspaceId, connectionId, key };
}
