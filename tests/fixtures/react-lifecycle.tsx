import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AuthSnapshot } from "@browser-auth/core/protocol";
import {
  useAuthFlow,
  type AuthTransport,
} from "../../packages/react/src/useAuthFlow.js";

type Read =
  { kind: "value"; value: AuthSnapshot } | { kind: "eof" } | { kind: "error" };

class ControlledTransport implements AuthTransport {
  returns = 0;
  private reads: Array<(read: Read) => void> = [];

  constructor(private failure?: "updates" | "iterator") {}

  updates(): AsyncIterable<AuthSnapshot> {
    if (this.failure === "updates")
      throw new Error("synthetic updates failure");
    const transport = this;
    return {
      [Symbol.asyncIterator]() {
        if (transport.failure === "iterator")
          throw new Error("synthetic iterator failure");
        return {
          next: () =>
            new Promise<IteratorResult<AuthSnapshot>>((resolve, reject) => {
              transport.reads.push((read) => {
                if (read.kind === "error")
                  reject(new Error("synthetic read failure"));
                else if (read.kind === "eof")
                  resolve({ done: true, value: undefined });
                else resolve({ done: false, value: read.value });
              });
            }),
          return: async () => {
            transport.returns++;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
  }

  respond = async () => {};

  send(read: Read) {
    const resolve = this.reads.shift();
    if (!resolve) throw new Error("No pending iterator read");
    resolve(read);
  }

  get pendingReads() {
    return this.reads.length;
  }
}

function Harness({ transport }: { transport: ControlledTransport }) {
  const { snapshot } = useAuthFlow(transport);
  return createElement(
    "output",
    { "data-testid": "snapshot" },
    snapshot ? JSON.stringify(snapshot) : "empty",
  );
}

let root: Root | undefined;
let current: ControlledTransport | undefined;

const render = (transport: ControlledTransport) => {
  root ??= createRoot(document.querySelector("#root")!);
  root.render(createElement(Harness, { transport }));
  current = transport;
};

Object.assign(window, {
  lifecycle: {
    mount(failure?: "updates" | "iterator") {
      render(new ControlledTransport(failure));
    },
    replace() {
      const previous = current!;
      render(new ControlledTransport());
      return previous;
    },
    unmount() {
      root?.unmount();
      root = undefined;
    },
    emit(snapshot: AuthSnapshot) {
      current!.send({ kind: "value", value: snapshot });
    },
    eof() {
      current!.send({ kind: "eof" });
    },
    error() {
      current!.send({ kind: "error" });
    },
    currentReturns() {
      return current!.returns;
    },
    pendingReads() {
      return current!.pendingReads;
    },
  },
});
