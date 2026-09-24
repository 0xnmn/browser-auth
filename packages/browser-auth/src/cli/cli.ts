import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { confirm, input, password, select } from "@inquirer/prompts";
import { createAuth } from "../auth.js";
import type { AuthClient } from "../auth.js";
import type { AuthOptions } from "../types.js";
import type {
  AuthFlow,
  AuthInteraction,
  AuthResult,
  AuthResponse,
} from "../protocol.js";

export interface CliPrompts {
  input(message: string, signal: AbortSignal): Promise<string>;
  secret(message: string, signal: AbortSignal): Promise<string>;
  select(
    message: string,
    choices: ReadonlyArray<{ name: string; value: string }>,
    signal: AbortSignal,
  ): Promise<string>;
  confirm(message: string, signal: AbortSignal): Promise<boolean>;
}

export interface CliDependencies {
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  prompts: CliPrompts;
  loadConfig(path: string): Promise<AuthOptions>;
  createClient(options: AuthOptions): AuthClient;
}

const safe = (value: string): string =>
  value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 500);

const defaultPrompts: CliPrompts = {
  input: (message, signal) => input({ message: safe(message) }, { signal }),
  secret: (message, signal) =>
    password({ message: safe(message), mask: "*" }, { signal }),
  select: (message, choices, signal) =>
    select(
      {
        message: safe(message),
        choices: choices.map((choice) => ({
          name: safe(choice.name),
          value: choice.value,
        })),
      },
      { signal },
    ),
  confirm: (message, signal) =>
    confirm({ message: safe(message), default: false }, { signal }),
};

async function defaultLoadConfig(file: string): Promise<AuthOptions> {
  const loaded = await import(pathToFileURL(resolve(file)).href);
  if (!loaded.default || typeof loaded.default !== "object")
    throw new Error("invalid_config");
  return loaded.default as AuthOptions;
}

const defaults: CliDependencies = {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  prompts: defaultPrompts,
  loadConfig: defaultLoadConfig,
  createClient: createAuth,
};

function usage(): string {
  return "Usage: browser-auth <login|logout|switch> <website-url> --config <module> [--cdp <endpoint>] [--account-id <id>] [--label <label>] [--save yes|ask|never] [--forget]";
}

function parse(argv: readonly string[]): {
  command: "login" | "logout" | "switch";
  url: string;
  config: string;
  cdp?: string;
  accountId?: string;
  label?: string;
  save?: "yes" | "ask" | "never";
  forget: boolean;
} {
  const [command, url, ...rest] = argv;
  if (command !== "login" && command !== "logout" && command !== "switch")
    throw new Error("usage");
  if (!url) throw new Error("usage");
  const values = new Map<string, string>();
  let forget = false;
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index]!;
    if (name === "--forget") {
      forget = true;
      continue;
    }
    if (
      !["--config", "--cdp", "--account-id", "--label", "--save"].includes(
        name,
      ) ||
      !rest[index + 1]
    )
      throw new Error("usage");
    values.set(name, rest[++index]!);
  }
  const config = values.get("--config");
  if (!config) throw new Error("usage");
  const saveValue = values.get("--save");
  if (
    saveValue &&
    saveValue !== "yes" &&
    saveValue !== "ask" &&
    saveValue !== "never"
  )
    throw new Error("usage");
  const save =
    saveValue === "yes" || saveValue === "ask" || saveValue === "never"
      ? saveValue
      : undefined;
  if (command === "switch" && !values.get("--account-id"))
    throw new Error("usage");
  if (forget && (command !== "logout" || !values.get("--account-id")))
    throw new Error("usage");
  return {
    command,
    url,
    config,
    ...(values.get("--cdp") ? { cdp: values.get("--cdp")! } : {}),
    ...(values.get("--account-id")
      ? { accountId: values.get("--account-id")! }
      : {}),
    ...(values.get("--label") ? { label: values.get("--label")! } : {}),
    ...(save ? { save } : {}),
    forget,
  };
}

async function answer(
  interaction: AuthInteraction,
  prompts: CliPrompts,
  signal: AbortSignal,
): Promise<AuthResponse> {
  if (interaction.kind === "confirm") {
    const accountLabel =
      "accountLabel" in interaction.confirmation &&
      typeof interaction.confirmation.accountLabel === "string"
        ? safe(interaction.confirmation.accountLabel)
        : undefined;
    const messages = {
      "use-credentials": `Allow credentials to be used for ${interaction.confirmation.kind === "use-credentials" ? interaction.confirmation.origin : "this website"}?`,
      "save-credentials": "Save these credentials?",
      "confirm-sign-in": accountLabel
        ? `Is the browser signed in as ${accountLabel}?`
        : "Is the browser signed in?",
      "confirm-sign-out": "Is the browser signed out?",
      "confirm-account-switch": accountLabel
        ? `Did the browser switch to ${accountLabel}?`
        : "Did the browser switch accounts?",
    };
    const accepted = await prompts.confirm(
      messages[interaction.confirmation.kind],
      signal,
    );
    const choice =
      interaction.choices[accepted ? 0 : 1] ?? interaction.choices[0];
    if (!choice) throw new Error("invalid_interaction");
    return {
      kind: "choose",
      interactionId: interaction.id,
      choiceId: choice.id,
    };
  }
  if (interaction.kind === "form" && interaction.fields.length > 0) {
    if (interaction.choices.length > 0) {
      let enterDetails = "\u0000enter-details";
      while (interaction.choices.some((choice) => choice.id === enterDetails))
        enterDetails += "-";
      const choiceId = await prompts.select(
        interaction.message ?? "Choose an action",
        [
          { name: "Enter details", value: enterDetails },
          ...interaction.choices.map((choice) => ({
            name: choice.label,
            value: choice.id,
          })),
        ],
        signal,
      );
      if (choiceId !== enterDetails)
        return { kind: "choose", interactionId: interaction.id, choiceId };
    }
    const values: Record<string, string> = {};
    for (const field of interaction.fields) {
      const message = `${safe(field.label)}${field.required ? "" : " (optional)"}`;
      do {
        signal.throwIfAborted();
        values[field.id] =
          field.type === "password" || field.type === "code"
            ? await prompts.secret(message, signal)
            : await prompts.input(message, signal);
      } while (field.required && !values[field.id]);
    }
    return { kind: "submit", interactionId: interaction.id, values };
  }
  if (interaction.kind === "external" && interaction.choices.length === 0)
    throw new Error("no_external_choices");
  const choiceId = await prompts.select(
    interaction.kind === "external"
      ? interaction.message
      : (interaction.message ?? "Choose an action"),
    interaction.choices.map((choice) => ({
      name: choice.label,
      value: choice.id,
    })),
    signal,
  );
  return { kind: "choose", interactionId: interaction.id, choiceId };
}

