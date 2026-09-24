import type { Credentials, CredentialStore } from "./credentials/store.js";
import type { AuthTracer } from "./tracing.js";

export interface AuthTarget {
  cdpUrl: string;
  cdpHeaders?: Record<string, string>;
  url: string;
  /** Optional standard CDP TargetID for precise existing-tab selection. */
  targetId?: string;
}

export type ModelConfig = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
} & (
  | { provider: "openai"; api?: "responses" | "chat" }
  | { provider: "anthropic" }
  | {
      provider: "openai-compatible";
      baseURL: string;
      name?: string;
      queryParams?: Record<string, string>;
      supportsStructuredOutputs?: boolean;
    }
  | {
      provider: "gateway";
      providerOptions?: {
        gateway: {
          /** Preferred upstream provider order. */
          order?: string[];
          /** Restrict routing to these providers. */
          only?: string[];
          /** Fallback model IDs, tried after the primary model. */
          models?: string[];
        };
      };
    }
);

export interface AuthOptions {
  model: ModelConfig;
  store?: CredentialStore;
  limits?: { maxSteps?: number; timeoutMs?: number; actionTimeoutMs?: number };
  /** Opt-in only. Spans contain fixed operation names and counters, never payloads. */
  tracer?: AuthTracer;
}

export type LoginOptions = AuthTarget & {
  credentials?: Credentials;
  accountId?: string;
  label?: string;
  save?: "yes" | "ask" | "never";
  signal?: AbortSignal;
};
export type SwitchOptions = AuthTarget & {
  accountId: string;
  signal?: AbortSignal;
};
export type LogoutOptions = AuthTarget & { signal?: AbortSignal } & (
    | { forgetCredentials: true; accountId: string }
    | { forgetCredentials?: false; accountId?: string }
  );
