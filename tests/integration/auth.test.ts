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

it.each([false, true])(
  "discovers nested account menus before prompting (logout only: %s)",
  async (logoutOnly) => {
    const page = await shared.context.newPage();
    await shared.context.addCookies([
      { name: "account", value: "alice", url: site.url },
    ]);
    await page.goto(site.url);
    await page.setContent(`<h1>Signed in as alice</h1>
    <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true'); document.querySelector('#menu').hidden=false">Profile</button>
    <div id="menu" hidden><button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true'); document.querySelector('#entries').hidden=false">More accounts</button>
    <div id="entries" hidden><a role="menuitem" href="/logout">Sign out</a>${logoutOnly ? "" : '<a role="menuitem" href="/switch?to=bob">Work Bob</a><a role="menuitem" href="/add-account">Add account</a>'}</div></div>`);
    let observations = 0;
    let prompts = 0;
    const run = await complete(
      createAuth({
        agent: {
          async next(observation) {
            observations++;
            const menu = observation.elements.find(
              (element) => element.expanded === false,
            );
            if (menu) return { kind: "click", elementId: menu.id };
            expect(
              observation.elements.filter(
                (element) => element.expanded === true,
              ),
            ).toHaveLength(2);
            return {
              kind: "ask_user",
              message: "Choose an account",
              fields: [],
              submitElementId: null,
              external: false,
              choices: [
                {
                  elementId: "finish",
                  label: "Keep using this account",
                  intent: "finish",
                },
                ...observation.elements
                  .filter((element) => element.tag === "a")
                  .map((element) => ({
                    elementId: element.id,
                    label: element.label,
                    intent:
                      element.label === "Sign out"
                        ? ("logout" as const)
                        : element.label === "Work Bob"
                          ? ("switch" as const)
                          : ("add" as const),
                  })),
              ],
            };
          },
        },
      }).login(authTarget(shared, page)),
      (interaction) => {
        prompts++;
        expect(observations).toBe(3);
        expect(interaction.fields).toEqual([]);
        expect(interaction.choices.map((choice) => choice.kind)).toEqual(
          logoutOnly
            ? ["finish", "logout"]
            : ["finish", "logout", "switch", "add"],
        );
        return defaultResponse(interaction);
      },
    );
    expect(prompts).toBe(1);
    expect(run.result).toEqual({ status: "already-signed-in" });
    expect(
      (await shared.context.cookies()).find(
        (cookie) => cookie.name === "account",
      )?.value,
    ).toBe("alice");
    expect(new URL(page.url()).pathname).toBe("/");
  },
);

it.each(["navigation", "method-choice"] as const)(
  "automates navigation but preserves intentional choices: %s",
  async (mode) => {
    const page = await shared.context.newPage();
    await page.goto(`${site.url}/logout`);
    const fixture = new FixtureAgent();
    let choseMethod = false;
    const run = await complete(
      createAuth({
        agent: {
          async next(observation) {
            if (observation.text.includes("Signed out")) {
              const link = observation.elements.find(
                (element) => element.label === "Sign in",
              )!;
              return mode === "navigation"
                ? { kind: "click", elementId: link.id }
                : {
                    kind: "ask_user",
                    message: "Enter details",
                    external: false,
                    fields: [],
                    submitElementId: null,
                    choices: [
                      {
                        elementId: link.id,
                        label: "Use password",
                        intent: "continue",
                      },
                    ],
                  };
            }
            return fixture.next(observation);
          },
        },
      }).login({
        ...authTarget(shared, page),
        credentials: { username: "alice", password: fixturePassword },
        save: "ask",
      }),
      async (interaction) => {
        if (!interaction.confirmation) {
          expect(mode).toBe("method-choice");
          expect(interaction.choices).toHaveLength(1);
          expect(interaction.choices[0]?.label).toBe("Use password");
          expect(await page.locator("h1").innerText()).toBe("Signed out");
          choseMethod = true;
        } else {
          expect(interaction.confirmation).toBeDefined();
        }
        return defaultResponse(interaction);
      },
    );
    expect(run.result.status).toBe("authenticated");
    expect(await page.locator("body").innerText()).toContain(
      "Signed in as alice",
    );
    expect(choseMethod).toBe(mode === "method-choice");
    expect(
      run.snapshots.flatMap((snapshot) =>
        snapshot.status === "waiting" && snapshot.interaction.confirmation
          ? [snapshot.interaction.confirmation.kind]
          : [],
      ),
    ).toEqual(["use-credentials", "save-credentials"]);
  },
);

