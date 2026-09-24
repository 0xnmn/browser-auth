import { createModelAgent } from "./agent/ai-sdk-agent.js";
import { InMemoryStore } from "./credentials/memory-store.js";
import { FlowChannel } from "./flow/interaction.js";
import { runFlow } from "./flow/controller.js";
import type { AuthFlow } from "./protocol.js";
import type { AuthOptions, LoginOptions } from "./types.js";
import type { StoreQuery } from "./credentials/store.js";
import { validateOperationOptions } from "./options.js";
import type { AuthAgent } from "./agent/proposals.js";

export function createAuth(options: AuthOptions) {
  if ("agent" in options) throw new Error("Custom agents are not supported");
  return createAuthWithAgent({
    ...options,
    agent: createModelAgent(options.model),
  });
}

/** Internal injection point for deterministic controller tests; not a package export. */
export function createAuthWithAgent(
  options: Omit<AuthOptions, "model"> & { agent: AuthAgent },
) {
  for (const value of Object.values(options.limits ?? {}))
    if (!Number.isInteger(value) || value <= 0)
      throw new Error("Limits must be positive integers");
  const agent = options.agent;
  const store = options.store ?? new InMemoryStore();
  let busy = false;

  function start(input: LoginOptions): AuthFlow {
    if (busy) throw new Error("This auth client already has an active flow");
    validateOperationOptions(input);
    const flow = new FlowChannel();
    busy = true;
    void flow.result.then(() => {
      busy = false;
    });
    void runFlow(input, options, agent, store, flow).catch(() => {
      flow.finish({
        status: "failed",
        error: {
          code: "internal_error",
          message: "Authentication could not finish safely",
        },
      });
    });
    return flow;
  }

  return {
    login: start,
    accounts: {
      list: (query?: StoreQuery) => store.list(query),
      remove: (id: string) => store.delete(id),
    },
  };
}
export type AuthClient = ReturnType<typeof createAuth>;
