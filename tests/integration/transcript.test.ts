import { afterEach, beforeEach, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { createAuthWithAgent } from "../../packages/browser-auth/src/auth.js";
import type {
  AuthFlow,
  AuthTranscriptEvent,
} from "../../packages/browser-auth/src/protocol.js";
import {
  launchSharedBrowser,
  authTarget,
  type SharedBrowser,
} from "../helpers/browser.js";
import {
  startAuthSite,
  fixturePassword,
  fixtureCode,
} from "../fixtures/auth-site.js";
import { FixtureAgent } from "../helpers/scripted-agent.js";
import { complete, defaultResponse } from "../helpers/respond.js";

let shared: SharedBrowser;
let site: Awaited<ReturnType<typeof startAuthSite>>;
beforeEach(async () => {
  site = await startAuthSite();
  shared = await launchSharedBrowser();
});
afterEach(async () => {
  await shared.close();
  await site.close();
});

async function record(flow: AuthFlow) {
  const events: AuthTranscriptEvent[] = [];
  for await (const event of flow.transcript()) events.push(event);
  return events;
}

it("records real controller input/proposals/execution and only already-safe screenshots", async () => {
  const page = await shared.context.newPage();
  await page.goto(site.url);
  const agent = new FixtureAgent();
  const flow = createAuthWithAgent({ agent }).login({
    ...authTarget(shared, page),
    save: "never",
  });
  const recorded = record(flow);
  expect((await complete(flow)).result.status).toBe("authenticated");
  const events = await recorded;
  expect(events[0]).toMatchObject({ type: "start", sequence: 1 });
  expect(events.at(-1)).toMatchObject({
    type: "result",
    result: { status: "authenticated" },
  });
  expect(events.map((e) => e.sequence)).toEqual(
    events.map((_, index) => index + 1),
  );
  const observations = events.filter((e) => e.type === "observation");
  expect(observations).toHaveLength(agent.observations.length);
  expect(observations[0]!.observation.tree).toContain('"ref"');
  expect(observations[0]!.observation.screenshot).toEqual(
    agent.observations[0]!.screenshot,
  );
  expect(observations[0]!.observation.screenshot?.mediaType).toBe("image/png");
  const afterEntry = observations.filter((e) =>
    e.observation.history?.some((h) => h.startsWith("Field receipt:")),
  );
  expect(afterEntry.length).toBeGreaterThan(0);
  expect(afterEntry.every((e) => !e.observation.screenshot)).toBe(true);
  const proposals = events.filter((e) => e.type === "proposal");
  const executions = events.filter((e) => e.type === "execution");
  expect(executions.map((e) => [e.step, e.tool])).toEqual(
    proposals.map((e) => [e.step, e.proposal.kind]),
  );
  expect(executions.every((e) => e.status === "completed")).toBe(true);
  expect(executions.some((e) => e.writeAttempted)).toBe(true);
  expect(
    events.some((e) => e.type === "response" && e.response.kind === "submit"),
  ).toBe(true);
  const serialized = JSON.stringify(events);
  for (const secret of [fixturePassword, fixtureCode])
    expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain('"values"');
  expect(page.isClosed()).toBe(false);
});

it("redacts supplied credentials from connection-time tab titles", async () => {
  const first = await shared.context.newPage();
  const second = await shared.context.newPage();
  await first.goto(`${site.url}/?tab=first`);
  await second.goto(`${site.url}/?tab=second`);
  await first.setContent(
    "<title>supplied-private-password</title><h1>First session</h1>",
  );
  await second.setContent(
    "<title>Other session</title><h1>Second session</h1>",
  );
  const flow = createAuthWithAgent({
    agent: {
      async next(observation) {
        expect(observation.text).toContain("First session");
        return { kind: "done", outcome: "authenticated" };
      },
    },
  }).login({
    cdpUrl: shared.cdpUrl,
    url: `${site.url}/choose`,
    credentials: { password: "supplied-private-password" },
  });
  const recorded = record(flow);
  const run = await complete(flow, (interaction) =>
    interaction.message === "Choose the existing tab to authenticate"
      ? {
          kind: "choose",
          interactionId: interaction.id,
          choiceId: interaction.choices.find((c) =>
            c.label.includes("supplied-private-password"),
          )!.id,
        }
      : defaultResponse(interaction),
  );
  const events = await recorded;
  const tabPrompt = events.find((e) => e.type === "interaction");
  expect(tabPrompt).toMatchObject({
    interaction: { message: "Choose the existing tab to authenticate" },
  });
  expect(tabPrompt?.interaction.choices.map((c) => c.label)).toEqual(
    expect.arrayContaining([
      "[redacted]",
      expect.stringMatching(/^Tab \d+: Other session$/),
    ]),
  );
  expect(JSON.stringify(events)).not.toContain("supplied-private-password");
  expect(run.result.status).toBe("already-signed-in");
  expect(first.url()).toBe(`${site.url}/?tab=first`);
  expect(second.url()).toBe(`${site.url}/?tab=second`);
});

it("reports invalid references as rejected without claiming a write or exposing unvalidated data", async () => {
  const page = await shared.context.newPage();
  await page.goto(site.url);
  const flow = createAuthWithAgent({
    agent: {
      async next() {
        return { kind: "click", elementId: "invented" };
      },
    },
  }).login(authTarget(shared, page));
  const events = await record(flow);
  expect(events.filter((e) => e.type === "execution")).toHaveLength(3);
  for (const event of events.filter((e) => e.type === "execution"))
    expect(event).toMatchObject({
      status: "rejected",
      reason: "invalid_element_reference",
      writeAttempted: false,
    });
  expect(events.find((e) => e.type === "error")).toMatchObject({
    phase: "controller",
    code: "invalid_element_reference",
    writeAttempted: false,
    actionWriteAttempted: false,
  });
  expect((await flow.result).status).toBe("failed");
});

it("distinguishes an actual click timeout and never replays or claims success", async () => {
  const page = await shared.context.newPage();
  await page.goto(site.url);
  await page.setContent(
    "<button onclick=\"document.body.dataset.clicked='yes'\">Continue</button>",
  );
  let calls = 0;
  const flow = createAuthWithAgent({
    limits: { actionTimeoutMs: 300 },
    agent: {
      async next(observation) {
        calls++;
        await page.evaluate(() => {
          const overlay = document.createElement("div");
          overlay.style.cssText =
            "position:fixed;inset:0;z-index:999;background:white";
          document.body.append(overlay);
        });
        return { kind: "click", elementId: observation.elements[0]!.id };
      },
    },
  }).login(authTarget(shared, page));
  const events = await record(flow);
  expect(calls).toBe(1);
  expect(events.find((e) => e.type === "execution")).toMatchObject({
    tool: "click",
    status: "failed",
    writeAttempted: true,
  });
  expect(events.find((e) => e.type === "error")).toMatchObject({
    phase: "browser_action",
    code: "browser_action_failed",
    reason: "action_timeout",
    writeAttempted: true,
    actionWriteAttempted: true,
  });
  expect(await page.locator("body").getAttribute("data-clicked")).toBeNull();
  expect((await flow.result).status).toBe("unknown");
});

it.each(["deadline", "caller_cancelled"] as const)(
  "distinguishes %s from provider failure",
  async (reason) => {
    const page = await shared.context.newPage();
    await page.goto(site.url);
    const controller = new AbortController();
    const flow = createAuthWithAgent({
      limits: { timeoutMs: 2000 },
      agent: {
        async next(_observation, { signal }) {
          if (reason === "caller_cancelled")
            queueMicrotask(() => controller.abort("private-abort-reason"));
          await delay(4000, undefined, { signal });
          return { kind: "done", outcome: "unsupported" };
        },
      },
    }).login({ ...authTarget(shared, page), signal: controller.signal });
    const events = await record(flow);
    expect(events.find((e) => e.type === "error")).toMatchObject({
      phase: "agent",
      reason,
      writeAttempted: false,
      actionWriteAttempted: false,
    });
    expect(JSON.stringify(events)).not.toContain("private-abort-reason");
  },
);

it("records a sanitized model failure after a completed browser write", async () => {
  const page = await shared.context.newPage();
  await page.goto(site.url);
  await page.setContent(
    "<button onclick=\"document.body.dataset.clicked='yes'\">Continue</button>",
  );
  let calls = 0;
  const flow = createAuthWithAgent({
    agent: {
      async next(observation) {
        if (++calls === 1)
          return { kind: "click", elementId: observation.elements[0]!.id };
        throw new Error("raw-provider-payload-and-key");
      },
    },
  }).login(authTarget(shared, page));
  const events = await record(flow);
  expect(events.find((e) => e.type === "execution")).toMatchObject({
    status: "completed",
    writeAttempted: true,
  });
  expect(events.find((e) => e.type === "error")).toMatchObject({
    phase: "agent",
    reason: "failure",
    writeAttempted: true,
    actionWriteAttempted: false,
  });
  expect(JSON.stringify(events)).not.toContain("raw-provider-payload-and-key");
  expect(await page.locator("body").getAttribute("data-clicked")).toBe("yes");
});
