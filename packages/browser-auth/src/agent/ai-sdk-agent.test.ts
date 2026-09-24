import { expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { createModelAgent } from "./ai-sdk-agent.js";
import type { AuthObservation } from "./proposals.js";

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
    await createModelAgent(model).next(observation, {
      signal: new AbortController().signal,
    }),
  ).toEqual({ kind: "wait" });
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(model.doGenerateCalls[0]!.responseFormat?.type).toBe("json");
  const forged = modelFor(
    '{"kind":"evaluate","script":"fetch(document.cookie)"}',
  );
  await expect(
    createModelAgent(forged).next(observation, {
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  expect(forged.doGenerateCalls).toHaveLength(1);
});
