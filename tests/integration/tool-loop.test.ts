import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAuthWithAgent } from "../../packages/browser-auth/src/auth.js";
import { BrowserSurface } from "../../packages/browser-auth/src/browser/observation.js";
import { AuthFailure } from "../../packages/browser-auth/src/errors.js";
import { InMemoryStore } from "../../packages/browser-auth/src/index.js";
import {
  launchSharedBrowser,
  authTarget,
  type SharedBrowser,
} from "../helpers/browser.js";
import { startAuthSite } from "../fixtures/auth-site.js";
import { FixtureAgent } from "../helpers/scripted-agent.js";
import { complete, defaultResponse } from "../helpers/respond.js";

let shared: SharedBrowser;
let site: Awaited<ReturnType<typeof startAuthSite>>;
beforeEach(async () => {
  site = await startAuthSite();
  shared = await launchSharedBrowser();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await shared.close();
  await site.close();
});

it("does not claim account change when final control validation prevents the click", async () => {
  const page = await shared.context.newPage();
  await page.goto(site.url);
  await page.setContent(
    '<h1>Signed in as A</h1><a href="/switch?to=bob">Work B</a>',
  );
  const validate = BrowserSurface.prototype.validate;
  let validations = 0;
  vi.spyOn(BrowserSurface.prototype, "validate").mockImplementation(
    async function (this: BrowserSurface, id, signal) {
      if (++validations === 3)
        throw new AuthFailure("stale_page", "The control changed");
      return validate.call(this, id, signal);
    },
  );
  let turns = 0;
  const run = await complete(
    createAuthWithAgent({
      agent: {
        async next(observation) {
          if (turns++) return { kind: "done", outcome: "account-changed" };
          return {
            kind: "ask_user",
            message: "Choose account",
            fields: [],
            submitElementId: null,
            external: false,
            choices: [
              {
                elementId: observation.elements[0]!.id,
                label: "Work B",
                intent: "switch",
              },
            ],
          };
        },
      },
    }).login(authTarget(shared, page)),
  );
  expect(validations).toBe(3);
  expect(run.result.status).toBe("unknown");
  expect(await page.locator("h1").innerText()).toBe("Signed in as A");
  expect(new URL(page.url()).pathname).toBe("/");
});

it("reports partial credential writes as unknown without submitting, saving or replaying", async () => {
  const page = await shared.context.newPage();
  await page.goto(site.url);
  await page.setContent(`<form onsubmit="document.body.dataset.submits='yes'; return false">
    <label>Username<input name=username oninput="document.body.dataset.fills=String(Number(document.body.dataset.fills||0)+1); document.querySelector('[name=password]').remove()"></label>
    <label>Password<input name=password type=password></label><button>Sign in</button></form>`);
  const store = new InMemoryStore();
  const save = vi.spyOn(store, "save");
  const agent = new FixtureAgent();
  const run = await complete(
    createAuthWithAgent({ agent, store }).login({
      ...authTarget(shared, page),
      credentials: {
        username: "private-user-canary",
        password: "private-password-canary",
      },
      save: "yes",
    }),
    defaultResponse,
  );
  expect(run.result.status).toBe("unknown");
  expect(await page.locator("body").getAttribute("data-fills")).toBe("1");
  expect(await page.locator("body").getAttribute("data-submits")).toBeNull();
  expect(save).not.toHaveBeenCalled();
  expect(agent.observations).toHaveLength(1);
  expect(JSON.stringify(agent.observations)).not.toContain(
    "private-user-canary",
  );
  expect(JSON.stringify(agent.observations)).not.toContain(
    "private-password-canary",
  );
});

it("creates, navigates and closes an owned tab without touching borrowed tabs", async () => {
  const page = await shared.context.newPage();
  await page.goto(site.url);
  const unrelated = await shared.context.newPage();
  await unrelated.goto(`${site.url}/unrelated`);
  let turn = 0;
  let ownedId = "";
  const run = await complete(
    createAuthWithAgent({
      agent: {
        async next(observation) {
          switch (turn++) {
            case 0:
              return { kind: "tab_new" };
            case 1:
              expect(observation.elements).toEqual([]);
              expect(observation.tree).toBe("[]");
              ownedId = JSON.parse(observation.context!).pageId;
              return { kind: "navigate", url: site.url };
            case 2:
              expect(observation.elements.length).toBeGreaterThan(0);
              return { kind: "tabs_list" };
            case 3:
              expect(JSON.parse(observation.context!).tabs).toHaveLength(2);
              return { kind: "tab_close", pageId: ownedId };
            default:
              return { kind: "done", outcome: "unsupported" };
          }
        },
      },
    }).login(authTarget(shared, page)),
  );
  expect(run.result).toMatchObject({
    status: "failed",
    error: { code: "unsupported" },
  });
  expect(turn).toBe(5);
  expect(shared.context.pages()).toHaveLength(3); // initial blank + two borrowed tabs
  expect(page.isClosed()).toBe(false);
  expect(unrelated.isClosed()).toBe(false);
});

