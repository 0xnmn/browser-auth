import { useCallback, useEffect, useState } from "react";
import type {
  AuthFlow,
  AuthResponse,
  AuthSnapshot,
} from "@browser-auth/core/protocol";

export type AuthTransport = Pick<AuthFlow, "updates" | "respond">;

export interface UseAuthFlowResult {
  snapshot: AuthSnapshot | undefined;
  respond: (response: AuthResponse) => Promise<void>;
}

/** Subscribes to a flow without assuming how it is transported. */
export function useAuthFlow(transport: AuthTransport): UseAuthFlowResult {
  const [state, setState] = useState<{
    transport: AuthTransport;
    snapshot: AuthSnapshot;
  }>();

  useEffect(() => {
    let active = true;
    let iterator: AsyncIterator<AuthSnapshot> | undefined;
    let receivedTerminalResult = false;

    const interrupt = () => {
      if (!active || receivedTerminalResult) return;
      setState({
        transport,
        snapshot: {
          status: "done",
          result: {
            status: "unknown",
            message:
              "The authentication connection was interrupted. Check the browser before retrying.",
          },
        },
      });
    };

    void (async () => {
      try {
        iterator = transport.updates()[Symbol.asyncIterator]();
        while (active) {
          const next = await iterator.next();
          if (!active) return;
          if (next.done) {
            interrupt();
            return;
          }
          if (receivedTerminalResult) continue;
          receivedTerminalResult = next.value.status === "done";
          setState({ transport, snapshot: next.value });
        }
      } catch {
        interrupt();
      }
    })();

    return () => {
      active = false;
      void (async () => {
        try {
          await iterator?.return?.();
        } catch {
          // Teardown is best-effort and must not surface transport details.
        }
      })();
    };
  }, [transport]);

  const respond = useCallback(
    (response: AuthResponse) => transport.respond(response),
    [transport],
  );
  return {
    snapshot: state?.transport === transport ? state.snapshot : undefined,
    respond,
  };
}
