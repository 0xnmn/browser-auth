import type {
  AuthFlow,
  AuthInteraction,
  AuthResponse,
  AuthSnapshot,
} from "../../packages/browser-auth/src/index.js";
import { fixtureCode, fixturePassword } from "../fixtures/auth-site.js";

export function defaultResponse(interaction: AuthInteraction): AuthResponse {
  const finish = interaction.choices.find((choice) => choice.kind === "finish");
  if (finish) {
    return {
      kind: "choose",
      interactionId: interaction.id,
      choiceId: finish.id,
    };
  }
  if (interaction.fields.length) {
    return {
      kind: "submit",
      interactionId: interaction.id,
      values: Object.fromEntries(
        interaction.fields.map((field) => [
          field.id,
          field.type === "password"
            ? fixturePassword
            : field.type === "code"
              ? fixtureCode
              : field.type === "phone"
                ? "+15550000123"
                : "alice",
        ]),
      ),
    };
  }
  return {
    kind: "choose",
    interactionId: interaction.id,
    choiceId: interaction.choices[0]!.id,
  };
}

export async function complete(
  flow: AuthFlow,
  respond: (
    interaction: AuthInteraction,
  ) => Promise<AuthResponse | null> | AuthResponse | null = defaultResponse,
) {
  const snapshots: AuthSnapshot[] = [];
  for await (const snapshot of flow.updates()) {
    snapshots.push(snapshot);
    if (snapshot.status === "waiting") {
      const answer = await respond(snapshot.interaction);
      if (answer) await flow.respond(answer);
    }
  }
  return { result: await flow.result, snapshots };
}
