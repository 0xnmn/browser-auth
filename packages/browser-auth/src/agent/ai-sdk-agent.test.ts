import { expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError, LoadAPIKeyError } from "ai";
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
const modelFor = (...calls: Array<{ name: string; input: object }>) =>
  new MockLanguageModelV4({
    doGenerate: {
      content: calls.map(({ name, input }, index) => ({
        type: "tool-call" as const,
        toolCallId: `call-${index}`,
        toolName: name,
        input: JSON.stringify(input),
      })),
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });

it("uses real AI SDK tools without execute callbacks and validates the call", async () => {
  const model = modelFor({ name: "wait", input: { milliseconds: 100 } });
  expect(
    await createStructuredAgent(model).next(observation, {
      signal: new AbortController().signal,
    }),
  ).toEqual({ kind: "wait", milliseconds: 100 });
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(model.doGenerateCalls[0]!.toolChoice).toEqual({ type: "required" });
  expect(model.doGenerateCalls[0]!.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "ask_user",
        description: expect.any(String),
      }),
      expect.objectContaining({
        name: "click",
        description: expect.any(String),
      }),
    ]),
  );
  expect(model.doGenerateCalls[0]!.tools).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: expect.stringMatching(/^(form|session|external)$/),
      }),
    ]),
  );
  expect(
    model.doGenerateCalls[0]!.tools!.every((entry) => !("execute" in entry)),
  ).toBe(true);
  const forged = modelFor({ name: "wait", input: {} });
  await expect(
    createStructuredAgent(forged).next(observation, {
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "model_output_invalid" });
  expect(forged.doGenerateCalls).toHaveLength(1);
});

it("forwards screenshots as images, not base64 in observation text", async () => {
  const model = modelFor({ name: "observe", input: {} });
  await createStructuredAgent(model).next(
    {
      ...observation,
      screenshot: {
        mediaType: "image/png",
        data: "cG5n",
        width: 1,
        height: 1,
      },
    },
    { signal: new AbortController().signal },
  );
  const prompt = model.doGenerateCalls[0]!.prompt;
  expect(prompt[1]).toMatchObject({
    role: "user",
    content: [
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({
        type: "file",
        mediaType: "image/png",
        data: { type: "data", data: "cG5n" },
      }),
    ],
  });
  expect(
    JSON.stringify((prompt[1] as { content: unknown[] }).content[0]),
  ).not.toContain("cG5n");
});

it.each([
  ["zero", []],
  [
    "multiple",
    [
      { name: "observe", input: {} },
      { name: "back", input: {} },
    ],
  ],
  ["unknown", [{ name: "evaluate", input: { script: "document.cookie" } }]],
] as const)("rejects %s tool calls", async (_label, calls) => {
  const model = modelFor(...calls);
  await expect(
    createStructuredAgent(model).next(observation, {
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
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
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-0",
                    type: "function",
                    function: {
                      name: "wait",
                      arguments: '{"milliseconds":100}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
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
      ).toEqual({ kind: "wait", milliseconds: 100 });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        path: "/v1/chat/completions?route=eu",
        authorization: "Bearer synthetic-provider-key",
        tenant: "fixture-tenant",
        body: {
          model: "fixture-model",
          tool_choice: "required",
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
        content: [
          {
            type: "tool-call",
            toolCallId: "call-0",
            toolName: "wait",
            input: '{"milliseconds":100}',
          },
        ],
        finishReason: { unified: "tool-calls" },
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
    ).toEqual({ kind: "wait", milliseconds: 100 });
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
  [401, "model_access_denied"],
  [403, "model_access_denied"],
  [404, "model_not_found"],
  [429, "model_rate_limited"],
  [400, "model_request_rejected"],
  [422, "model_request_rejected"],
  [500, "model_request_failed"],
] as const)(
  "maps HTTP %s to safe error %s without retaining raw data",
  async (statusCode, code) => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: "private-error",
          url: "https://private.endpoint",
          requestBodyValues: { secret: "private-value" },
          statusCode,
          responseBody: "private-body",
        });
      },
    });
    const error = await createStructuredAgent(model)
      .next(observation, { signal: new AbortController().signal })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code });
    expect(String(error) + JSON.stringify(error)).not.toContain("private");
    expect(error).not.toHaveProperty("cause");
    expect(model.doGenerateCalls).toHaveLength(1);
  },
);

it("reports missing keys without leaking the SDK error", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new LoadAPIKeyError({ message: "private-config" });
    },
  });
  await expect(
    createStructuredAgent(model).next(observation, {
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    code: "model_key_missing",
    message: expect.stringContaining("OPENAI_API_KEY"),
  });
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
