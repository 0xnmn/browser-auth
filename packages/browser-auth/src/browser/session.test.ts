import { chromium, type Browser } from "playwright-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BrowserSession } from "./session.js";

describe("BrowserSession", () => {
  let browser: Browser;

  beforeEach(async () => {
    browser = await chromium.launch();
  });

  afterEach(async () => {
    await browser.close();
  });

  test("scopes discovery to the selected page and its popups", async () => {
    const context = await browser.newContext();
    const initial = await context.newPage();
    const unrelated = await context.newPage();
    const session = new BrowserSession(context, initial);
    const popupPromise = initial.waitForEvent("popup");
    await initial.evaluate(() => open("about:blank"));
    const popup = await popupPromise;
    await expect.poll(() => session.list().length).toBe(2);

    expect(session.current()).toBe(popup);
    expect(session.list().some((entry) => entry.origin === "opaque")).toBe(
      true,
    );
    expect(session.list()).toHaveLength(2);
    expect(session.list().some((entry) => entry.id === unrelated.url())).toBe(
      false,
    );
    session.clear();
  });

  test("closes only pages created by the session", async () => {
    const context = await browser.newContext();
    const initial = await context.newPage();
    const session = new BrowserSession(context, initial);
    const borrowedId = session.list()[0]!.id;
    await expect(session.close(borrowedId)).rejects.toMatchObject({
      code: "page_not_owned",
    });
    expect(initial.isClosed()).toBe(false);

    const ownedId = await session.create();
    const owned = session.current();
    await session.close(ownedId);
    expect(owned.isClosed()).toBe(true);
    session.clear();
  });

  test("dismisses unsupported native dialogs without providing a private value", async () => {
    const context = await browser.newContext();
    const initial = await context.newPage();
    const session = new BrowserSession(context, initial);
    const evaluation = initial.evaluate(() => prompt("private question"));
    await expect(evaluation).resolves.toBeNull();
    expect(session.nativeDialogSeen).toBe(true);
    session.clear();
  });
});
