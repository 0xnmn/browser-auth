import type { AuthTranscriptEvent } from "../transcript.js";
import { Redactor } from "../security/redaction.js";

type WithoutEnvelope<T> = T extends unknown
  ? Omit<T, "sequence" | "timestamp">
  : never;
export type TranscriptRecord = WithoutEnvelope<
  Exclude<AuthTranscriptEvent, { type: "gap" }>
>;

// Traverse data, never replace substrings in serialized event JSON. Protocol
// enums aren't reflected content; retain them even when a credential is "click".
function redact<T>(
  value: T,
  redactor: Redactor,
  mode: "data" | "schema" | "protocol" = "data",
): T {
  if (typeof value === "string") {
    const filtered = redactor.text(value);
    // A partial raw match could coexist with JSON-escaped credentials. Drop
    // the entire content leaf rather than returning incompletely filtered JSON.
    if (filtered !== value) return "[redacted]" as T;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object")
        return JSON.stringify(redact(parsed, redactor)) as T;
    } catch {
      /* Bounded trees and ordinary text need not be valid JSON. */
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => redact(item, redactor, mode)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        mode === "data" ? redact(key, redactor) : key,
        mode === "protocol" &&
        ["kind", "type", "status", "intent", "outcome", "reason"].includes(key)
          ? item
          : redact(item, redactor, mode),
      ]),
    ) as T;
  return value;
}

function sanitize(
  event: TranscriptRecord,
  redactor: Redactor,
): TranscriptRecord {
  switch (event.type) {
    case "observation": {
      const { screenshot, ...input } = event.observation;
      return {
        ...event,
        observation: {
          ...redact(input, redactor, "schema"),
          operation: input.operation,
          ...(screenshot && !redactor.hasValues ? { screenshot } : {}),
        },
      };
    }
    case "proposal": {
      const proposal = redact(event.proposal, redactor, "protocol");
      if (proposal.kind === "press" && event.proposal.kind === "press")
        proposal.key = event.proposal.key;
      return { ...event, proposal };
    }
    case "interaction":
      return {
        ...event,
        interaction: redact(event.interaction, redactor, "protocol"),
      };
    case "response":
      return {
        ...event,
        response: redact(event.response, redactor, "protocol"),
      };
    case "result": {
      const result = redact(event.result, redactor, "protocol");
      if ("deletion" in result && "deletion" in event.result)
        result.deletion = event.result.deletion;
      return { ...event, result };
    }
    case "execution":
      return {
        ...event,
        ...(event.reason ? { reason: redactor.text(event.reason) } : {}),
        ...(event.result !== undefined
          ? { result: redact(event.result, redactor) }
          : {}),
      };
    case "error":
      return { ...event, code: redactor.text(event.code) };
    case "start":
      return event;
  }
}

/** Separate ordered stream: never coalesces, blocks authentication, or retains history. */
export class TranscriptChannel {
  readonly redactor = new Redactor();
  private sequence = 0;
  private finished = false;
  private readonly listeners = new Set<
    (event?: AuthTranscriptEvent, bytes?: number) => void
  >();

  emit(record: TranscriptRecord): void {
    if (this.finished) return;
    const sequence = ++this.sequence;
    if (!this.listeners.size) return;
    let event: AuthTranscriptEvent;
    let bytes: number;
    try {
      event = structuredClone({
        ...sanitize(record, this.redactor),
        sequence,
        timestamp: Date.now(),
      });
      bytes = Buffer.byteLength(JSON.stringify(event));
    } catch {
      // Diagnostics must not throw into the controller or publish unsafe input.
      event = {
        type: "gap",
        sequence,
        timestamp: Date.now(),
        fromSequence: sequence,
        toSequence: sequence,
        reason: "recording_failed",
      };
      bytes = Buffer.byteLength(JSON.stringify(event));
    }
    for (const listener of this.listeners)
      listener(structuredClone(event), bytes);
  }

  close(): void {
    this.finished = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
    this.redactor.clear();
  }

  subscribe(): AsyncIterableIterator<AuthTranscriptEvent> {
    const queue: Array<{ event: AuthTranscriptEvent; bytes: number }> = [];
    const waiting: Array<(value: IteratorResult<AuthTranscriptEvent>) => void> =
      [];
    let bytes = 0;
    let ended = this.finished;
    let gap: Extract<AuthTranscriptEvent, { type: "gap" }> | undefined;
    const take = (): IteratorResult<AuthTranscriptEvent> | undefined => {
      if (gap) {
        const value = gap;
        gap = undefined;
        return { done: false, value };
      }
      const entry = queue.shift();
      if (entry) {
        bytes -= entry.bytes;
        return { done: false, value: entry.event };
      }
      if (ended) return { done: true, value: undefined };
    };
    const flush = () => {
      while (waiting.length) {
        const value = take();
        if (!value) break;
        waiting.shift()!(value);
      }
    };
    const listener = (event?: AuthTranscriptEvent, size = 0) => {
      if (!event) ended = true;
      else {
        queue.push({ event, bytes: size });
        bytes += size;
        // Both event count and serialized byte size are bounded per subscriber.
        while (queue.length > 64 || bytes > 8 * 1024 * 1024) {
          const dropped = queue.shift()!;
          bytes -= dropped.bytes;
          gap = {
            type: "gap",
            reason: "overflow",
            sequence: dropped.event.sequence,
            timestamp: Date.now(),
            fromSequence: gap?.fromSequence ?? dropped.event.sequence,
            toSequence: dropped.event.sequence,
          };
        }
      }
      flush();
    };
    // Subscribe on the call, not lazily on the first next().
    if (!ended) this.listeners.add(listener);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        const value = take();
        return value
          ? Promise.resolve(value)
          : new Promise((resolve) => waiting.push(resolve));
      },
      return: async () => {
        this.listeners.delete(listener);
        ended = true;
        queue.length = 0;
        gap = undefined;
        bytes = 0;
        flush();
        return { done: true, value: undefined };
      },
    };
  }
}
