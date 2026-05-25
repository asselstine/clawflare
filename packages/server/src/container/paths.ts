/**
 * Path validation and normalization utilities for container file operations
 */

import { resolve, normalize, relative, sep } from "path";

const WORKSPACE_ROOT = "/workspace";

/**
 * Normalize and validate that a path is within the workspace boundary
 * after realpath resolution.
 */
export function normalizeWorkspacePath(requestPath: string): {
  normalized: string;
  relativePath: string;
  isWithinWorkspace: boolean;
} {
  // Handle empty path
  if (!requestPath || requestPath === "." || requestPath === "./") {
    return {
      normalized: WORKSPACE_ROOT,
      relativePath: ".",
      isWithinWorkspace: true,
    };
  }
  
  // Resolve relative to workspace
  const resolved = resolve(WORKSPACE_ROOT, requestPath);
  const normalizedPath = normalize(resolved);
  
  // Get relative path from workspace
  const relPath = relative(WORKSPACE_ROOT, normalizedPath);
  const isWithinWorkspace = !relPath.startsWith("..") && 
                           !relPath.startsWith(sep) && 
                           normalizedPath.startsWith(WORKSPACE_ROOT);
  
  return {
    normalized: normalizedPath,
    relativePath: relPath || ".",
    isWithinWorkspace,
  };
}

/**
 * Validate that a path does not escape the workspace.
 * Throws if path escapes workspace.
 */
export function validateWorkspacePath(requestPath: string): string {
  const { normalized, isWithinWorkspace } = normalizeWorkspacePath(requestPath);
  
  if (!isWithinWorkspace) {
    throw new Error(`Path "${requestPath}" escapes the workspace boundary`);
  }
  
  return normalized;
}

/**
 * Sanitize a path component for safe use in shell commands.
 * This is a basic sanitizer - prefer to avoid shell when possible.
 */
export function sanitizeShellPath(requestPath: string): string {
  // Remove control characters
  return requestPath.replace(/[\x00-\x1F\x7F]/g, "");
}

/**
 * Enforce max path length
 */
export function enforcePathLength(requestPath: string, maxLength = 4096): string {
  if (requestPath.length > maxLength) {
    throw new Error(`Path exceeds maximum length of ${maxLength} characters`);
  }
  return requestPath;
}