it("uses one login flow for native session actions", async () => {
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

  const added = await complete(
    auth.login({
      ...authTarget(shared, page),
      credentials: { username: "bob", password: fixturePassword },
      label: "Work",
      save: "yes",
    }),
    (interaction) => {
      const add = interaction.choices.find((choice) => choice.kind === "add");
      if (add) {
        expect(interaction.choices.map((choice) => choice.label)).toEqual(
          expect.arrayContaining([
            "Sign out",
            "Work Bob",
            "Add another account",
          ]),
        );
      }
      return add
        ? { kind: "choose", interactionId: interaction.id, choiceId: add.id }
        : !interaction.confirmation &&
            interaction.message === "Choose a saved login"
          ? { kind: "choose", interactionId: interaction.id, choiceId: "new" }
          : defaultResponse(interaction);
    },
  );
  expect(added.result).toMatchObject({
    status: "authenticated",
    accountId: expect.any(String),
    save: { status: "saved" },
  });
  expect(await page.locator("body").innerText()).toContain(
    "Signed accounts: alice,bob",
  );
  expect(await store.list()).toHaveLength(2);
  await page.goto(`${site.url}/accounts`);
  expect(await page.locator("body").innerText()).toContain("Personal Alice");
  expect(await page.locator("body").innerText()).toContain("Work Bob");
  await page.goto(site.url);

  const switched = await complete(
    auth.login({ ...authTarget(shared, page) }),
    (interaction) => {
      const alice = interaction.choices.find(
        (choice) => choice.label === "Personal Alice",
      );
      const choice = alice;
      return choice
        ? { kind: "choose", interactionId: interaction.id, choiceId: choice.id }
        : defaultResponse(interaction);
    },
  );
  expect(switched.result.status).toBe("authenticated");
  expect(switched.result).not.toHaveProperty("accountId");
  expect(await page.locator("body").innerText()).toContain(
    "Signed in as alice",
  );
  const logout = await complete(
    auth.login({
      ...authTarget(shared, page),
      accountId: alice.id,
      forgetCredentials: true,
    }),
    (interaction) => {
      const logout = interaction.choices.find(
        (choice) => choice.kind === "logout",
      );
      return logout
        ? { kind: "choose", interactionId: interaction.id, choiceId: logout.id }
        : defaultResponse(interaction);
    },
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
        snapshot.interaction.confirmation === undefined &&
        snapshot.interaction.message === "Choose a saved login",
    ),
  ).toBe(true);
  expect(await page.locator("body").innerText()).toContain("Signed in as bob");
  await context.close();
});

