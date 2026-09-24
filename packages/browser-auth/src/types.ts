import type { LanguageModel } from "ai";
import type { Page } from "playwright-core";
import type { Tracer } from "@opentelemetry/api";
import type { AuthAgent } from "./agent/proposals.js";
import type { Credentials, CredentialStore } from "./credentials/store.js";

export type AuthTarget =
  | { page: Page; cdpUrl?: never; cdpHeaders?: never; url?: never }
  | {
      cdpUrl: string;
      cdpHeaders?: Record<string, string>;
      url: string;
      page?: never;
    };

export type AuthOptions = (
  { model: LanguageModel; agent?: never } | { agent: AuthAgent; model?: never }
) & {
  store?: CredentialStore;
  limits?: { maxSteps?: number; timeoutMs?: number; actionTimeoutMs?: number };
  /** Opt-in only. Spans contain fixed operation names and counters, never payloads. */
  tracer?: Tracer;
};

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
