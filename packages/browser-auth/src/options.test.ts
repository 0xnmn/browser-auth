import { expect, it } from "vitest";
import { createAuth } from "./auth.js";
import { parseResponse, parseSnapshot } from "./protocol.js";
import type { AuthOptions, LoginOptions, ModelConfig } from "./types.js";

it("rejects library objects and invalid operation options before connecting", () => {
  const auth = createAuth({
    model: { provider: "openai", model: "fixture" },
  });
  expect(() => auth.login({ page: {} } as unknown as LoginOptions)).toThrow(
    "invalid_login_options",
  );
  expect(() =>
    auth.login({
      cdpUrl: "http://browser",
      url: "https://site.test",
      save: "sometimes",
    } as unknown as LoginOptions),
  ).toThrow("invalid_login_options");
  expect(() =>
    createAuth({
      model: { specificationVersion: "v4" } as unknown as ModelConfig,
    }),
  ).toThrow("Invalid model configuration");
});

it.each([
  "google.com",
  "not a URL",
  "javascript:alert(1)",
  "http://example.com",
  "https://user:secret@example.com",
])("rejects invalid website URL %s before starting a browser flow", (url) => {
  const auth = createAuth({ model: { provider: "openai", model: "fixture" } });
  expect(() => auth.login({ url, cdpUrl: "http://127.0.0.1:1" })).toThrow(
    /^invalid_auth_url$/,
  );
});

it("rejects removed custom-agent configurations, including ones with a valid model", () => {
  for (const model of [undefined, { provider: "openai", model: "fixture" }]) {
    expect(() =>
      createAuth({ model, agent: { next() {} } } as unknown as AuthOptions),
    ).toThrow("Custom agents are not supported");
  }
});

it("public parsers return plain protocol values and fixed, payload-free errors", () => {
  expect(
    parseSnapshot({ status: "done", result: { status: "cancelled" } }),
  ).toEqual({ status: "done", result: { status: "cancelled" } });
  const result = parseResponse({
    kind: "submit",
    interactionId: "one",
    values: { password: "synthetic" },
  });
  expect(result.kind).toBe("submit");
  try {
    parseResponse({
      kind: "submit",
      interactionId: "one",
      values: { password: 42 },
      secret: "private-value",
    });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).constructor).toBe(Error);
    expect((error as Error).message).toBe("invalid_response");
    return;
  }
  throw new Error("Invalid response was accepted");
});
