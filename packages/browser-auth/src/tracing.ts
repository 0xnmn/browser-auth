import type { Tracer } from "@opentelemetry/api";

/** Explicitly creates a private provider; never installs a global tracer. */
export async function createOtlpTracing(options: {
  url: string;
  headers?: Record<string, string>;
}): Promise<{ tracer: Tracer; shutdown(): Promise<void> }> {
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
  return {
    tracer: provider.getTracer("browser-auth", "0.1.0"),
    shutdown: () => provider.shutdown(),
  };
}
