import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";

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

export interface SharedBrowser {
  context: BrowserContext;
  cdpUrl: string;
  close(): Promise<void>;
}

export async function launchSharedBrowser(): Promise<SharedBrowser> {
  const profile = await mkdtemp(join(tmpdir(), "browser-auth-cdp-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: ["--remote-debugging-port=0"],
    });
    const cdpUrl = await readCdpUrl(profile);
    return {
      context,
      cdpUrl,
      async close() {
        await context?.close().catch(() => {});
        await rm(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await context?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

export function authTarget(browser: SharedBrowser, page: Page) {
  return { cdpUrl: browser.cdpUrl, url: page.url() };
}
