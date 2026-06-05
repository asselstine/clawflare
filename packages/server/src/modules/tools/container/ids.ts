/**
 * Container ID validation and generation utilities
 */

// Conservative container ID pattern
const VALID_CONTAINER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

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

export function generateContainerId(): string {
  return crypto.randomUUID();
}

export function requireContainerId(explicitId?: string): string {
  if (!explicitId) {
    throw new Error("containerId is required. Create a container first with container_create, then pass its containerId to container tools.");
  }
  validateContainerId(explicitId);
  return explicitId;
}
