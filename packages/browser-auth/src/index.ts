export { createAuth } from "./auth.js";
export type { AuthClient } from "./auth.js";
export { InMemoryStore } from "./credentials/memory-store.js";
export type {
  CredentialStore,
  Credentials,
  SavedLogin,
  SavedLoginSummary,
  StoreQuery,
} from "./credentials/store.js";
export type { AuthTracer, AuthTrace, OtlpOptions } from "./tracing.js";
export type {
  AuthOptions,
  AuthTarget,
  ModelConfig,
  LoginOptions,
  LogoutOptions,
  SwitchOptions,
} from "./types.js";
export type {
  AuthFlow,
  AuthSnapshot,
  AuthInteraction,
  AuthResponse,
  AuthResult,
  AuthError,
} from "./protocol.js";
