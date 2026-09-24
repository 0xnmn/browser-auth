import { expect, it } from "vitest";
import { createAuthWithAgent as createAuth } from "../../packages/browser-auth/src/auth.js";
import { startAuthSite } from "../fixtures/auth-site.js";
import { launchSharedBrowser } from "../helpers/browser.js";
import { FixtureAgent } from "../helpers/scripted-agent.js";
import { complete, defaultResponse } from "../helpers/respond.js";

async function targetId(
  context: Awaited<ReturnType<typeof launchSharedBrowser>>["context"],
  page: Parameters<typeof context.newCDPSession>[0],
): Promise<string> {
  const session = await context.newCDPSession(page);
  try {
    return (await session.send("Target.getTargetInfo")).targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

it("reauthenticates the exact shared CDP tab without taking ownership of the caller browser", async () => {
  const site = await startAuthSite();
  let shared: Awaited<ReturnType<typeof launchSharedBrowser>> | undefined;
  try {
    shared = await launchSharedBrowser();
    const { context, cdpUrl } = shared;
    await context.addCookies([
      { name: "caller-state", value: "preserved", url: site.url },
    ]);
    const unrelated = await context.newPage();
    await unrelated.goto(`${site.url}/multi`);
    const target = await context.newPage();
    await target.goto(`${site.url}/?reauth=1`);

    const run = await complete(
      createAuth({ agent: new FixtureAgent() }).login({
        cdpUrl,
        url: target.url(),
        save: "never",
      }),
    );

    expect(run.result.status).toBe("authenticated");
    expect(await target.locator("body").innerText()).toContain(
      "Signed in as alice",
    );
    expect(unrelated.url()).toBe(`${site.url}/multi`);
    expect(await unrelated.locator("h1").innerText()).toBe("Sign in");
    expect(
      (await context.cookies(site.url)).find(
        (cookie) => cookie.name === "caller-state",
      )?.value,
    ).toBe("preserved");

    // The SDK's CDP connection has disconnected, but the owner that launched Chromium still works.
    expect(target.isClosed()).toBe(false);
    const afterDisconnect = await context.newPage();
    await afterDisconnect.goto(`${site.url}/multi`);
    expect(await afterDisconnect.title()).toBe("Auth fixture");
  } finally {
    await shared?.close();
    await site.close().catch(() => {});
  }
});

it("asks which same-origin CDP tab to use and authenticates the selected second tab", async () => {
  const site = await startAuthSite();
  let shared: Awaited<ReturnType<typeof launchSharedBrowser>> | undefined;
  try {
    shared = await launchSharedBrowser();
    const first = await shared.context.newPage();
    const second = await shared.context.newPage();
    await first.goto(`${site.url}/?tab=first`);
    await second.goto(`${site.url}/?tab=second`);
    await first.evaluate(() => {
      document.title = "First workflow";
    });
    await second.evaluate(() => {
      document.title = "Second workflow";
    });

    let choseTab = false;
    const run = await complete(
      createAuth({ agent: new FixtureAgent() }).login({
        cdpUrl: shared.cdpUrl,
        url: `${site.url}/not-an-exact-match`,
        save: "never",
      }),
      (interaction) => {
        if (
          interaction.kind === "form" &&
          interaction.message === "Choose the existing tab to authenticate"
        ) {
          choseTab = true;
          return {
            kind: "choose",
            interactionId: interaction.id,
            choiceId: interaction.choices.find((choice) =>
              choice.label.includes("Second workflow"),
            )!.id,
          };
        }
        return defaultResponse(interaction);
      },
    );

    expect(choseTab).toBe(true);
    expect(run.result.status).toBe("authenticated");
    expect(await second.locator("body").innerText()).toContain(
      "Signed in as alice",
    );
    expect(first.url()).toBe(`${site.url}/?tab=first`);
    expect(await first.locator("input[type=password]").isVisible()).toBe(true);
  } finally {
    await shared?.close();
    await site.close().catch(() => {});
  }
});

it("uses targetId to select one of two tabs with identical URLs", async () => {
  const site = await startAuthSite();
  const shared = await launchSharedBrowser();
  try {
    const first = await shared.context.newPage();
    const second = await shared.context.newPage();
    await first.goto(site.url);
    await second.goto(site.url);

    const run = await complete(
      createAuth({ agent: new FixtureAgent() }).login({
        cdpUrl: shared.cdpUrl,
        url: site.url,
        targetId: await targetId(shared.context, second),
        save: "never",
      }),
    );

    expect(run.result.status).toBe("authenticated");
    expect(await second.locator("body").innerText()).toContain(
      "Signed in as alice",
    );
    expect(await first.locator("input[type=password]").isVisible()).toBe(true);
  } finally {
    await shared.close();
    await site.close();
  }
});

it("does not fall back when targetId is missing or belongs to another origin", async () => {
  const site = await startAuthSite();
  const other = await startAuthSite();
  const shared = await launchSharedBrowser();
  try {
    const requested = await shared.context.newPage();
    await requested.goto(site.url);
    const wrongOrigin = await shared.context.newPage();
    await wrongOrigin.goto(other.url);
    const auth = createAuth({ agent: new FixtureAgent() });

    const missing = await complete(
      auth.login({
        cdpUrl: shared.cdpUrl,
        url: site.url,
        targetId: "00000000000000000000000000000000",
        save: "never",
      }),
    );
    expect(missing.result).toMatchObject({
      status: "failed",
      error: { code: "target_not_found" },
    });

    const mismatch = await complete(
      auth.login({
        cdpUrl: shared.cdpUrl,
        url: site.url,
        targetId: await targetId(shared.context, wrongOrigin),
        save: "never",
      }),
    );
    expect(mismatch.result).toMatchObject({
      status: "failed",
      error: { code: "target_origin_mismatch" },
    });
    expect(await requested.locator("input[type=password]").isVisible()).toBe(
      true,
    );
  } finally {
    await shared.close();
    await site.close();
    await other.close();
  }
});
