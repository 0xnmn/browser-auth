import { expect, it } from "vitest";
import { parseInteraction } from "../protocol.js";
import { FlowChannel } from "./interaction.js";

it("validates fields and consumes each interaction once", async () => {
  const flow = new FlowChannel();
  const answer = flow.ask(
    {
      message: "Enter password",
      fields: [
        { id: "password", label: "Password", type: "password", required: true },
      ],
      choices: [{ id: "back", label: "Back", kind: "back" }],
    },
    new AbortController().signal,
  );
  const iterator = flow.updates()[Symbol.asyncIterator]();
  const snapshot = (await iterator.next()).value!;
  if (snapshot.status !== "waiting") throw new Error("Expected prompt");
  const interactionId = snapshot.interaction.id;
  await expect(
    flow.respond({
      kind: "submit",
      interactionId,
      values: { unexpected: "x" },
    }),
  ).rejects.toThrow("invalid_fields");
  await expect(
    flow.respond({ kind: "submit", interactionId, values: {} }),
  ).rejects.toThrow("missing_field");
  const response = { kind: "choose" as const, interactionId, choiceId: "back" };
  await flow.respond(response);
  await expect(flow.respond(response)).rejects.toThrow("stale_interaction");
  expect(await answer).toEqual(response);
  await iterator.return?.();
});

it("settles cancelled waits and replays the terminal snapshot to late subscribers", async () => {
  const flow = new FlowChannel();
  const controller = new AbortController();
  const answer = flow.ask(
    { message: "Approve on your device", fields: [], choices: [] },
    controller.signal,
    1000,
  );
  controller.abort();
  expect(await answer).toBeNull();
  const current = flow.updates()[Symbol.asyncIterator]();
  expect((await current.next()).value?.status).toBe("running");
  await current.return?.();
  flow.finish({ status: "cancelled" });
  await expect(
    flow.ask(
      { message: "Too late", fields: [], choices: [] },
      new AbortController().signal,
      1000,
    ),
  ).rejects.toThrow("flow_completed");
  expect(await flow.result).toEqual({ status: "cancelled" });
  const states = [];
  for await (const snapshot of flow.updates()) states.push(snapshot);
  expect(states).toEqual([{ status: "done", result: { status: "cancelled" } }]);
});

it("publishes polling metadata and rejects ambiguous or unanswerable envelopes", async () => {
  const flow = new FlowChannel();
  const pending = flow.ask(
    { message: "Waiting", fields: [], choices: [] },
    new AbortController().signal,
    10_000,
  );
  const iterator = flow.updates()[Symbol.asyncIterator]();
  const snapshot = (await iterator.next()).value!;
  expect(snapshot).toMatchObject({
    status: "waiting",
    interaction: { message: "Waiting", pollAfterMs: 10_000 },
  });
  flow.finish({ status: "cancelled" });
  expect(await pending).toBeNull();
  await iterator.return?.();

  expect(() =>
    parseInteraction({
      id: "empty",
      message: "Waiting",
      fields: [],
      choices: [],
    }),
  ).toThrow("invalid_interaction");
  expect(() =>
    parseInteraction({
      id: "duplicate",
      message: "Choose",
      fields: [{ id: "same", label: "Name", type: "text", required: true }],
      choices: [{ id: "same", label: "Back" }],
    }),
  ).toThrow("invalid_interaction");
});

it("preserves large account lists and rejects ambiguous confirmation payloads", () => {
  const base = {
    id: "accounts",
    message: "Choose",
    fields: [],
    choices: Array.from({ length: 33 }, (_, index) => ({
      id: String(index),
      label: `Account ${index}`,
    })),
  };
  expect(parseInteraction(base).choices).toHaveLength(33);
  const confirmation = {
    ...base,
    confirmation: { kind: "save-credentials" },
    choices: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
  };
  expect(parseInteraction(confirmation).confirmation).toEqual({
    kind: "save-credentials",
  });
  for (const invalid of [
    { ...confirmation, choices: confirmation.choices.slice(0, 1) },
    { ...confirmation, choices: [...confirmation.choices].reverse() },
    {
      ...confirmation,
      fields: [
        { id: "password", label: "Password", type: "password", required: true },
      ],
    },
    { ...confirmation, pollAfterMs: 10 },
  ])
    expect(() => parseInteraction(invalid)).toThrow("invalid_interaction");
});
