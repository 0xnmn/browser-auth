import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { InMemoryStore } from "../../packages/browser-auth/src/index.js";
import { createAuthWithAgent as createAuth } from "../../packages/browser-auth/src/auth.js";
import { BrowserSurface } from "../../packages/browser-auth/src/browser/observation.js";
import { Redactor } from "../../packages/browser-auth/src/security/redaction.js";
import {
  startAuthSite,
  fixturePassword,
  fixtureCode,
} from "../fixtures/auth-site.js";
import { FixtureAgent } from "../helpers/scripted-agent.js";
import {
  authTarget,
  launchSharedBrowser,
  type SharedBrowser,
} from "../helpers/browser.js";
import { complete, defaultResponse } from "../helpers/respond.js";

let shared: SharedBrowser;
let site: Awaited<ReturnType<typeof startAuthSite>>;
beforeAll(async () => {
  site = await startAuthSite();
});
beforeEach(async () => {
  shared = await launchSharedBrowser();
});
afterEach(async () => {
  await shared?.close();
});
afterAll(async () => {
  await site?.close();
});

it("logs in with partial inputs, saves, offers stored accounts, switches and logs out with forgetting", async () => {
  const context = shared.context;
  const page = await context.newPage();
  await page.goto(site.url);
  const store = new InMemoryStore();
  const agent = new FixtureAgent();
  const auth = createAuth({ agent, store });
  const first = await complete(
    auth.login({
      ...authTarget(shared, page),
      credentials: { username: "alice" },
      save: "yes",
      label: "Personal",
    }),
  );
  expect(first.result.status).toBe("authenticated");
  expect(await page.locator("body").innerText()).toContain(
    "Signed in as alice",
  );
  expect(page.isClosed()).toBe(false);
  const alice = (await store.list())[0]!;
  expect((await store.get(alice.id))!.credentials[0]!.values.password).toBe(
    fixturePassword,
  );
  expect(JSON.stringify(agent.observations)).not.toContain(fixturePassword);
  expect(JSON.stringify(first.snapshots)).not.toContain(fixturePassword);

  expect(
    (await complete(auth.logout(authTarget(shared, page)))).result.status,
  ).toBe("signed-out");
  expect(await store.list()).toHaveLength(1);
  await page.goto(site.url);
  const second = await complete(
    auth.login({
      ...authTarget(shared, page),
      credentials: { username: "bob", password: fixturePassword },
      label: "Work",
      save: "yes",
    }),
    (interaction) => {
      const newAccount = interaction.choices.find(
        (choice) => choice.id === "new",
      );
      return newAccount
        ? {
            kind: "choose",
            interactionId: interaction.id,
            choiceId: newAccount.id,
          }
        : defaultResponse(interaction);
    },
  );
  expect(second.result.status).toBe("authenticated");
  expect(await store.list()).toHaveLength(2);

  const switched = await complete(
    auth.switchAccount({ ...authTarget(shared, page), accountId: alice.id }),
  );
  expect(switched.result.status).toBe("authenticated");
  expect(await page.locator("body").innerText()).toContain(
    "Signed in as alice",
  );
  const logout = await complete(
    auth.logout({
      ...authTarget(shared, page),
      accountId: alice.id,
      forgetCredentials: true,
    }),
  );
  expect(logout.result).toMatchObject({
    status: "signed-out",
    deletion: "deleted",
  });
  expect(await store.get(alice.id)).toBeNull();
  expect(await store.list()).toHaveLength(1);

  await page.goto(site.url);
  const reuse = await complete(
    auth.login({ ...authTarget(shared, page), save: "never" }),
  );
  expect(reuse.result.status).toBe("authenticated");
  expect(
    reuse.snapshots.some(
      (snapshot) =>
        snapshot.status === "waiting" &&
        snapshot.interaction.kind === "form" &&
        snapshot.interaction.message === "Choose a saved login",
    ),
  ).toBe(true);
  expect(await page.locator("body").innerText()).toContain("Signed in as bob");
  await context.close();
});

