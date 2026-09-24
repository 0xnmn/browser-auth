import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { confirm, input, password, select } from "@inquirer/prompts";
import { createAuth, type AuthClient } from "../auth.js";
import { parseResponse } from "../protocol.js";
import type {
  AuthFlow,
  AuthInteraction,
  AuthResponse,
  AuthResult,
} from "../protocol.js";
import type {
  AuthOptions,
  LoginOptions,
  LogoutOptions,
  SwitchOptions,
} from "../types.js";
import { validateOperationOptions } from "../options.js";

const MAX_INPUT = 256 * 1024;

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
  stdin: Readable;
  stdout: Writable;
  stderr: Pick<Writable, "write">;
  prompts: CliPrompts;
  loadConfig(path: string): Promise<AuthOptions>;
  loadInput(path: string): Promise<unknown>;
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
export async function loadInput(file: string): Promise<unknown> {
  const handle = await open(resolve(file), "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT)
      throw new Error("input_too_large");
    const buffer = Buffer.alloc(MAX_INPUT + 1);
    let size = 0;
    while (size <= MAX_INPUT) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_INPUT) throw new Error("input_too_large");
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally {
    await handle.close();
  }
}
const defaults: CliDependencies = {
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  prompts: defaultPrompts,
  loadConfig: defaultLoadConfig,
  loadInput,
  createClient: createAuth,
};

function usage(): string {
  return "Usage: browser-auth <login|logout|switch> [website-url] [--config <module>] [--input <file>] [--cdp <endpoint>] [--target-id <id>] [--account-id <id>] [--label <label>] [--save yes|ask|never] [--forget] [--json]\n       browser-auth accounts <list|remove> [id] [--config <module>] [--service-origin <origin>] [--credential-origin <origin>] [--json]\nDefaults: OpenAI gpt-6-luna (OPENAI_API_KEY), CDP http://127.0.0.1:9222, save ask.";
}
type Parsed =
  | {
      command: "login" | "logout" | "switch";
      url?: string;
      values: Map<string, string>;
      forget: boolean;
      json: boolean;
    }
  | {
      command: "accounts";
      action: "list" | "remove";
      id?: string;
      values: Map<string, string>;
      json: boolean;
    };
function parse(argv: readonly string[]): Parsed {
  const command = argv[0];
  if (command === "accounts") {
    const action = argv[1];
    if (action !== "list" && action !== "remove") throw new Error("usage");
    let index = 2;
    let id: string | undefined;
    if (
      action === "remove" &&
      argv[index] !== undefined &&
      !argv[index]!.startsWith("--")
    )
      id = argv[index++];
    const values = new Map<string, string>();
    let json = false;
    for (; index < argv.length; index++) {
      const name = argv[index]!;
      if (name === "--json") {
        json = true;
        continue;
      }
      if (
        ![
          "--config",
          "--service-origin",
          "--credential-origin",
          ...(action === "remove" ? ["--id"] : []),
        ].includes(name) ||
        argv[index + 1] === undefined
      )
        throw new Error("usage");
      values.set(name, argv[++index]!);
    }
    if (values.has("--id")) id = values.get("--id");
    if (action === "remove" && id === undefined) throw new Error("usage");
    return {
      command,
      action,
      ...(id !== undefined ? { id } : {}),
      values,
      json,
    };
  }
  if (command !== "login" && command !== "logout" && command !== "switch")
    throw new Error("usage");
  let index = 1;
  let url: string | undefined;
  if (argv[index] && !argv[index]!.startsWith("--")) url = argv[index++];
  const values = new Map<string, string>();
  let forget = false;
  let json = false;
  for (; index < argv.length; index++) {
    const name = argv[index]!;
    if (name === "--forget") {
      forget = true;
      continue;
    }
    if (name === "--json") {
      json = true;
      continue;
    }
    if (
      ![
        "--config",
        "--input",
        "--cdp",
        "--target-id",
        "--account-id",
        "--label",
        "--save",
      ].includes(name) ||
      !argv[index + 1]
    )
      throw new Error("usage");
    values.set(name, argv[++index]!);
  }
  if (values.get("--input") === "-") throw new Error("usage");
  const save = values.get("--save");
  if (save && !["yes", "ask", "never"].includes(save)) throw new Error("usage");
  if (!url && !values.get("--input")) throw new Error("usage");
  if (forget && command !== "logout") throw new Error("usage");
  return { command, ...(url ? { url } : {}), values, forget, json };
}

