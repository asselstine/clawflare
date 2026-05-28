/**
 * Secret Store Data Layer
 * 
 * Application-facing secret storage interface.
 */

export type { AuthSession, SecretStore } from "./secret-store.js";
export {
  createSecretStore,
  getSecretStore,
} from "./secret-store.js";

export {
  createModelConnectionSecretRef,
  parseModelConnectionSecretRef,
} from "./secret-refs.js";

// Re-export types from secret-broker for convenience
export type { AuthorizationContext } from "../../secret-broker/types.js";
