import type {
  BrowserAction,
  BrowserObservation,
} from "../browser/observation.js";

export interface ProposedChoice {
  elementId: string;
  label: string;
  intent: "continue" | "back" | "switch" | "add" | "logout" | "finish";
}

/** Private field bindings are executed by the controller, never by model code. */
export interface CredentialPlan {
  kind: "ask_user";
  message: string;
  fields: Array<{
    elementId: string;
    key: string;
    label: string;
    type: "text" | "email" | "phone" | "password" | "code";
    rejected: boolean;
  }>;
  choices: ProposedChoice[];
  submitElementId: string | null;
  external: boolean;
}

export type AuthProposal =
  | BrowserAction
  | CredentialPlan
  | { kind: "observe" }
  | { kind: "screenshot" }
  | { kind: "opener" }
  | { kind: "tabs_list" }
  | { kind: "tab_switch"; pageId: string }
  | { kind: "tab_new" }
  | { kind: "tab_close"; pageId: string }
  | { kind: "frames_list" }
  | {
      kind: "done";
      outcome:
        | "authenticated"
        | "signed-out"
        | "account-changed"
        | "unsupported"
        | "not-signed-in"
        | "rejected";
    };

export interface AuthObservation extends Omit<BrowserObservation, "tree"> {
  tree?: string;
  operation: "login" | "logout" | "choose-account";
  history?: string[];
  opener?: { origin: string; text: string };
  context?: string;
  availableCredentialKeys: string[];
}

/** Internal reasoning boundary. No browser handles or private values. */
export interface AuthAgent {
  next(
    observation: AuthObservation,
    options: { signal: AbortSignal },
  ): Promise<AuthProposal>;
}
