/**
 * Container ID validation and generation utilities
 */

// Conservative container ID pattern
const VALID_CONTAINER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// Default container ID for a session
export function getDefaultContainerId(sessionId: string): string {
  // Sanitize session ID to be a valid container ID
  const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `session-${sanitized}`;
}

// Validate container ID format
export function validateContainerId(id: string): void {
  if (!id || typeof id !== "string") {
    throw new Error("Container ID is required and must be a string");
  }
  if (!VALID_CONTAINER_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid container ID "${id}". IDs must match pattern: ${VALID_CONTAINER_ID_PATTERN.source}`
    );
  }
}

// Sanitize ID - replace invalid characters with underscore and truncate
export function sanitizeContainerId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

// Generate or derive container ID from session
export function deriveContainerId(sessionId: string, explicitId?: string): string {
  if (explicitId) {
    validateContainerId(explicitId);
    return explicitId;
  }
  return getDefaultContainerId(sessionId);
}
