import type {
  AuthAgent,
  AuthObservation,
  AuthProposal,
} from "../../packages/browser-auth/src/index.js";

/** Deterministic fixture interpreter, not a substitute for real-model evaluations. */
export class FixtureAgent implements AuthAgent {
  readonly observations: AuthObservation[] = [];

  async next(observation: AuthObservation): Promise<AuthProposal> {
    this.observations.push(structuredClone(observation));
    const { text, elements, operation } = observation;
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
    if (operation === "switch") {
      if (text.includes("Switched"))
        return { kind: "done", outcome: "authenticated" };
      if (text.includes("Choose account"))
        return {
          kind: "form",
          fields: [],
          submitElementId: null,
          choices: elements
            .filter((element) => element.tag === "a")
            .map((element) => ({
              elementId: element.id,
              label: element.label,
              back: false,
            })),
        };
      const switcher = byLabel("Switch account");
      return switcher
        ? { kind: "click", elementId: switcher.id }
        : { kind: "done", outcome: "unsupported" };
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
