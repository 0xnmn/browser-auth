export interface ProposedChoice {
  elementId: string;
  label: string;
  back: boolean;
}
export type AuthProposal =
  | {
      kind: "session";
      choices: Array<{
        elementId: string;
        label: string;
        kind: "logout" | "switch" | "add" | "accounts";
      }>;
    }
  | { kind: "click"; elementId: string }
  | {
      kind: "form";
      fields: Array<{
        elementId: string;
        key: string;
        label: string;
        type: "text" | "email" | "phone" | "password" | "code";
        rejected: boolean;
      }>;
      choices: ProposedChoice[];
      submitElementId: string | null;
    }
  | { kind: "external"; message: string; choices: ProposedChoice[] }
  | {
      kind: "done";
      outcome:
        | "authenticated"
        | "signed-out"
        | "account-changed"
        | "unsupported"
        | "not-signed-in"
        | "rejected";
    }
  | { kind: "opener" }
  | { kind: "wait" };
export type FormProposal = Extract<AuthProposal, { kind: "form" }>;

export interface ObservedElement {
  id: string;
  origin: string;
  tag: string;
  type: string;
  label: string;
  autocomplete: string;
}

export interface AuthObservation {
  operation: "login" | "logout" | "choose-account";
  /** Completed actions, never credential values. */
  history?: string[];
  /** Read-only service-page evidence while observing a popup. */
  opener?: { origin: string; text: string };
  origin: string;
  text: string;
  elements: ObservedElement[];
  availableCredentialKeys: string[];
}

/** Internal reasoning boundary. Proposals are validated before execution. */
export interface AuthAgent {
  next(
    observation: AuthObservation,
    options: { signal: AbortSignal },
  ): Promise<AuthProposal>;
}
