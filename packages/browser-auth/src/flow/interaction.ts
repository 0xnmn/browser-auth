import { randomUUID } from "node:crypto";
import { parseInteraction, parseResponse } from "../protocol.js";
import { TranscriptChannel } from "./transcript.js";
import type {
  AuthFlow,
  AuthInteraction,
  AuthResponse,
  AuthResult,
  AuthSnapshot,
} from "../protocol.js";

type InteractionInput = Omit<AuthInteraction, "id" | "pollAfterMs">;

/** One pending interaction; each subscriber owns a bounded snapshot queue. */
export class FlowChannel implements AuthFlow {
  readonly result: Promise<AuthResult>;
  readonly diagnostics = new TranscriptChannel();
  private finishResult!: (result: AuthResult) => void;
  private snapshot: AuthSnapshot = {
    status: "running",
    message: "Starting authentication",
  };
  private readonly listeners = new Set<(snapshot: AuthSnapshot) => void>();
  private pending:
    | {
        interaction: AuthInteraction;
        resolve: (response: AuthResponse | null) => void;
        cleanup: () => void;
      }
    | undefined;

  constructor() {
    this.result = new Promise((resolve) => {
      this.finishResult = resolve;
    });
  }

  publish(snapshot: AuthSnapshot): void {
    if (this.snapshot.status === "done") return;
    this.snapshot = structuredClone(snapshot);
    for (const listener of this.listeners) listener(structuredClone(snapshot));
  }

  finish(result: AuthResult): void {
    if (this.snapshot.status === "done") return;
    if (this.pending)
      this.diagnostics.emit({
        type: "response",
        response: {
          kind: "expired",
          interactionId: this.pending.interaction.id,
          reason: "finished",
        },
      });
    this.pending?.resolve(null);
    this.pending?.cleanup();
    this.pending = undefined;
    this.diagnostics.emit({ type: "result", result });
    this.diagnostics.close();
    this.publish({ status: "done", result });
    this.finishResult(result);
  }

  transcript() {
    return this.diagnostics.subscribe();
  }

  async *updates(): AsyncIterable<AuthSnapshot> {
    let latest: AuthSnapshot | undefined = structuredClone(this.snapshot);
    let wake: (() => void) | undefined;
    const listener = (snapshot: AuthSnapshot) => {
      latest = snapshot;
      wake?.();
    };
    this.listeners.add(listener);
    try {
      while (true) {
        if (!latest)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        const snapshot = latest!;
        latest = undefined;
        wake = undefined;
        yield snapshot;
        if (snapshot.status === "done") return;
      }
    } finally {
      this.listeners.delete(listener);
    }
  }

  async ask(
    input: InteractionInput,
    signal: AbortSignal,
    pollMs?: number,
  ): Promise<AuthResponse | null> {
    signal.throwIfAborted();
    if (this.snapshot.status === "done") throw new Error("flow_completed");
    if (this.pending) throw new Error("An interaction is already pending");
    const interaction = parseInteraction({
      ...input,
      id: randomUUID(),
      ...(pollMs !== undefined ? { pollAfterMs: pollMs } : {}),
    });
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        if (timer) clearTimeout(timer);
      };
      const abort = () => {
        if (this.pending?.interaction.id !== interaction.id) return;
        this.pending = undefined;
        cleanup();
        this.diagnostics.emit({
          type: "response",
          response: {
            kind: "expired",
            interactionId: interaction.id,
            reason: signal.aborted ? "cancelled" : "poll",
          },
        });
        this.publish({
          status: "running",
          message: "Refreshing authentication state",
        });
        resolve(null);
      };
      this.pending = { interaction, resolve, cleanup };
      signal.addEventListener("abort", abort, { once: true });
      if (pollMs) timer = setTimeout(abort, pollMs);
      this.diagnostics.emit({ type: "interaction", interaction });
      this.publish({ status: "waiting", interaction });
    });
  }

  async respond(input: AuthResponse): Promise<void> {
    try {
      const response = parseResponse(input);
      const pending = this.pending;
      if (!pending || pending.interaction.id !== response.interactionId)
        throw new Error("stale_interaction");
      const interaction = pending.interaction;
      if (response.kind === "choose") {
        if (
          !interaction.choices.some((choice) => choice.id === response.choiceId)
        )
          throw new Error("invalid_choice");
      } else {
        if (interaction.fields.length === 0) throw new Error("invalid_fields");
        const ids = new Set(interaction.fields.map((field) => field.id));
        if (Object.keys(response.values).some((id) => !ids.has(id)))
          throw new Error("invalid_fields");
        if (
          interaction.fields.some(
            (field) => field.required && !response.values[field.id],
          )
        )
          throw new Error("missing_field");
      }
      // Consume synchronously, before the controller performs any asynchronous write.
      this.pending = undefined;
      pending.cleanup();
      if (response.kind === "submit")
        for (const value of Object.values(response.values))
          this.diagnostics.redactor.add(value);
      this.diagnostics.emit({
        type: "response",
        response:
          response.kind === "choose"
            ? response
            : {
                kind: "submit",
                interactionId: response.interactionId,
                fieldIds: Object.keys(response.values),
              },
      });
      this.publish({ status: "running", message: "Processing response" });
      pending.resolve(response);
    } catch (error) {
      this.diagnostics.emit({
        type: "response",
        response: {
          kind: "rejected",
          code:
            error instanceof Error &&
            [
              "stale_interaction",
              "invalid_choice",
              "invalid_fields",
              "missing_field",
            ].includes(error.message)
              ? error.message
              : "invalid_response",
        },
      });
      throw error;
    }
  }
}
