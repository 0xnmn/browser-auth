import type { AuthObservation, AuthProposal } from "./agent/proposals.js";
import type { AuthInteraction, AuthResult } from "./protocol.js";

/** Package-owned data only; no browser handles, provider messages, or reasoning. */
export type AuthTranscriptObservation = AuthObservation;
export type AuthTranscriptProposal = AuthProposal;
export type AuthTranscriptValue =
  | null
  | boolean
  | number
  | string
  | AuthTranscriptValue[]
  | { [key: string]: AuthTranscriptValue };
export type AuthTranscriptResponse =
  | { kind: "submit"; interactionId: string; fieldIds: string[] }
  | { kind: "choose"; interactionId: string; choiceId: string }
  | { kind: "rejected"; code: string }
  | {
      kind: "expired";
      interactionId: string;
      reason: "poll" | "cancelled" | "finished";
    };
export type AuthTranscriptPhase =
  | "browser_connect"
  | "browser_observe"
  | "agent"
  | "controller"
  | "browser_action"
  | "store_load"
  | "store_save"
  | "store_delete";
export type AuthTranscriptFailure = {
  phase: AuthTranscriptPhase;
  reason: "deadline" | "caller_cancelled" | "action_timeout" | "failure";
  code: string;
  writeAttempted: boolean;
  actionWriteAttempted: boolean;
};

/** Diagnostic website/account content. Known credentials are excluded, not historical content. */
export type AuthTranscriptEvent = {
  /** Monotonic within a flow. Gap sequence is the last discarded sequence. */
  sequence: number;
  /** Unix epoch milliseconds. */
  timestamp: number;
} & (
  | { type: "start" }
  | {
      type: "observation";
      step: number;
      observation: AuthTranscriptObservation;
    }
  | { type: "proposal"; step: number; proposal: AuthTranscriptProposal }
  | {
      type: "execution";
      step: number;
      tool: AuthTranscriptProposal["kind"];
      status: "completed" | "rejected" | "failed";
      reason?: string;
      writeAttempted: boolean;
      result?: AuthTranscriptValue;
    }
  | { type: "interaction"; interaction: AuthInteraction }
  | { type: "response"; response: AuthTranscriptResponse }
  | ({ type: "error" } & AuthTranscriptFailure)
  | { type: "result"; result: AuthResult }
  | {
      type: "gap";
      fromSequence: number;
      toSequence: number;
      reason: "overflow" | "recording_failed";
    }
);