async function answer(
  interaction: AuthInteraction,
  prompts: CliPrompts,
  signal: AbortSignal,
): Promise<AuthResponse> {
  if (interaction.kind === "confirm") {
    const label =
      "accountLabel" in interaction.confirmation
        ? interaction.confirmation.accountLabel
        : undefined;
    const messages = {
      "use-credentials": `Allow credentials to be used for ${interaction.confirmation.kind === "use-credentials" ? interaction.confirmation.origin : "this website"}?`,
      "save-credentials": "Save these credentials?",
      "confirm-sign-in": label
        ? `Is the browser signed in as ${safe(label)}?`
        : "Is the browser signed in?",
      "confirm-sign-out": "Is the browser signed out?",
      "confirm-account-switch": label
        ? `Did the browser switch to ${safe(label)}?`
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
  if (interaction.kind === "form" && interaction.fields.length) {
    if (interaction.choices.length) {
      let enter = "\0enter-details";
      while (interaction.choices.some((c) => c.id === enter)) enter += "-";
      const choice = await prompts.select(
        interaction.message ?? "Choose an action",
        [
          { name: "Enter details", value: enter },
          ...interaction.choices.map((c) => ({ name: c.label, value: c.id })),
        ],
        signal,
      );
      if (choice !== enter)
        return {
          kind: "choose",
          interactionId: interaction.id,
          choiceId: choice,
        };
    }
    const values: Record<string, string> = {};
    for (const field of interaction.fields)
      do {
        signal.throwIfAborted();
        values[field.id] =
          field.type === "password" || field.type === "code"
            ? await prompts.secret(
                `${safe(field.label)}${field.required ? "" : " (optional)"}`,
                signal,
              )
            : await prompts.input(
                `${safe(field.label)}${field.required ? "" : " (optional)"}`,
                signal,
              );
      } while (field.required && !values[field.id]);
    return { kind: "submit", interactionId: interaction.id, values };
  }
  if (interaction.kind === "external" && !interaction.choices.length)
    throw new Error("no_external_choices");
  const choiceId = await prompts.select(
    interaction.kind === "external"
      ? interaction.message
      : (interaction.message ?? "Choose an action"),
    interaction.choices.map((c) => ({ name: c.label, value: c.id })),
    signal,
  );
  return { kind: "choose", interactionId: interaction.id, choiceId };
}

async function renderInteractive(
  flow: AuthFlow,
  deps: CliDependencies,
  controller: AbortController,
): Promise<AuthResult> {
  let active:
    { id: string; controller: AbortController; cleanup(): void } | undefined;
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
      const abort = () => promptController.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      const cleanup = () =>
        controller.signal.removeEventListener("abort", abort);
      active = {
        id: snapshot.interaction.id,
        controller: promptController,
        cleanup,
      };
      if (
        snapshot.interaction.kind === "external" &&
        !snapshot.interaction.choices.length
      ) {
        deps.stdout.write(`${safe(snapshot.interaction.message)}\n`);
        deps.stdout.write(
          "No actions are currently available. Waiting for an update.\n",
        );
      } else
        void answer(snapshot.interaction, deps.prompts, promptController.signal)
          .then((response) => {
            if (
              promptController.signal.aborted ||
              active?.id !== snapshot.interaction.id
            )
              return;
            void flow.respond(response).catch((error: unknown) => {
              if (
                error instanceof Error &&
                error.message === "stale_interaction"
              ) {
                deps.stderr.write("Stale response ignored.\n");
                return;
              }
              deps.stderr.write(
                "The response could not be accepted; cancelling the flow.\n",
              );
              controller.abort();
            });
          })
          .catch(() => {
            if (
              !promptController.signal.aborted &&
              active?.id === snapshot.interaction.id
            )
              controller.abort();
          })
          .finally(cleanup);
    }
    if (snapshot.status === "done") {
      active?.controller.abort();
      active?.cleanup();
      return snapshot.result;
    }
  }
  return flow.result;
}

