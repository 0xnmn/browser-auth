import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import type { AuthTarget } from "../types.js";
import type { FlowChannel } from "../flow/interaction.js";
import { AuthFailure } from "../errors.js";
import { originOf } from "../security/origins.js";

export interface BrowserConnection {
  page: Page;
  context: BrowserContext;
  serviceOrigin: string;
  disconnect(): Promise<void>;
}

export async function connectTarget(
  target: AuthTarget,
  flow: FlowChannel,
  signal: AbortSignal,
  timeout: number,
): Promise<BrowserConnection> {
  signal.throwIfAborted();
  if (target.page) {
    return {
      page: target.page,
      context: target.page.context(),
      serviceOrigin: originOf(target.page.url()),
      disconnect: async () => {},
    };
  }
  const serviceOrigin = originOf(target.url);
  const browser = await chromium.connectOverCDP(target.cdpUrl, {
    headers: target.cdpHeaders ?? {},
    noDefaults: true,
    timeout,
  });
  try {
    signal.throwIfAborted();
    const context = browser.contexts()[0];
    if (!context)
      throw new AuthFailure(
        "missing_context",
        "The browser has no shared default context",
      );
    const pages = context.pages();
    let matches = pages.filter((page) => page.url() === target.url);
    if (!matches.length)
      matches = pages.filter((page) => {
        try {
          return originOf(page.url()) === serviceOrigin;
        } catch {
          return false;
        }
      });
    let page: Page | undefined;
    if (matches.length > 1) {
      const choices = await Promise.all(
        matches.map(async (candidate, index) => ({
          id: String(index),
          label: `Tab ${index + 1}: ${(await candidate.title()).slice(0, 160) || "Untitled"}`,
        })),
      );
      const answer = await flow.ask(
        {
          kind: "form",
          message: "Choose the existing tab to authenticate",
          fields: [],
          choices,
        },
        signal,
      );
      signal.throwIfAborted();
      if (answer?.kind === "choose") page = matches[Number(answer.choiceId)];
    } else page = matches[0];
    if (!page) {
      page = await context.newPage();
      signal.throwIfAborted();
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout });
    }
    return {
      page,
      context,
      serviceOrigin,
      disconnect: async () => {
        await browser.close();
      },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