it("does not save supplied credentials when already signed in or when rejected", async () => {
  const context = shared.context;
  await context.addCookies([
    { name: "account", value: "alice", url: site.url },
  ]);
  const page = await context.newPage();
  await page.goto(site.url);
  const store = new InMemoryStore();
  const auth = createAuth({ agent: new FixtureAgent(), store });
  const already = await complete(
    auth.login({
      ...authTarget(shared, page),
      credentials: { password: "unused-secret" },
      save: "yes",
    }),
  );
  expect(already.result).toEqual({
    status: "authenticated",
    save: { status: "not-saved" },
  });
  expect(await store.list()).toEqual([]);
  await context.clearCookies();
  await page.goto(site.url);
  const rejected = await complete(
    auth.login({
      ...authTarget(shared, page),
      credentials: { username: "alice", password: "wrong-fixture-value" },
      save: "yes",
    }),
  );
  expect(rejected.result).toMatchObject({
    status: "failed",
    error: { code: "rejected" },
  });
  expect(await store.list()).toEqual([]);
  await context.close();
});

it("does not claim the requested account when a different native account is selected", async () => {
  const context = shared.context;
  const page = await context.newPage();
  await context.addCookies([
    { name: "account", value: "alice", url: site.url },
  ]);
  await page.goto(site.url);
  const store = new InMemoryStore();
  await store.save({
    id: "alice",
    label: "Personal Alice",
    serviceOrigins: [site.url],
    credentialOrigins: [site.url],
    credentials: [],
  });
  const auth = createAuth({ agent: new FixtureAgent(), store });
  let checkedIdentity = false;
  const run = await complete(
    auth.switchAccount({ ...authTarget(shared, page), accountId: "alice" }),
    (interaction) => {
      if (
        interaction.kind === "confirm" &&
        interaction.confirmation.kind === "confirm-account-switch"
      ) {
        expect(interaction.confirmation.accountLabel).toBe("Personal Alice");
        checkedIdentity = true;
        return {
          kind: "choose",
          interactionId: interaction.id,
          choiceId: "no",
        };
      }
      const bob = interaction.choices.find(
        (choice) => choice.label === "Work Bob",
      );
      return bob
        ? { kind: "choose", interactionId: interaction.id, choiceId: bob.id }
        : defaultResponse(interaction);
    },
  );
  expect(checkedIdentity).toBe(true);
  expect(await page.locator("body").innerText()).toContain("Signed in as bob");
  expect(run.result.status).toBe("unknown");
  expect(run.result).not.toHaveProperty("accountId");
  await context.close();
});

it("supports multi-step input, website Back and manual OTP without storing the code", async () => {
  const context = shared.context;
  const page = await context.newPage();
  await page.goto(`${site.url}/multi`);
  const store = new InMemoryStore();
  const auth = createAuth({ agent: new FixtureAgent(), store });
  let wentBack = false;
  const run = await complete(
    auth.login({
      ...authTarget(shared, page),
      credentials: { phone: "+15551112222" },
      save: "yes",
    }),
    (interaction) => {
      const back = interaction.choices.find((choice) => choice.kind === "back");
      if (back && !wentBack) {
        wentBack = true;
        return {
          kind: "choose",
          interactionId: interaction.id,
          choiceId: back.id,
        };
      }
      return defaultResponse(interaction);
    },
  );
  expect(wentBack).toBe(true);
  expect(run.result.status).toBe("authenticated");
  await context.clearCookies();
  await page.goto(`${site.url}/otp`);
  const codeStore = new InMemoryStore();
  const otp = await complete(
    createAuth({ agent: new FixtureAgent(), store: codeStore }).login({
      ...authTarget(shared, page),
      save: "yes",
    }),
  );
  expect(otp.result.status).toBe("authenticated");
  expect(await codeStore.list()).toEqual([]);
  expect(JSON.stringify(otp.snapshots)).not.toContain(fixtureCode);
  await context.close();
});

it("binds cross-origin iframe credentials to the actual identity origin", async () => {
  const identity = await startAuthSite();
  const context = shared.context;
  const page = await context.newPage();
  await page.goto(
    `${site.url}/frame?origin=${encodeURIComponent(identity.url)}`,
  );
  const store = new InMemoryStore();
  const run = await complete(
    createAuth({ agent: new FixtureAgent(), store }).login({
      ...authTarget(shared, page),
      save: "yes",
    }),
  );
  expect(run.result.status).toBe("authenticated");
  const record = (await store.get((await store.list())[0]!.id))!;
  expect(record.serviceOrigins).toEqual([site.url]);
  expect(record.credentialOrigins).toEqual([identity.url]);
  expect(
    run.snapshots.some(
      (snapshot) =>
        snapshot.status === "waiting" &&
        snapshot.interaction.kind === "confirm" &&
        snapshot.interaction.confirmation.kind === "use-credentials" &&
        snapshot.interaction.confirmation.origin === identity.url,
    ),
  ).toBe(true);
  await context.close();
  await identity.close();
});

