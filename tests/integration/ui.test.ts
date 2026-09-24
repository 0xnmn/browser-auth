import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { startUiPreview } from "../../examples/ui-server.js";

it("renders only valid account choices, clears submitted secrets, and permits Back without required fields", async () => {
  const server = await startUiPreview();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    const accounts = page.getByRole("article", {
      name: "Saved accounts",
      exact: true,
    });
    expect(
      await accounts
        .getByRole("button", { name: "Continue", exact: true })
        .count(),
    ).toBe(0);
    await accounts
      .getByRole("button", { name: "Work account", exact: true })
      .click();
    expect(await accounts.getByLabel("Response count").innerText()).toBe(
      "1 responses",
    );
    const form = page.getByRole("article", {
      name: "Credentials and Back",
      exact: true,
    });
    await form
      .getByLabel("Email", { exact: true })
      .fill("synthetic@example.test");
    await form
      .getByLabel("Password", { exact: true })
      .fill("synthetic-ui-only");
    await form.getByRole("button", { name: "Continue", exact: true }).click();
    expect(
      await form.getByLabel("Password", { exact: true }).inputValue(),
    ).toBe("");
    expect(
      await form
        .getByRole("button", { name: "Continue", exact: true })
        .isDisabled(),
    ).toBe(true);
    expect(await form.getByLabel("Response count").innerText()).toBe(
      "1 responses",
    );
    await page.reload();
    await form.getByRole("button", { name: "Back", exact: true }).click();
    expect(await form.getByLabel("Response count").innerText()).toBe(
      "1 responses",
    );
    const existing = page.getByRole("article", {
      name: "Existing session",
      exact: true,
    });
    expect(await existing.innerText()).toContain("Already signed in");
    expect(await existing.getByRole("button").count()).toBe(0);
    const native = page.getByRole("article", {
      name: "Website account choices",
      exact: true,
    });
    expect(await native.getByRole("button").allTextContents()).toEqual([
      "Personal Alice",
      "Work Bob",
      "Add another account",
      "Log out",
      "Keep this session and finish",
    ]);
    await native
      .getByRole("button", { name: "Add another account", exact: true })
      .click();
    expect(await native.getByLabel("Response count").innerText()).toBe(
      "1 responses",
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