it("finishes an existing session without mutation or credential reads", async () => {
  const context = shared.context;
  await context.addCookies([
    { name: "account", value: "alice", url: site.url },
  ]);
  const page = await context.newPage();
  await page.goto(site.url);
  const store = new InMemoryStore();
  let reads = 0;
  const originalList = store.list.bind(store);
  const originalGet = store.get.bind(store);
  store.list = async (...args) => {
    reads++;
    return originalList(...args);
  };
  store.get = async (...args) => {
    reads++;
    return originalGet(...args);
  };
  const auth = createAuth({
    agent: new FixtureAgent(),
    store,
  });
  const already = await complete(
    auth.login({
      ...authTarget(shared, page),
      credentials: { password: "unused-secret" },
      save: "yes",
    }),
  );
  expect(already.result).toEqual({ status: "already-signed-in" });
  expect(
    already.snapshots.some(
      (snapshot) =>
        snapshot.status === "waiting" &&
        snapshot.interaction.confirmation === undefined &&
        snapshot.interaction.fields.length === 0 &&
        snapshot.interaction.choices.some((choice) => choice.kind === "finish"),
    ),
  ).toBe(true);
  expect(
    (await context.cookies()).find((cookie) => cookie.name === "account")
      ?.value,
  ).toBe("alice");
  expect(await page.locator("h1").innerText()).toBe("Choose account");
  expect(reads).toBe(0);
  expect(await originalList()).toEqual([]);
  await context.clearCookies();
  await page.goto(site.url);
  const rejected = await complete(
    createAuth({ agent: new FixtureAgent(), store }).login({
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

it("selects a native existing account from the same flow", async () => {
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
  const run = await complete(
    auth.login({ ...authTarget(shared, page) }),
    (interaction) => {
      const bob = interaction.choices.find(
        (choice) => choice.label === "Work Bob",
      );
      const choice = bob;
      return choice
        ? { kind: "choose", interactionId: interaction.id, choiceId: choice.id }
        : defaultResponse(interaction);
    },
  );
  expect(await page.locator("body").innerText()).toContain("Signed in as bob");
  expect(run.result.status).toBe("authenticated");
  expect(run.result).not.toHaveProperty("accountId");
  await context.close();
});

it("does not invent missing website session capabilities", async () => {
  const context = shared.context;
  await context.addCookies([
    { name: "account", value: "alice", url: site.url },
  ]);
  const page = await context.newPage();
  await page.goto(`${site.url}/unsupported`);
  const before = site.submissions.length;
  const run = await complete(
    createAuth({ agent: new FixtureAgent() }).login(authTarget(shared, page)),
    (interaction) => {
      expect(interaction.fields).toEqual([]);
      expect(interaction.choices.map((choice) => choice.kind)).toEqual([
        "finish",
        "logout",
      ]);
      return defaultResponse(interaction);
    },
  );
  expect(run.result).toEqual({ status: "already-signed-in" });
  expect(await page.locator("body").innerText()).toContain(
    "Signed in as alice",
  );
  expect(site.submissions).toHaveLength(before);
  await context.close();
});

it.each(["logout", "finish", "reload", "replace", "clone"])(
  "refreshes stale session choice %s without replaying it",
  async (change) => {
    const context = shared.context;
    await context.addCookies([
      { name: "account", value: "alice", url: site.url },
    ]);
    const page = await context.newPage();
    await page.goto(site.url);
    const flow = createAuth({
      agent:
        change === "logout" || change === "clone"
          ? new FixtureAgent()
          : {
              next: async () => ({
                kind: "ask_user" as const,
                message: "Choose an account",
                fields: [],
                choices: [
                  {
                    elementId: "finish",
                    label: "Keep using this account",
                    intent: "finish" as const,
                  },
                ],
                submitElementId: null,
                external: false,
              }),
            },
    }).login(authTarget(shared, page));
    const iterator = flow.updates()[Symbol.asyncIterator]();
    let snapshot = await iterator.next();
    while (!snapshot.done && snapshot.value.status !== "waiting")
      snapshot = await iterator.next();
    expect(snapshot.done).toBe(false);
    if (snapshot.done || snapshot.value.status !== "waiting")
      throw new Error("missing interaction");
    const interaction = snapshot.value.interaction;
    const selected = interaction.choices.find(
      (choice) =>
        choice.kind ===
        (change === "logout" || change === "clone" ? "logout" : "finish"),
    )!;
    if (change === "reload") await page.reload();
    else if (change === "replace") await page.setContent("<h1>Signed out</h1>");
    else if (change === "clone")
      await page
        .getByText("Sign out", { exact: true })
        .evaluate((element) => element.replaceWith(element.cloneNode(true)));
    else await page.goto(`${site.url}/unsupported`);
    await flow.respond({
      kind: "choose",
      interactionId: interaction.id,
      choiceId: selected.id,
    });
    snapshot = await iterator.next();
    while (!snapshot.done && snapshot.value.status !== "waiting")
      snapshot = await iterator.next();
    if (snapshot.done || snapshot.value.status !== "waiting")
      throw new Error("missing refreshed interaction");
    const refreshed = snapshot.value.interaction;
    expect(refreshed.id).not.toBe(interaction.id);
    await expect(
      flow.respond({
        kind: "choose",
        interactionId: interaction.id,
        choiceId: selected.id,
      }),
    ).rejects.toThrow("stale_interaction");
    await flow.respond({
      kind: "choose",
      interactionId: refreshed.id,
      choiceId: refreshed.choices.find((choice) => choice.kind === "finish")!
        .id,
    });
    expect(await flow.result).toEqual({ status: "already-signed-in" });
    expect(
      (await context.cookies()).find((cookie) => cookie.name === "account")
        ?.value,
    ).toBe("alice");
    await iterator.return?.();
    await context.close();
  },
);

it.each(["completion", "credentials", "logout"])(
  "keeps menu discovery separate from %s",
  async (next) => {
    const page = await shared.context.newPage();
    await shared.context.addCookies([
      { name: "account", value: "alice", url: site.url },
    ]);
    await page.goto(site.url);
    const store = new InMemoryStore();
    let reads = 0;
    store.list = async () => {
      reads++;
      return [];
    };
    const agent = new FixtureAgent();
    const run = await complete(
      createAuth({
        store,
        agent: {
          async next(observation) {
            if (observation.text.includes("Choose account")) {
              if (next === "completion")
                return { kind: "done", outcome: "account-changed" };
              if (next === "credentials")
                return {
                  kind: "ask_user",
                  message: "Enter details",
                  external: false,
                  fields: [
                    {
                      elementId: "fake",
                      key: "password",
                      label: "Password",
                      type: "password",
                      rejected: false,
                    },
                  ],
                  choices: [],
                  submitElementId: null,
                };
              return {
                kind: "ask_user",
                message: "Choose an account",
                fields: [],
                submitElementId: null,
                external: false,
                choices: [
                  {
                    elementId: "finish",
                    label: "Keep using this account",
                    intent: "finish",
                  },
                  {
                    elementId: observation.elements.find(
                      (element) => element.label === "Sign out",
                    )!.id,
                    label: "Sign out",
                    intent: "logout",
                  },
                ],
              };
            }
            return agent.next(observation);
          },
        },
      }).login(authTarget(shared, page)),
      (interaction) => {
        const selected = interaction.choices.find(
          (choice) => choice.kind === "logout",
        );
        return selected
          ? {
              kind: "choose",
              interactionId: interaction.id,
              choiceId: selected.id,
            }
          : defaultResponse(interaction);
      },
    );
    expect(run.result).toMatchObject(
      next === "completion"
        ? { status: "unknown" }
        : next === "credentials"
          ? { status: "failed", error: { code: "stale_page" } }
          : { status: "signed-out" },
    );
    expect(reads).toBe(0);
    expect(
      (await shared.context.cookies()).find(
        (cookie) => cookie.name === "account",
      )?.value,
    ).toBe(next === "logout" ? undefined : "alice");
  },
);

it("does not complete account addition after Back", async () => {
  const page = await shared.context.newPage();
  await shared.context.addCookies([
    { name: "account", value: "alice", url: site.url },
  ]);
  await page.goto(site.url);
  const agent = new FixtureAgent();
  const before = site.submissions.length;
  const run = await complete(
    createAuth({
      agent: {
        async next(observation) {
          if (observation.text.includes("Choose account"))
            return { kind: "done", outcome: "account-changed" };
          if (observation.text.includes("Add another account"))
            return {
              kind: "ask_user",
              message: "Enter details",
              external: false,
              fields: [],
              submitElementId: null,
              choices: [
                {
                  elementId: observation.elements.find(
                    (element) => element.label === "Back",
                  )!.id,
                  label: "Back",
                  intent: "back",
                },
              ],
            };
          return agent.next(observation);
        },
      },
    }).login(authTarget(shared, page)),
    (interaction) => {
      const selected = interaction.choices.find(
        (choice) => choice.kind === "add" || choice.kind === "back",
      );
      return selected
        ? {
            kind: "choose",
            interactionId: interaction.id,
            choiceId: selected.id,
          }
        : defaultResponse(interaction);
    },
  );
  expect(run.result.status).toBe("unknown");
  expect(site.submissions).toHaveLength(before);
  expect(
    (await shared.context.cookies()).find((cookie) => cookie.name === "account")
      ?.value,
  ).toBe("alice");
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
        snapshot.interaction.confirmation &&
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
          kind: "ask_user",
          message: "Enter details",
          external: false,
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
        interaction.confirmation &&
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