it("stops after dismissing an unsupported native dialog without replay or acceptance", async () => {
  const page = await shared.context.newPage();
  await page.goto(site.url);
  await page.setContent(
    `<button onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1); document.body.dataset.accepted=String(confirm('Continue?'))">Continue</button>`,
  );
  let turns = 0;
  const run = await complete(
    createAuthWithAgent({
      agent: {
        async next(observation) {
          turns++;
          return { kind: "click", elementId: observation.elements[0]!.id };
        },
      },
    }).login(authTarget(shared, page)),
  );
  expect(run.result).toMatchObject({
    status: "unknown",
    message: expect.stringContaining("native browser dialog"),
  });
  expect(turns).toBe(1);
  expect(await page.locator("body").getAttribute("data-clicks")).toBe("1");
  expect(await page.locator("body").getAttribute("data-accepted")).toBe(
    "false",
  );
});

it("reports completion of external-only login as authenticated, not already signed in", async () => {
  const page = await shared.context.newPage();
  await page.goto(site.url);
  let turn = 0;
  const run = await complete(
    createAuthWithAgent({
      agent: {
        async next() {
          return turn++ === 0
            ? {
                kind: "ask_user",
                message: "Approve on your device",
                fields: [],
                choices: [],
                submitElementId: null,
                external: true,
              }
            : { kind: "done", outcome: "authenticated" };
        },
      },
    }).login({ ...authTarget(shared, page), save: "never" }),
    async (interaction) => {
      expect(interaction.pollAfterMs).toBeDefined();
      await page.setContent("<h1>Signed in</h1>");
      return null;
    },
  );
  expect(run.result).toEqual({
    status: "authenticated",
    save: { status: "not-saved" },
  });
});

it("reobserves stale completion without saving or replaying login", async () => {
  const page = await shared.context.newPage();
  await page.goto(site.url);
  const store = new InMemoryStore();
  const save = vi.spyOn(store, "save");
  const fixture = new FixtureAgent();
  let invalidated = false;
  const run = await complete(
    createAuthWithAgent({
      store,
      agent: {
        async next(observation) {
          if (invalidated) {
            expect(observation.text).toContain("Session expired");
            return { kind: "done", outcome: "rejected" };
          }
          const proposal = await fixture.next(observation);
          if (
            proposal.kind === "done" &&
            proposal.outcome === "authenticated"
          ) {
            invalidated = true;
            await page.setContent("<h1>Session expired</h1>");
          }
          return proposal;
        },
      },
    }).login({ ...authTarget(shared, page), save: "yes" }),
  );
  expect(invalidated).toBe(true);
  expect(run.result).toMatchObject({
    status: "failed",
    error: { code: "rejected" },
  });
  expect(save).not.toHaveBeenCalled();
});

it.each(["fallback", "explicit"] as const)(
  "does not report success after a native dialog during %s finish",
  async (mode) => {
    const page = await shared.context.newPage();
    await page.goto(site.url);
    await page.setContent("<h1>Signed in</h1>");
    const run = await complete(
      createAuthWithAgent({
        agent: {
          async next() {
            return mode === "fallback"
              ? { kind: "done", outcome: "authenticated" }
              : {
                  kind: "ask_user",
                  message: "Signed in",
                  fields: [],
                  choices: [
                    { elementId: "finish", label: "Finish", intent: "finish" },
                  ],
                  submitElementId: null,
                  external: false,
                };
          },
        },
      }).login(authTarget(shared, page)),
      async (interaction) => {
        expect(
          await page.evaluate(() => confirm("Unrelated confirmation")),
        ).toBe(false);
        return defaultResponse(interaction);
      },
    );
    expect(run.result).toMatchObject({
      status: "unknown",
      message: expect.stringContaining("native browser dialog"),
    });
  },
);

it("allows discovery with a previously valid long saved-account label", async () => {
  const page = await shared.context.newPage();
  await page.goto(site.url);
  const store = new InMemoryStore();
  const label = "Account ".repeat(70);
  await store.save({
    id: "long-label",
    label,
    serviceOrigins: [site.url],
    credentialOrigins: [site.url],
    credentials: [],
  });
  let offered = false;
  const run = await complete(
    createAuthWithAgent({ store, agent: new FixtureAgent() }).login({
      ...authTarget(shared, page),
      save: "never",
    }),
    (interaction) => {
      if (interaction.choices.some((choice) => choice.label === label)) {
        offered = true;
        return {
          kind: "choose",
          interactionId: interaction.id,
          choiceId: "new",
        };
      }
      return defaultResponse(interaction);
    },
  );
  expect(offered).toBe(true);
  expect(run.result.status).toBe("authenticated");
});