it("rejects stale element handles and empty-form submit bypasses", async () => {
  const context = shared.context;
  const page = await context.newPage();
  await page.goto(site.url);
  const surface = new BrowserSurface(page, 1000);
  const observation = await surface.observe(new Redactor());
  const password = observation.elements.find(
    (element) => element.type === "password",
  )!;
  await page
    .locator("input[type=password]")
    .evaluate((node) => node.replaceWith(node.cloneNode()));
  await expect(
    surface.fill(
      password.id,
      "never-written",
      site.url,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(await page.locator("input[type=password]").inputValue()).toBe("");
  const before = site.submissions.length;
  const auth = createAuth({
    agent: {
      async next(observation) {
        return {
          kind: "form",
          fields: [],
          choices: [],
          submitElementId: observation.elements.find(
            (element) => element.tag === "button",
          )!.id,
        };
      },
    },
  });
  const run = await complete(auth.login(authTarget(shared, page)));
  expect(run.result).toMatchObject({
    status: "failed",
    error: { code: "invalid_submit" },
  });
  expect(site.submissions.length).toBe(before);
  await surface.clear();
  await context.close();
});

it("keeps successful login separate from storage failures and records only safe trace attributes", async () => {
  const context = shared.context;
  const page = await context.newPage();
  await page.goto(site.url);
  const traces: Array<{
    operation: string;
    steps: number[];
    actions: string[];
    status?: string;
  }> = [];
  const store = new InMemoryStore();
  store.save = async () => {
    throw new Error(`private error ${fixturePassword}`);
  };
  const auth = createAuth({
    agent: new FixtureAgent(),
    store,
    tracer: {
      startFlow(operation) {
        const trace = {
          operation,
          steps: [],
          actions: [],
        } as (typeof traces)[number];
        traces.push(trace);
        return {
          step: (index) => trace.steps.push(index),
          action: (kind) => trace.actions.push(kind),
          end: (status) => {
            trace.status = status;
          },
        };
      },
    },
  });
  const run = await complete(
    auth.login({
      ...authTarget(shared, page),
      credentials: { username: "alice", password: fixturePassword },
      save: "yes",
    }),
  );
  expect(run.result).toMatchObject({
    status: "authenticated",
    save: { status: "failed", error: { code: "store_save_failed" } },
  });
  expect(traces).toHaveLength(1);
  expect(traces[0]).toMatchObject({
    operation: "login",
    status: "authenticated",
  });
  const serialized = JSON.stringify(traces);
  expect(serialized).not.toContain(fixturePassword);
  expect(serialized).not.toContain(site.url);
  expect(JSON.stringify(run)).not.toContain(fixturePassword);
  await context.close();
});

it("redacts known credentials reflected in element metadata as well as page text", async () => {
  const context = shared.context;
  const page = await context.newPage();
  await page.goto(site.url);
  const surface = new BrowserSurface(page, 1000);
  const redactor = new Redactor();
  redactor.add(fixturePassword);
  await page.locator("input[type=password]").evaluate((element, secret) => {
    element.setAttribute("autocomplete", secret);
    element.setAttribute("aria-label", secret);
  }, fixturePassword);
  const observation = await surface.observe(redactor);
  expect(observation.elements.some((element) => element.tag === "input")).toBe(
    true,
  );
  expect(JSON.stringify(observation)).not.toContain(fixturePassword);
  await surface.clear();
  await context.close();
});

it("cancels before input without writes and keeps known authentication if save consent is cancelled", async () => {
  const context = shared.context;
  const page = await context.newPage();
  await page.goto(site.url);
  const auth = createAuth({ agent: new FixtureAgent() });
  const controller = new AbortController();
  const run = await complete(
    auth.login({ ...authTarget(shared, page), signal: controller.signal }),
    () => {
      controller.abort();
      return null;
    },
  );
  expect(run.result.status).toBe("cancelled");
  expect(await page.locator("input[type=password]").inputValue()).toBe("");
  const saving = new AbortController();
  const loggedIn = await complete(
    auth.login({
      ...authTarget(shared, page),
      credentials: { username: "alice", password: fixturePassword },
      signal: saving.signal,
      save: "ask",
    }),
    (interaction) => {
      if (
        interaction.kind === "confirm" &&
        interaction.confirmation.kind === "save-credentials"
      ) {
        saving.abort();
        return null;
      }
      return defaultResponse(interaction);
    },
  );
  expect(loggedIn.result).toMatchObject({
    status: "authenticated",
    save: { status: "not-saved" },
  });
  await context.close();
});