async function renderJson(
  flow: AuthFlow,
  deps: CliDependencies,
  controller: AbortController,
): Promise<AuthResult> {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  let ended = false;
  const cancel = (message: string) => {
    ended = true;
    deps.stdin.pause();
    deps.stderr.write(`${message}\n`);
    controller.abort();
  };
  const onData = (chunk: Buffer | string) => {
    if (ended) return;
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (Buffer.byteLength(buffer) > MAX_INPUT && !buffer.includes("\n")) {
      ended = true;
      cancel("Invalid JSON response; cancelling the flow.");
      return;
    }
    let newline: number;
    while (!ended && (newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_INPUT) {
        ended = true;
        cancel("Invalid JSON response; cancelling the flow.");
        break;
      }
      try {
        const value: unknown = JSON.parse(line);
        if (
          value &&
          typeof value === "object" &&
          (value as { kind?: unknown }).kind === "cancel" &&
          Object.keys(value).length === 1
        ) {
          ended = true;
          controller.abort();
          break;
        }
        const response = parseResponse(value);
        void flow.respond(response).catch((error: unknown) => {
          if (error instanceof Error && error.message === "stale_interaction")
            deps.stderr.write("Stale response ignored.\n");
          else
            cancel("The response could not be accepted; cancelling the flow.");
        });
      } catch {
        ended = true;
        cancel("Invalid JSON response; cancelling the flow.");
      }
    }
    if (!ended && Buffer.byteLength(buffer) > MAX_INPUT)
      cancel("Invalid JSON response; cancelling the flow.");
  };
  const onEnd = () => {
    if (!ended) {
      ended = true;
      controller.abort();
    }
  };
  const onError = () => {
    if (!ended) {
      ended = true;
      controller.abort();
    }
  };
  let outputFailed = false;
  const onOutputError = () => {
    outputFailed = true;
    controller.abort();
  };
  deps.stdout.on("error", onOutputError);
  deps.stdin.on("data", onData);
  deps.stdin.once("end", onEnd);
  deps.stdin.once("error", onError);
  if (deps.stdin.readableEnded || deps.stdin.destroyed) onEnd();
  try {
    for await (const snapshot of flow.updates()) {
      if (outputFailed) throw new Error("output_failed");
      await new Promise<void>((resolve, reject) => {
        deps.stdout.write(`${JSON.stringify(snapshot)}\n`, (error) => {
          if (!error) return resolve();
          const fail = () => reject(new Error("output_failed"));
          // The error event may follow an asynchronous stream destruction.
          // Keep ownership of it until emitted, including on the final write.
          if (outputFailed) fail();
          else deps.stdout.once("error", fail);
        });
      });
      if (snapshot.status === "done") return snapshot.result;
    }
    if (outputFailed) throw new Error("output_failed");
    return await flow.result;
  } catch {
    controller.abort();
    await flow.result;
    throw new Error("json_transport_failed");
  } finally {
    ended = true;
    deps.stdout.off("error", onOutputError);
    deps.stdin.off("data", onData);
    deps.stdin.off("end", onEnd);
    deps.stdin.off("error", onError);
    deps.stdin.pause();
  }
}

