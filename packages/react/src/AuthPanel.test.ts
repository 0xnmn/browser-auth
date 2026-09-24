import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthPanel } from "./AuthPanel.js";

const render = (snapshot: Parameters<typeof AuthPanel>[0]["snapshot"]) =>
  renderToStaticMarkup(
    createElement(AuthPanel, { snapshot, onRespond: async () => {} }),
  );

describe("AuthPanel", () => {
  it("renders the exact credential origin and secret input without a value", () => {
    const confirmation = render({
      status: "waiting",
      interaction: {
        id: "confirm",
        kind: "confirm",
        confirmation: {
          kind: "use-credentials",
          origin: "https://login.example.test:8443",
        },
        choices: [
          { id: "yes", label: "Allow" },
          { id: "back", label: "Back", kind: "back" },
        ],
      },
    });
    expect(confirmation).toContain("https://login.example.test:8443");
    expect(confirmation).toContain("Back");
    const form = render({
      status: "waiting",
      interaction: {
        id: "form",
        kind: "form",
        fields: [
          {
            id: "password",
            label: "Password",
            type: "password",
            required: true,
          },
        ],
        choices: [],
      },
    });
    expect(form).toContain('type="password"');
    expect(form).not.toContain("value=");
  });

  it("surfaces successful authentication with failed saving", () => {
    const html = render({
      status: "done",
      result: {
        status: "authenticated",
        save: {
          status: "failed",
          error: { code: "store", message: "Could not save" },
        },
      },
    });
    expect(html).toContain("Signed in, but saving failed");
    expect(html).toContain("Could not save");
  });

  it("surfaces deletion failure independently from sign out", () => {
    const html = render({
      status: "done",
      result: { status: "signed-out", deletion: "failed" },
    });
    expect(html).toContain("Signed out");
    expect(html).toContain("deleting saved credentials failed");
  });
});
