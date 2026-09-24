import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import type { BrowserContext } from "playwright-core";
import { expect, it } from "vitest";
import { createAuth } from "../../packages/browser-auth/src/index.js";
import { startAuthSite } from "../fixtures/auth-site.js";
import { FixtureAgent } from "../helpers/scripted-agent.js";
import { complete, defaultResponse } from "../helpers/respond.js";

async function readCdpUrl(profile: string): Promise<string> {
  const activePort = join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const [port] = (await readFile(activePort, "utf8")).split("\n");
      if (port) return `http://127.0.0.1:${port}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(25);
  }
  throw new Error("Chromium did not publish DevToolsActivePort");
}

async function launchSharedBrowser(): Promise<{
  context: BrowserContext;
  profile: string;
  cdpUrl: string;
}> {
  const profile = await mkdtemp(join(tmpdir(), "browser-auth-cdp-"));
  try {
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: ["--remote-debugging-port=0"],
    });
    return { context, profile, cdpUrl: await readCdpUrl(profile) };
  } catch (error) {
    await rm(profile, { recursive: true, force: true });
    throw error;
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
    await shared?.context.close().catch(() => {});
    await site.close().catch(() => {});
    if (shared) await rm(shared.profile, { recursive: true, force: true });
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
    await shared?.context.close().catch(() => {});
    await site.close().catch(() => {});
    if (shared) await rm(shared.profile, { recursive: true, force: true });
  }
});
