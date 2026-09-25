import { expect, it } from "vitest";
import { createAuthWithAgent } from "../auth.js";
import { parseResult } from "../protocol.js";
import type { AuthTranscriptEvent } from "../transcript.js";
import { FlowChannel } from "./interaction.js";

async function collect(stream: AsyncIterable<AuthTranscriptEvent>) {
  const events: AuthTranscriptEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

it("subscribes on call, has no pre-subscription replay, and closes late subscribers", async () => {
  const flow = new FlowChannel();
  flow.diagnostics.emit({ type: "start" });
  const stream = flow.transcript();
  flow.diagnostics.emit({ type: "start" });
  flow.finish({ status: "cancelled" });
  expect((await collect(stream)).map((e) => [e.sequence, e.type])).toEqual([
    [2, "start"],
    [3, "result"],
  ]);
  expect(await collect(flow.transcript())).toEqual([]);
});

it("delivers the initial event even for an immediately aborted login", async () => {
  const flow = createAuthWithAgent({
    agent: {
      async next() {
        throw new Error("must not run");
      },
    },
  }).login({
    cdpUrl: "http://127.0.0.1:1",
    url: "https://example.test",
    signal: AbortSignal.abort(),
  });
  const events = await collect(flow.transcript());
  expect(events.map((e) => e.type)).toEqual(["start", "error", "result"]);
  expect(events[1]).toMatchObject({
    phase: "browser_connect",
    reason: "caller_cancelled",
    writeAttempted: false,
  });
  expect(await flow.result).toEqual({ status: "cancelled" });
});

it("bounds each subscriber independently and reports ordered gap ranges", async () => {
  const flow = new FlowChannel();
  const slow = flow.transcript();
  const fast = flow.transcript();
  for (let i = 1; i <= 70; i++) {
    flow.diagnostics.emit({ type: "start" });
    expect((await fast.next()).value?.sequence).toBe(i);
  }
  expect((await slow.next()).value).toMatchObject({
    type: "gap",
    sequence: 6,
    fromSequence: 1,
    toSequence: 6,
  });
  for (let i = 7; i <= 70; i++)
    expect((await slow.next()).value?.sequence).toBe(i);
  flow.finish({ status: "cancelled" });
  expect((await collect(slow)).map((e) => e.type)).toEqual(["result"]);
  expect((await collect(fast)).map((e) => e.type)).toEqual(["result"]);
});

it("bounds bytes as well as count, including an oversized event", async () => {
  const flow = new FlowChannel();
  const stream = flow.transcript();
  flow.diagnostics.emit({ type: "start" });
  flow.diagnostics.emit({
    type: "execution",
    step: 1,
    tool: "inspect",
    status: "completed",
    writeAttempted: false,
    result: "x".repeat(8 * 1024 * 1024),
  });
  flow.finish({ status: "cancelled" });
  expect((await collect(stream)).map((e) => e.type)).toEqual(["gap", "result"]);
});

it("return removes a subscriber and settles outstanding next without stopping the flow", async () => {
  const flow = new FlowChannel();
  const stream = flow.transcript();
  const pending = stream.next();
  await stream.return!();
  expect(await pending).toEqual({ done: true, value: undefined });
  const other = flow.transcript();
  flow.diagnostics.emit({ type: "start" });
  flow.finish({ status: "already-signed-in" });
  expect(await stream.next()).toEqual({ done: true, value: undefined });
  expect((await collect(other)).map((e) => e.type)).toEqual([
    "start",
    "result",
  ]);
});

it("isolates the source and each subscriber's nested data", async () => {
  const flow = new FlowChannel();
  const a = flow.transcript(),
    b = flow.transcript();
  const observation = {
    origin: "https://example.test",
    text: "original",
    tree: "[]",
    elements: [],
    operation: "login" as const,
    history: ["original"],
    availableCredentialKeys: [],
  };
  flow.diagnostics.emit({ type: "observation", step: 1, observation });
  observation.history[0] = "source mutation";
  const event = (await a.next()).value!;
  if (event.type !== "observation") throw new Error("observation required");
  event.observation.history![0] = "consumer mutation";
  expect((await b.next()).value).toMatchObject({
    observation: { history: ["original"] },
  });
  expect(observation.history).toEqual(["source mutation"]);
  await a.return!();
  await b.return!();
});

it("structurally redacts reflected values without corrupting protocol enums or JSON", async () => {
  const flow = new FlowChannel();
  const stream = flow.transcript();
  const secret = 'p"ass\\word\nvalue';
  for (const value of [secret, "click", "kind"])
    flow.diagnostics.redactor.add(value);
  flow.diagnostics.emit({
    type: "proposal",
    step: 1,
    proposal: { kind: "click", elementId: secret },
  });
  flow.diagnostics.emit({
    type: "execution",
    step: 1,
    tool: "click",
    status: "completed",
    writeAttempted: true,
    result: {
      [secret]: { kind: secret },
      json: JSON.stringify({ value: secret }),
    },
  });
  flow.finish({
    status: "authenticated",
    accountId: secret,
    save: { status: "not-saved" },
  });
  const events = await collect(stream);
  expect(events[0]).toMatchObject({
    proposal: { kind: "click", elementId: "[redacted]" },
  });
  expect(events[1]).toMatchObject({
    result: {
      "[redacted]": { "[redacted]": "[redacted]" },
      json: '{"value":"[redacted]"}',
    },
  });
  expect(events[2]).toMatchObject({
    result: { status: "authenticated", accountId: "[redacted]" },
  });
  expect(JSON.parse(JSON.stringify(events))).toEqual(events);
});

it.each(['{"token":"abc"}', '["private","credential"]'])(
  "redacts JSON-shaped credentials at string leaves: %s",
  async (secret) => {
    const flow = new FlowChannel();
    const stream = flow.transcript();
    flow.diagnostics.redactor.add(secret);
    flow.diagnostics.emit({
      type: "proposal",
      step: 1,
      proposal: {
        kind: "ask_user",
        message: secret,
        fields: [],
        choices: [],
        external: true,
        submitElementId: null,
      },
    });
    flow.diagnostics.emit({
      type: "execution",
      step: 1,
      tool: "inspect",
      status: "completed",
      writeAttempted: false,
      result: JSON.stringify({ leaf: secret }),
    });
    flow.finish({ status: "unknown", message: secret });
    const events = await collect(stream);
    expect(events[0]).toMatchObject({ proposal: { message: "[redacted]" } });
    expect(events[1]).toMatchObject({ result: '{"leaf":"[redacted]"}' });
    expect(events[2]).toMatchObject({ result: { message: "[redacted]" } });
  },
);

it("redacts mixed literal and JSON-escaped credentials without returning a partially filtered leaf", async () => {
  const flow = new FlowChannel();
  const stream = flow.transcript();
  const username = "alice",
    password = '{"token":"abc"}';
  flow.diagnostics.redactor.add(username);
  flow.diagnostics.redactor.add(password);
  const mixed = JSON.stringify({ username, password });
  for (const value of [mixed, JSON.stringify({ nested: mixed })])
    flow.diagnostics.emit({
      type: "execution",
      step: 1,
      tool: "inspect",
      status: "completed",
      writeAttempted: false,
      result: value,
    });
  flow.finish({ status: "cancelled" });
  const events = await collect(stream);
  expect(events.slice(0, 2)).toMatchObject([
    { result: "[redacted]" },
    { result: "[redacted]" },
  ]);
});

it.each(["not-requested", "deleted", "failed"] as const)(
  "preserves the deletion enum when a credential equals %s",
  async (deletion) => {
    const flow = new FlowChannel();
    const stream = flow.transcript();
    flow.diagnostics.redactor.add(deletion);
    flow.finish({ status: "signed-out", deletion });
    const event = (await collect(stream))[0]!;
    if (event.type !== "result") throw new Error("result required");
    expect(parseResult(event.result)).toEqual({
      status: "signed-out",
      deletion,
    });
  },
);

it("records only submitted field identifiers and never response values", async () => {
  const flow = new FlowChannel();
  const stream = flow.transcript();
  const answer = flow.ask(
    {
      message: "Password",
      fields: [
        { id: "p", label: "Password", type: "password", required: true },
      ],
      choices: [],
    },
    new AbortController().signal,
  );
  const interaction = (await stream.next()).value!;
  if (interaction.type !== "interaction")
    throw new Error("interaction required");
  await flow.respond({
    kind: "submit",
    interactionId: interaction.interaction.id,
    values: { p: "private-password" },
  });
  expect(await answer).toMatchObject({ values: { p: "private-password" } });
  flow.finish({ status: "unknown", message: "Reflected private-password" });
  const events = await collect(stream);
  expect(events[0]).toMatchObject({
    response: { kind: "submit", fieldIds: ["p"] },
  });
  expect(JSON.stringify(events)).not.toContain("private-password");
  expect(events[1]).toMatchObject({
    result: { message: "[redacted]" },
  });
});