export async function runCli(
  argv: readonly string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = { ...defaults, ...overrides };
  if (argv[0] === "--help") {
    deps.stdout.write(`${usage()}\n`);
    return 0;
  }
  let args: Parsed;
  try {
    args = parse(argv);
  } catch {
    deps.stderr.write(`${usage()}\n`);
    return 2;
  }
  try {
    const config = args.values.get("--config");
    const client = deps.createClient(
      config
        ? await deps.loadConfig(config)
        : {
            model: {
              provider: "openai",
              model: "gpt-6-luna",
              ...(deps.env.OPENAI_API_KEY
                ? { apiKey: deps.env.OPENAI_API_KEY }
                : {}),
            },
          },
    );
    if (args.command === "accounts") {
      if (args.action === "remove") {
        await client.accounts.remove(args.id!);
        deps.stdout.write(args.json ? '{"status":"removed"}\n' : "removed\n");
      } else {
        const query = {
          ...(args.values.has("--service-origin")
            ? { serviceOrigin: args.values.get("--service-origin")! }
            : {}),
          ...(args.values.has("--credential-origin")
            ? { credentialOrigin: args.values.get("--credential-origin")! }
            : {}),
        };
        const rows = (await client.accounts.list(query)).map(
          ({
            id,
            label,
            identifierHint,
            serviceOrigins,
            credentialOrigins,
          }) => ({
            id,
            label,
            ...(identifierHint !== undefined ? { identifierHint } : {}),
            serviceOrigins,
            credentialOrigins,
          }),
        );
        deps.stdout.write(
          args.json
            ? `${JSON.stringify(rows)}\n`
            : rows
                .map((row) => `${safe(row.id)}\t${safe(row.label)}`)
                .join("\n") + (rows.length ? "\n" : ""),
        );
      }
      return 0;
    }
    const fromFile = args.values.get("--input")
      ? await deps.loadInput(args.values.get("--input")!)
      : {};
    if (!fromFile || typeof fromFile !== "object" || Array.isArray(fromFile))
      throw new Error("invalid_input");
    // Only positional hostnames get HTTPS shorthand; SDK/file URLs stay explicit.
    const url =
      args.url &&
      /^(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+)(?::\d+)?(?:[/?#]|$)/i.test(
        args.url,
      )
        ? `https://${args.url}`
        : args.url;
    const operation: Record<string, unknown> = {
      ...(fromFile as Record<string, unknown>),
      ...(url ? { url } : {}),
      ...(args.values.get("--cdp") ? { cdpUrl: args.values.get("--cdp") } : {}),
      ...(args.values.get("--target-id")
        ? { targetId: args.values.get("--target-id") }
        : {}),
      ...(args.values.get("--account-id")
        ? { accountId: args.values.get("--account-id") }
        : {}),
      ...(args.values.get("--label")
        ? { label: args.values.get("--label") }
        : {}),
      ...(args.values.get("--save") ? { save: args.values.get("--save") } : {}),
      ...(args.command === "logout" && args.forget
        ? { forgetCredentials: true }
        : {}),
    };
    if (!operation.cdpUrl) {
      operation.cdpUrl =
        deps.env.BROWSER_AUTH_CDP_URL || "http://127.0.0.1:9222";
      if (!deps.env.BROWSER_AUTH_CDP_URL)
        deps.stderr.write(
          "Using the default local CDP endpoint (port 9222).\n",
        );
    }
    const controller = new AbortController();
    operation.signal = controller.signal;
    validateOperationOptions(args.command, operation);
    const onInterrupt = () => controller.abort();
    process.once("SIGINT", onInterrupt);
    try {
      const flow =
        args.command === "login"
          ? client.login(operation as unknown as LoginOptions)
          : args.command === "switch"
            ? client.switchAccount(operation as unknown as SwitchOptions)
            : client.logout(operation as unknown as LogoutOptions);
      const result = await (args.json
        ? renderJson(flow, deps, controller)
        : renderInteractive(flow, deps, controller));
      if (
        result.status === "failed" &&
        result.error.code === "browser_connect_failed"
      )
        deps.stderr.write(
          "Could not connect to Chrome. Start Chrome with --remote-debugging-port=9222 and a separate --user-data-dir, or set --cdp / BROWSER_AUTH_CDP_URL to an existing browser endpoint.\n",
        );
      if (!args.json) deps.stdout.write(`${result.status}\n`);
      if (!args.json && result.status === "failed")
        deps.stderr.write(
          `${safe(result.error.code)}: ${safe(result.error.message)}\n`,
        );
      const failed =
        (result.status === "authenticated" &&
          result.save.status === "failed") ||
        ("deletion" in result && result.deletion === "failed");
      if (
        !args.json &&
        result.status === "authenticated" &&
        result.save.status === "failed"
      )
        deps.stderr.write("Signed in, but credentials could not be saved.\n");
      if (!args.json && "deletion" in result && result.deletion === "failed")
        deps.stderr.write("Credentials could not be deleted.\n");
      return failed
        ? 1
        : result.status === "authenticated" || result.status === "signed-out"
          ? 0
          : result.status === "cancelled"
            ? 130
            : 1;
    } finally {
      process.removeListener("SIGINT", onInterrupt);
    }
  } catch (error) {
    deps.stderr.write(
      error instanceof Error && error.message === "invalid_auth_url"
        ? "Invalid website URL. Use an HTTPS URL such as https://example.com, without embedded credentials. HTTP is allowed only for loopback development.\n"
        : "browser-auth could not start safely.\n",
    );
    return 1;
  }
}
