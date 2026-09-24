import {
  authResultSchema,
  interactionSchema,
  responseSchema,
  snapshotSchema,
} from "./flow/protocol-schema.js";

export interface AuthError {
  code: string;
  message: string;
}
export type SaveOutcome =
  | { status: "saved" }
  | { status: "not-saved" }
  | { status: "failed"; error: AuthError };
export type AuthResult =
  | { status: "already-signed-in" }
  | {
      status: "authenticated";
      accountId?: string | undefined;
      save: SaveOutcome;
    }
  | {
      status: "signed-out";
      deletion: "not-requested" | "deleted" | "failed";
      error?: AuthError | undefined;
    }
  | {
      status: "unknown";
      message: string;
      deletion?: "deleted" | "failed" | undefined;
    }
  | { status: "cancelled" }
  | {
      status: "failed";
      error: AuthError;
      deletion?: "deleted" | "failed" | undefined;
    };

export interface AuthChoice {
  id: string;
  label: string;
  kind?: "back" | "finish" | "logout" | "switch" | "add" | undefined;
}
export interface AuthField {
  id: string;
  label: string;
  type: "text" | "email" | "phone" | "password" | "code";
  required: boolean;
}
export type AuthConfirmation =
  { kind: "use-credentials"; origin: string } | { kind: "save-credentials" };
export interface AuthInteraction {
  id: string;
  message: string;
  fields: AuthField[];
  choices: AuthChoice[];
  confirmation?: AuthConfirmation | undefined;
  pollAfterMs?: number | undefined;
}
export type AuthResponse =
  | { kind: "submit"; interactionId: string; values: Record<string, string> }
  | { kind: "choose"; interactionId: string; choiceId: string };
export type AuthSnapshot =
  | { status: "running"; message: string }
  | { status: "waiting"; interaction: AuthInteraction }
  | { status: "done"; result: AuthResult };

export interface AuthFlow {
  updates(): AsyncIterable<AuthSnapshot>;
  respond(response: AuthResponse): Promise<void>;
  readonly result: Promise<AuthResult>;
}

/** Parsers throw fixed Error messages, never validator errors containing input data. */
export function parseResponse(value: unknown): AuthResponse {
  const result = responseSchema.safeParse(value);
  if (!result.success) throw new Error("invalid_response");
  return result.data;
}
export function parseInteraction(value: unknown): AuthInteraction {
  const result = interactionSchema.safeParse(value);
  if (!result.success) throw new Error("invalid_interaction");
  return result.data;
}
export function parseSnapshot(value: unknown): AuthSnapshot {
  const result = snapshotSchema.safeParse(value);
  if (!result.success) throw new Error("invalid_snapshot");
  return result.data;
}
export function parseResult(value: unknown): AuthResult {
  const result = authResultSchema.safeParse(value);
  if (!result.success) throw new Error("invalid_result");
  return result.data;
}
