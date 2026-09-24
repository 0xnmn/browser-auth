import type { AuthResult } from "./protocol.js";

export interface AuthTrace {
  step(index: number): void;
  action(
    kind: "click" | "form" | "external" | "done" | "wait" | "session",
  ): void;
  end(result: AuthResult["status"]): void;
}
export interface AuthTracer {
  startFlow(operation: "login" | "logout" | "choose-account"): AuthTrace;
}
export interface OtlpOptions {
  url: string;
  headers?: Record<string, string>;
}

/** Explicitly creates a private provider; never installs a global tracer. */
export async function createOtlpTracing(
  options: OtlpOptions,
): Promise<{ tracer: AuthTracer; shutdown(): Promise<void> }> {
  const [{ BasicTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }] =
    await Promise.all([
      import("@opentelemetry/sdk-trace-base"),
      import("@opentelemetry/exporter-trace-otlp-http"),
    ]);
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: options.url,
          headers: options.headers ?? {},
        }),
      ),
    ],
  });
  const tracer = provider.getTracer("browser-auth", "0.1.0");
  return {
    tracer: {
      startFlow(operation) {
        const span = tracer.startSpan("browser_auth.flow", {
          attributes: { "auth.operation": operation },
        });
        return {
          step: (index) => {
            span.addEvent("step", { "auth.step": index });
          },
          action: (kind) => {
            span.addEvent("proposal", { "auth.action": kind });
          },
          end: (result) => {
            span.setAttribute("auth.result", result);
            if (result === "failed" || result === "unknown")
              span.setStatus({ code: 2 });
            span.end();
          },
        };
      },
    },
    shutdown: () => provider.shutdown(),
  };
}
