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

// Re-export types from the secrets module for convenience
export type { AuthorizationContext } from "../../modules/secrets/secrets.types.js";
