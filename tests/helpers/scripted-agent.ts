import type {
  AuthAgent,
  AuthObservation,
  AuthProposal,
} from "../../packages/browser-auth/src/agent/proposals.js";

/** Deterministic fixture interpreter, not a substitute for real-model evaluations. */
export class FixtureAgent implements AuthAgent {
  readonly observations: AuthObservation[] = [];

  async next(observation: AuthObservation): Promise<AuthProposal> {
    this.observations.push(structuredClone(observation));
    const { text, elements, operation, history = [] } = observation;
    const byLabel = (label: string) =>
      elements.find((element) => element.label.trim() === label)!;
    if (text.includes("Rejected")) return { kind: "done", outcome: "rejected" };
    if (operation === "logout") {
      if (text.includes("Signed out"))
        return { kind: "done", outcome: "signed-out" };
      const signOut = byLabel("Sign out");
      return signOut
        ? { kind: "click", elementId: signOut.id }
        : { kind: "done", outcome: "unsupported" };
    }
    if (operation === "choose-account") {
      if (text.includes("Sign in") && !text.includes("Signed in"))
        return { kind: "done", outcome: "not-signed-in" };
      if (text.includes("Switched") || text.includes("Added account"))
        return { kind: "done", outcome: "account-changed" };
      if (text.includes("Choose account"))
        return {
          kind: "session",
          choices: elements
            .filter((element) => element.tag === "a")
            .map((element) => ({
              elementId: element.id,
              label: element.label,
              kind:
                element.label === "Sign out"
                  ? "logout"
                  : element.label === "Add another account"
                    ? "add"
                    : "switch",
            })),
        };
      if (!text.includes("Add another account")) {
        const nativeControl = byLabel("Switch account");
        return nativeControl
          ? { kind: "click", elementId: nativeControl.id }
          : { kind: "done", outcome: "unsupported" };
      }
    }
    if (
      operation === "login" &&
      (text.includes("Dashboard") ||
        text.includes("Switched") ||
        text.includes("Added account")) &&
      history.length === 0
    ) {
      const kinds = new Map<string, "logout" | "accounts" | "add">([
        ["Sign out", "logout"],
        ["Switch account", "accounts"],
        ["Add account", "add"],
      ] as const);
      return {
        kind: "session",
        choices: elements
          .filter((element) => kinds.has(element.label))
          .map((element) => ({
            elementId: element.id,
            label: element.label,
            kind: kinds.get(element.label)!,
          })),
      };
    }
    if (text.includes("Dashboard") || text.includes("Switched"))
      return { kind: "done", outcome: "authenticated" };
    const fields = elements.filter((element) => element.tag === "input");
    if (!fields.length) return { kind: "wait" };
    const submit = elements.find((element) => element.tag === "button");
    return {
      kind: "form",
      fields: fields.map((element) => {
        const key = element.label.trim().toLowerCase();
        return {
          elementId: element.id,
          key,
          label: element.label,
          type:
            key === "password"
              ? "password"
              : key === "code"
                ? "code"
                : key === "phone"
                  ? "phone"
                  : "text",
          rejected: false,
        };
      }),
      choices: elements
        .filter((element) => element.label === "Back")
        .map((element) => ({
          elementId: element.id,
          label: "Back",
          back: true,
        })),
      submitElementId: submit?.id ?? null,
    };
  }
}