async function render(
  flow: AuthFlow,
  deps: CliDependencies,
  controller: AbortController,
): Promise<AuthResult> {
  let active:
    | { id: string; controller: AbortController; cleanup: () => void }
    | undefined;
  for await (const snapshot of flow.updates()) {
    if (snapshot.status !== "waiting") {
      active?.controller.abort();
      active?.cleanup();
      active = undefined;
    }
    if (snapshot.status === "running")
      deps.stdout.write(`${safe(snapshot.message)}\n`);
    if (snapshot.status === "waiting") {
      active?.controller.abort();
      active?.cleanup();
      const promptController = new AbortController();
      const abortPrompt = () => promptController.abort();
      controller.signal.addEventListener("abort", abortPrompt, { once: true });
      const cleanup = () =>
        controller.signal.removeEventListener("abort", abortPrompt);
      active = {
        id: snapshot.interaction.id,
        controller: promptController,
        cleanup,
      };
      if (
        snapshot.interaction.kind === "external" &&
        snapshot.interaction.choices.length === 0
      ) {
        deps.stdout.write(`${safe(snapshot.interaction.message)}\n`);
        deps.stdout.write(
          "No actions are currently available. Waiting for an update.\n",
        );
      } else {
        void answer(snapshot.interaction, deps.prompts, promptController.signal)
          .then((response) => {
            if (
              promptController.signal.aborted ||
              active?.id !== snapshot.interaction.id
            )
              return;
            // A response can expire between this check and respond(). A stale rejection is benign.
            void flow.respond(response).catch((error: unknown) => {
              if (
                error instanceof Error &&
                error.message === "stale_interaction"
              )
                return;
              deps.stderr.write(
                "The response could not be accepted; cancelling the flow.\n",
              );
              controller.abort();
            });
          })
          .catch(() => {
            // Replacement aborts are expected. A prompt that fails while still active cancels the operation.
            if (
              !promptController.signal.aborted &&
              active?.id === snapshot.interaction.id
            )
              controller.abort();
          })
          .finally(cleanup);
      }
    }
    if (snapshot.status === "done") {
      active?.controller.abort();
      active?.cleanup();
      return snapshot.result;
    }
  }
  return flow.result;
}

export async function runCli(
  argv: readonly string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = { ...defaults, ...overrides };
  if (argv.includes("--help")) {
    deps.stdout.write(`${usage()}\n`);
    return 0;
  }
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch {
    deps.stderr.write(`${usage()}\n`);
    return 2;
  }
  const cdpUrl = args.cdp ?? deps.env.BROWSER_AUTH_CDP_URL;
  if (!cdpUrl) {
    deps.stderr.write(
      "A CDP endpoint is required; set BROWSER_AUTH_CDP_URL or use --cdp.\n",
    );
    return 2;
  }
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    const client = deps.createClient(await deps.loadConfig(args.config));
    const target = { cdpUrl, url: args.url, signal: controller.signal };
    const flow =
      args.command === "login"
        ? client.login({
            ...target,
            ...(args.accountId ? { accountId: args.accountId } : {}),
            ...(args.label ? { label: args.label } : {}),
            ...(args.save ? { save: args.save } : {}),
          })
        : args.command === "switch"
          ? client.switchAccount({ ...target, accountId: args.accountId! })
          : client.logout({
              ...target,
              ...(args.forget
                ? {
                    forgetCredentials: true as const,
                    accountId: args.accountId!,
                  }
                : { forgetCredentials: false as const }),
            });
    const result = await render(flow, deps, controller);
    deps.stdout.write(`${result.status}\n`);
    const saveFailed =
      result.status === "authenticated" && result.save.status === "failed";
    const deletionFailed = "deletion" in result && result.deletion === "failed";
    if (saveFailed)
      deps.stderr.write("Signed in, but credentials could not be saved.\n");
    if (deletionFailed)
      deps.stderr.write("Credentials could not be deleted.\n");
    if (saveFailed || deletionFailed) return 1;
    return result.status === "authenticated" || result.status === "signed-out"
      ? 0
      : result.status === "cancelled"
        ? 130
        : 1;
  } catch {
    deps.stderr.write("browser-auth could not start safely.\n");
    return 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}
