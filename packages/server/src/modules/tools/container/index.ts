/**
 * Container module - coding container filesystem and command tools
 */

export { CodingContainer } from "./coding-container.js";
export {
  containerBash,
  containerRead,
  containerWrite,
  containerEdit,
  containerGrep,
  containerFind,
  containerLs,
  getContainerHealth,
  destroyContainer,
  callContainerRuntime,
} from "./client.js";
export { createContainerTools } from "./tools.js";
export { generateContainerId, requireContainerId, validateContainerId, sanitizeContainerId } from "./ids.js";
export { normalizeWorkspacePath, validateWorkspacePath } from "./paths.js";
export { tailToolOutput, getEffectiveOutputLimit, formatContainerResult, formatContainerError } from "./output.js";
export type {
  BashResult,
  ReadResult,
  WriteResult,
  EditResult,
  GrepResult,
  FindResult,
  LsResult,
  HealthResult,
  ContainerRuntimeResponse,
} from "./client.js";
export type { ContainerToolContext } from "./tools.js";
