import { expect, it } from "vitest";
import { FlowChannel } from "./interaction.js";

it("validates fields and consumes each interaction once", async () => {
  const flow = new FlowChannel();
  const answer = flow.ask(
    {
      kind: "form",
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
    { kind: "external", message: "Approve on your device", choices: [] },
    controller.signal,
  );
  controller.abort();
  expect(await answer).toBeNull();
  const current = flow.updates()[Symbol.asyncIterator]();
  expect((await current.next()).value?.status).toBe("running");
  await current.return?.();
  flow.finish({ status: "cancelled" });
  await expect(
    flow.ask(
      { kind: "external", message: "Too late", choices: [] },
      new AbortController().signal,
    ),
  ).rejects.toThrow("flow_completed");
  expect(await flow.result).toEqual({ status: "cancelled" });
  const states = [];
  for await (const snapshot of flow.updates()) states.push(snapshot);
  expect(states).toEqual([{ status: "done", result: { status: "cancelled" } }]);
});
