import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { InMemoryStore } from "../../packages/browser-auth/src/index.js";
import { createAuthWithAgent as createAuth } from "../../packages/browser-auth/src/auth.js";
import type {
  AuthAgent,
  AuthObservation,
  AuthProposal,
} from "../../packages/browser-auth/src/agent/proposals.js";
import { FixtureAgent } from "../helpers/scripted-agent.js";
import {
  authTarget,
  launchSharedBrowser,
  type SharedBrowser,
} from "../helpers/browser.js";
import { complete, defaultResponse } from "../helpers/respond.js";

const password = "fixture-password-only-73";

async function startAttemptSite() {
  const submissions: Array<Record<string, string>> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const body = async () => {
      let value = "";
      for await (const chunk of req) value += chunk;
      return Object.fromEntries(new URLSearchParams(value));
    };
    const html = (content: string) => {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><title>Attempts</title><body>${content}</body>`);
    };
    const redirect = (location: string) => {
      res.writeHead(303, { location });
      res.end();
    };
    const dashboard = () =>
      html(
        "<h1>Dashboard</h1><p>Signed in as alice</p><a href='/accounts'>Switch account</a><a href='/add-email'>Add account</a>",
      );

    if (url.pathname === "/abort")
      html(
        "<h1>Dashboard</h1><p>Signed in as alice</p><a href='/abort-accounts'>Switch account</a><a href='/add-abort'>Add account</a>",
      );
    else if (url.pathname === "/abort-accounts")
      html(
        "<h1>Choose account</h1><a href='/switch-b'>Work B</a><a href='/add-abort'>Add another account</a>",
      );
    else if (url.pathname === "/add-abort")
      html(
        "<h1>Add another account</h1><form method=post action=/abort-challenge><label>Email<input name=email type=email></label><label>Password<input name=password type=password></label><button>Add</button></form><a href=/accounts>Back</a>",
      );
    else if (url.pathname === "/abort-challenge") {
      submissions.push(await body());
      html("<h1>Pending verification</h1><a href=/accounts>Back</a>");
    } else if (url.pathname === "/accounts")
      html(
        "<h1>Choose account</h1><a href='/switch-b'>Work B</a><a href='/add-email'>Add another account</a>",
      );
    else if (url.pathname === "/switch-b")
      html("<h1>Switched</h1><p>Signed in as B</p>");
    else if (url.pathname === "/expired")
      html(
        "<h1>Dashboard</h1><p>Session expired for B</p><a href='/reauth'>Reauthenticate B</a><a href='/accounts'>Switch account menu</a>",
      );
    else if (url.pathname === "/reauth")
      html(
        "<h1>Reauthenticate B</h1><form method=post action=/reauth-done><label>Password<input name=password type=password autocomplete=current-password></label><button>Continue</button></form>",
      );
    else if (url.pathname === "/reauth-done" && req.method === "POST") {
      submissions.push(await body());
      html("<h1>Switched</h1><p>Session preserved for B</p>");
    } else if (url.pathname === "/add-email")
      html(
        `<h1>Add email</h1><form action=/add-password><label>Email<input name=email type=email autocomplete=username></label><button>Continue</button></form>${url.searchParams.has("return") ? "<a href=/accounts>Cancel</a>" : ""}`,
      );
    else if (url.pathname === "/add-password") {
      const email = url.searchParams.get("email") ?? "";
      html(
        `<h1>Add password</h1><p>Email ${email}</p><form method=post action=/added?email=${encodeURIComponent(email)}><label>Password<input name=password type=password autocomplete=current-password></label><button>Add</button></form><a href='/add-email?return=1'>Back</a>`,
      );
    } else if (url.pathname === "/added" && req.method === "POST") {
      submissions.push({
        email: url.searchParams.get("email") ?? "",
        ...(await body()),
      });
      html("<h1>Added account</h1><p>Signed in</p>");
    } else if (url.pathname === "/popup")
      html(
        `<h1>Service sign in</h1><a target=idp href="/idp?close=${url.searchParams.get("close") === "1" ? "1" : "0"}">Continue with SSO</a>`,
      );
    else if (url.pathname === "/idp")
      html(
        `<h1>Identity provider</h1><button id=complete>Complete SSO</button><script>document.querySelector('#complete').onclick=()=>{opener.location.href='/popup-done';${url.searchParams.get("close") === "1" ? "close()" : "document.body.innerHTML='<h1>Provider complete</h1>'"}}</script>`,
      );
    else if (url.pathname === "/popup-done")
      html("<h1>Authenticated service</h1><p>SSO complete</p>");
    else if (url.pathname === "/method-start")
      html("<h1>Dashboard</h1><a href=/challenge>Add account</a>");
    else if (url.pathname === "/challenge")
      html("<h1>Challenge</h1><a href=/methods>Back</a>");
    else if (url.pathname === "/methods")
      html("<h1>Choose method</h1><a href=/challenge-done>Continue</a>");
    else if (url.pathname === "/challenge-done") html("<h1>Added account</h1>");
    else if (url.pathname === "/") dashboard();
    else redirect("/");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    submissions,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

class AttemptAgent extends FixtureAgent {
  override async next(observation: AuthObservation): Promise<AuthProposal> {
    if (observation.text.includes("Session expired")) {
      const link = observation.elements.find(
        (element) => element.label === "Reauthenticate B",
      )!;
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
          { elementId: link.id, label: link.label, intent: "switch" },
        ],
      };
    }
    if (observation.text.includes("Added account"))
      return {
        kind: "done",
        outcome:
          observation.operation === "choose-account"
            ? "account-changed"
            : "authenticated",
      };
    const fields = observation.elements.filter(
      (element) => element.tag === "input",
    );
    if (fields.length)
      return {
        kind: "ask_user",
        message: "Enter details",
        external: false,
        fields: fields.map((element) => ({
          elementId: element.id,
          key: element.label.trim().toLowerCase(),
          label: element.label,
          type:
            element.type === "password"
              ? "password"
              : element.type === "email"
                ? "email"
                : "text",
          rejected: false,
        })),
        choices: observation.elements
          .filter((element) => element.label === "Back")
          .map((element) => ({
            elementId: element.id,
            label: element.label,
            intent: "back",
          })),
        submitElementId:
          observation.elements.find((element) => element.tag === "button")
            ?.id ?? null,
      };
    return super.next(observation);
  }
}

let shared: SharedBrowser;
let site: Awaited<ReturnType<typeof startAttemptSite>>;
beforeAll(async () => {
  site = await startAttemptSite();
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

it("discards filled saved A candidates before a native switch to B", async () => {
  const page = await shared.context.newPage();
  await page.goto(`${site.url}/abort`);
  const store = new InMemoryStore();
  await store.save({
    id: "a",
    label: "Saved A",
    serviceOrigins: [site.url],
    credentialOrigins: [site.url],
    credentials: [
      { origin: site.url, values: { email: "a@example.test", password } },
    ],
  });
  let saves = 0;
  const original = await store.get("a");
  const save = store.save.bind(store);
  store.save = async (record) => {
    saves++;
    await save(record);
  };
  saves = 0;
  const submissionsBefore = site.submissions.length;
  let added = false;
  let backed = false;
  const run = await complete(
    createAuth({
      agent: {
        async next(observation) {
          if (observation.text.includes("Pending verification"))
            return {
              kind: "ask_user",
              message: "Enter details",
              external: false,
              fields: [],
              submitElementId: null,
              choices: [
                {
                  elementId: observation.elements[0]!.id,
                  label: "Back",
                  intent: "back",
                },
              ],
            };
          return new AttemptAgent().next(observation);
        },
      },
      store,
    }).login({ ...authTarget(shared, page), save: "yes" }),
    (interaction) => {
      const choice = interaction.choices.find(
        (candidate) =>
          (!added && candidate.kind === "add") ||
          (added &&
            !backed &&
            site.submissions.length > submissionsBefore &&
            candidate.kind === "back") ||
          (backed && candidate.label === "Work B"),
      );
      if (choice) {
        if (choice.kind === "add") added = true;
        if (choice.kind === "back") backed = true;
        return {
          kind: "choose",
          interactionId: interaction.id,
          choiceId: choice.id,
        };
      }
      return defaultResponse(interaction);
    },
  );
  if (run.result.status === "failed")
    throw new Error(JSON.stringify(run.result));
  expect(run.result).toEqual({
    status: "authenticated",
    save: { status: "not-saved" },
  });
  expect(await page.locator("body").innerText()).toContain("Signed in as B");
  expect(site.submissions.slice(submissionsBefore)).toEqual([
    { email: "a@example.test", password },
  ]);
  expect(saves).toBe(0);
  expect(await store.get("a")).toEqual(original);
  expect(
    run.snapshots.some(
      (snapshot) =>
        snapshot.status === "waiting" &&
        snapshot.interaction.confirmation &&
        snapshot.interaction.confirmation.kind === "save-credentials",
    ),
  ).toBe(false);
});

it("keeps an add attempt alive across password Back and saves corrected email", async () => {
  const page = await shared.context.newPage();
  await page.goto(site.url);
  const store = new InMemoryStore();
  let backed = false;
  const run = await complete(
    createAuth({ agent: new AttemptAgent(), store }).login({
      ...authTarget(shared, page),
      credentials: { email: "wrong@example.test", password },
      save: "yes",
    }),
    (interaction) => {
      const add = interaction.choices.find((choice) => choice.kind === "add");
      const back = interaction.choices.find((choice) => choice.kind === "back");
      if (add)
        return {
          kind: "choose",
          interactionId: interaction.id,
          choiceId: add.id,
        };
      if (back && !backed) {
        backed = true;
        return {
          kind: "choose",
          interactionId: interaction.id,
          choiceId: back.id,
        };
      }
      if (
        !interaction.confirmation &&
        interaction.fields.some((field) => field.type === "email")
      )
        return {
          kind: "submit",
          interactionId: interaction.id,
          values: Object.fromEntries(
            interaction.fields.map((field) => [
              field.id,
              "corrected@example.test",
            ]),
          ),
        };
      return defaultResponse(interaction);
    },
  );
  if (run.result.status === "failed")
    throw new Error(JSON.stringify(run.result));
  expect(run.result).toMatchObject({
    status: "authenticated",
    accountId: expect.any(String),
    save: { status: "saved" },
  });
  expect(site.submissions.at(-1)).toEqual({
    email: "corrected@example.test",
    password,
  });
  const record = await store.get(
    (run.result as { accountId: string }).accountId,
  );
  expect(record?.credentials[0]?.values.email).toBe("corrected@example.test");
});

it.each(["external", "click", "empty-form"] as const)(
  "requires forward progress after Back: %s",
  async (mode) => {
    const page = await shared.context.newPage();
    await page.goto(`${site.url}/method-start`);
    let emptyFormProposed = false;
    const agent: AuthAgent = {
      async next(observation) {
        const element = observation.elements[0]!;
        if (observation.text.includes("Dashboard"))
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
              { elementId: element.id, label: "Add account", intent: "add" },
            ],
          };
        if (observation.text.includes("Challenge"))
          return {
            kind: "ask_user",
            fields: [],
            submitElementId: null,
            external: true,
            message: "Choose another method",
            choices: [{ elementId: element.id, label: "Back", intent: "back" }],
          };
        if (observation.text.includes("Choose method")) {
          if (mode === "click") return { kind: "click", elementId: element.id };
          if (mode === "external")
            return {
              kind: "ask_user",
              fields: [],
              submitElementId: null,
              external: true,
              message: "Continue",
              choices: [
                {
                  elementId: element.id,
                  label: "Continue",
                  intent: "continue",
                },
              ],
            };
          if (!emptyFormProposed) {
            emptyFormProposed = true;
            return {
              kind: "ask_user",
              message: "Enter details",
              external: false,
              fields: [],
              choices: [],
              submitElementId: null,
            };
          }
        }
        return { kind: "done", outcome: "account-changed" };
      },
    };
    const run = await complete(
      createAuth({ agent }).login(authTarget(shared, page)),
      (interaction) => {
        const choice = interaction.choices.find((item) => item.kind === "add");
        return choice
          ? {
              kind: "choose",
              interactionId: interaction.id,
              choiceId: choice.id,
            }
          : defaultResponse(interaction);
      },
    );
    expect(run.result.status).toBe(
      mode === "empty-form" ? "unknown" : "authenticated",
    );
    expect(await page.locator("h1").innerText()).toBe(
      mode === "empty-form" ? "Choose method" : "Added account",
    );
  },
);

it("allows explicit native account reauthentication fields", async () => {
  const page = await shared.context.newPage();
  await page.goto(`${site.url}/expired`);
  const run = await complete(
    createAuth({ agent: new AttemptAgent() }).login({
      ...authTarget(shared, page),
      credentials: { password },
      save: "never",
    }),
    (interaction) => {
      const reauth = interaction.choices.find(
        (choice) => choice.label === "Reauthenticate B",
      );
      return reauth
        ? { kind: "choose", interactionId: interaction.id, choiceId: reauth.id }
        : defaultResponse(interaction);
    },
  );
  if (run.result.status === "failed")
    throw new Error(JSON.stringify(run.result));
  expect(run.result).toMatchObject({ status: "authenticated" });
  expect(await page.locator("body").innerText()).toContain(
    "Session preserved for B",
  );
});

it.each(["never", "declined", "cancelled"] as const)(
  "returns a saved record id when its value was filled and saving is %s",
  async (mode) => {
    const page = await shared.context.newPage();
    await page.goto(`${site.url}/add-email`);
    const store = new InMemoryStore();
    await store.save({
      id: "saved",
      label: "Saved",
      serviceOrigins: [site.url],
      credentialOrigins: [site.url],
      credentials: [
        { origin: site.url, values: { email: "saved@example.test", password } },
      ],
    });
    const cancellation = new AbortController();
    let writes = 0;
    store.save = async () => {
      writes++;
    };
    const run = await complete(
      createAuth({ agent: new AttemptAgent(), store }).login({
        ...authTarget(shared, page),
        save: mode === "never" ? "never" : "ask",
        signal: cancellation.signal,
      }),
      (interaction) => {
        if (
          interaction.confirmation &&
          interaction.confirmation.kind === "save-credentials"
        ) {
          if (mode === "cancelled") {
            cancellation.abort();
            return null;
          }
          return {
            kind: "choose",
            interactionId: interaction.id,
            choiceId: "no",
          };
        }
        return defaultResponse(interaction);
      },
    );
    expect(run.result).toMatchObject({
      status: "authenticated",
      accountId: "saved",
      save: { status: "not-saved" },
    });
    expect(writes).toBe(0);
  },
);

it("omits a saved record id when every selected value is overridden", async () => {
  const page = await shared.context.newPage();
  await page.goto(`${site.url}/add-email`);
  const store = new InMemoryStore();
  await store.save({
    id: "saved",
    label: "Saved",
    serviceOrigins: [site.url],
    credentialOrigins: [site.url],
    credentials: [
      { origin: site.url, values: { email: "saved@example.test", password } },
    ],
  });
  const run = await complete(
    createAuth({ agent: new AttemptAgent(), store }).login({
      ...authTarget(shared, page),
      credentials: {
        email: "override@example.test",
        password: "override-password",
      },
      save: "never",
    }),
  );
  expect(run.result).toMatchObject({
    status: "authenticated",
    save: { status: "not-saved" },
  });
  expect(run.result).not.toHaveProperty("accountId");
});

it.each([false, true])(
  "completes %s-closing SSO popups without closing borrowed pages",
  async (autoClose) => {
    const page = await shared.context.newPage();
    await page.goto(`${site.url}/popup?close=${autoClose ? "1" : "0"}`);
    const pagesBefore = new Set(shared.context.pages());
    const agent: AuthAgent = {
      async next(observation) {
        if (observation.opener?.text.includes("SSO complete"))
          return { kind: "opener" };
        if (observation.text.includes("Authenticated service"))
          return { kind: "done", outcome: "authenticated" };
        const button = observation.elements.find(
          (element) => element.tag === "button" || element.tag === "a",
        );
        if (!button) return { kind: "wait", milliseconds: 150 };
        return {
          kind: "ask_user",
          message: "Continue with SSO",
          fields: [],
          submitElementId: null,
          external: false,
          choices: [
            { elementId: button.id, label: button.label, intent: "continue" },
          ],
        };
      },
    };
    const run = await complete(
      createAuth({ agent, limits: { maxSteps: 8 } }).login(
        authTarget(shared, page),
      ),
    );
    expect(run.result.status).toBe("authenticated");
    expect(page.isClosed()).toBe(false);
    const popup = shared.context
      .pages()
      .find((candidate) => !pagesBefore.has(candidate));
    if (autoClose) expect(popup?.isClosed() ?? true).toBe(true);
    else expect(popup?.isClosed()).toBe(false);
  },
);
