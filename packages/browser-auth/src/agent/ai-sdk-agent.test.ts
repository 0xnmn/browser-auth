import { expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MockLanguageModelV4 } from "ai/test";
import { createModelAgent, createStructuredAgent } from "./ai-sdk-agent.js";
import type { AuthObservation } from "./proposals.js";
import type { ModelConfig } from "../types.js";

const observation: AuthObservation = {
  operation: "login",
  origin: "https://example.test",
  text: "Sign in",
  elements: [],
  availableCredentialKeys: ["password"],
};
const modelFor = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });

it("uses AI SDK structured generation and rejects actions outside the proposal contract", async () => {
  const model = modelFor('{"kind":"wait"}');
  expect(
    await createStructuredAgent(model).next(observation, {
      signal: new AbortController().signal,
    }),
  ).toEqual({ kind: "wait" });
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(model.doGenerateCalls[0]!.responseFormat?.type).toBe("json");
  const forged = modelFor(
    '{"kind":"evaluate","script":"fetch(document.cookie)"}',
  );
  await expect(
    createStructuredAgent(forged).next(observation, {
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  expect(forged.doGenerateCalls).toHaveLength(1);
});

it.each([false, true])(
  "forwards compatible endpoint settings with structured output %s",
  async (supportsStructuredOutputs) => {
    const requests: Array<{
      path: string;
      authorization: string | undefined;
      tenant: string | string[] | undefined;
      body: Record<string, unknown>;
    }> = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({
        path: request.url!,
        authorization: request.headers.authorization,
        tenant: request.headers["x-tenant"],
        body: JSON.parse(body),
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "fixture",
          created: 1,
          model: "fixture-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: '{"kind":"wait"}' },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const agent = createModelAgent({
        provider: "openai-compatible",
        model: "fixture-model",
        baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        apiKey: "synthetic-provider-key",
        headers: { "x-tenant": "fixture-tenant" },
        queryParams: { route: "eu" },
        supportsStructuredOutputs,
      });
      expect(
        await agent.next(observation, { signal: new AbortController().signal }),
      ).toEqual({ kind: "wait" });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        path: "/v1/chat/completions?route=eu",
        authorization: "Bearer synthetic-provider-key",
        tenant: "fixture-tenant",
        body: {
          model: "fixture-model",
          response_format: {
            type: supportsStructuredOutputs ? "json_schema" : "json_object",
          },
        },
      });
      expect(JSON.stringify(requests[0]!.body)).not.toContain(
        "synthetic-provider-key",
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  },
);

it.each([
  [{ provider: "openai" }, "/proxy/responses"],
  [{ provider: "openai", api: "chat" }, "/proxy/chat/completions"],
  [{ provider: "anthropic" }, "/proxy/messages"],
] as const)(
  "selects the correct API for %j without retrying failed requests",
  async (settings, path) => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url!);
      request.resume();
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { type: "api_error", message: "synthetic failure" },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const agent = createModelAgent({
        ...settings,
        model: "fixture",
        apiKey: "synthetic",
        baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/proxy`,
      });
      await expect(
        agent.next(observation, { signal: new AbortController().signal }),
      ).rejects.toThrow();
      expect(paths).toEqual([path]);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  },
);

it("forwards Gateway routing unchanged alongside model selection and endpoint headers", async () => {
  const requests: Array<{
    path: string;
    model: unknown;
    tenant: unknown;
    body: Record<string, unknown>;
  }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      path: request.url!,
      model: request.headers["ai-language-model-id"],
      tenant: request.headers["x-tenant"],
      body: JSON.parse(body),
    });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        content: [{ type: "text", text: '{"kind":"wait"}' }],
        finishReason: { unified: "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const routing = {
      order: ["vertex", "anthropic"],
      only: ["anthropic", "vertex"],
      models: ["anthropic/fallback"],
    };
    const agent = createModelAgent({
      provider: "gateway",
      model: "anthropic/primary",
      apiKey: "synthetic",
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`,
      headers: { "x-tenant": "fixture" },
      providerOptions: {
        gateway: routing,
      },
    });
    routing.only.splice(0, routing.only.length, "unapproved");
    routing.models[0] = "other/model";
    expect(
      await agent.next(observation, { signal: new AbortController().signal }),
    ).toEqual({ kind: "wait" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/gateway/language-model",
      model: "anthropic/primary",
      tenant: "fixture",
      body: {
        providerOptions: {
          gateway: {
            order: ["vertex", "anthropic"],
            only: ["anthropic", "vertex"],
            models: ["anthropic/fallback"],
          },
        },
      },
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

it.each([
  { provider: "anthropic", api: "chat" },
  { provider: "openai-compatible" },
  { provider: "openai", providerOptions: { gateway: { only: ["vertex"] } } },
  { provider: "gateway", providerOptions: { gateway: { only: [] } } },
  { provider: "gateway", providerOptions: { gateway: { typo: ["vertex"] } } },
  { provider: "openai", baseURL: "file:///private" },
])(
  "rejects invalid routing and endpoint configuration without exposing it",
  (config) => {
    expect(() =>
      createModelAgent({ model: "fixture", ...config } as ModelConfig),
    ).toThrow(/^Invalid model configuration$/);
  },
);
