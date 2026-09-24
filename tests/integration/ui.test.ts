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
    const identity = page.getByRole("article", {
      name: "Account confirmation",
      exact: true,
    });
    expect(await identity.innerText()).toContain(
      "Is the browser now signed in as Work account?",
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
