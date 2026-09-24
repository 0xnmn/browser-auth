import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { createOtlpTracing } from "../../packages/browser-auth/src/tracing.js";

const { trace } = createRequire(
  new URL("../../packages/browser-auth/package.json", import.meta.url),
)(
  "@opentelemetry/api",
) as typeof import("../../packages/browser-auth/node_modules/@opentelemetry/api/build/src/index.js");

it("exports spans to the configured OTLP endpoint without installing a global provider", async () => {
  const requests: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ headers: request.headers, body: Buffer.concat(chunks) });
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const globalBefore = trace
      .getTracer("global-before")
      .startSpan("must-not-record");
    expect(globalBefore.isRecording()).toBe(false);
    globalBefore.end();

    const tracing = await createOtlpTracing({
      url: `http://127.0.0.1:${port}/v1/traces`,
      headers: { "x-fixture-collector": "local" },
    });
    const span = tracing.tracer.startSpan("integration.fixed-span", {
      attributes: { "test.kind": "otlp", "test.fixed": 42 },
    });
    span.end();
    await tracing.shutdown();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers["x-fixture-collector"]).toBe("local");
    // The protobuf wire body retains UTF-8 field names and string values verbatim.
    const payload = requests[0]!.body.toString("utf8");
    expect(payload).toContain("integration.fixed-span");
    expect(payload).toContain("test.kind");
    expect(payload).toContain("otlp");
    expect(payload).toContain("test.fixed");

    const globalAfter = trace
      .getTracer("global-after")
      .startSpan("still-must-not-record");
    expect(globalAfter.isRecording()).toBe(false);
    globalAfter.end();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
