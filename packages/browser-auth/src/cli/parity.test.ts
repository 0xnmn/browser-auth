import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAuth } from "../auth.js";
import { InMemoryStore } from "../credentials/memory-store.js";
import { FlowChannel } from "../flow/interaction.js";
import type { LoginOptions, LogoutOptions, SwitchOptions } from "../types.js";
import { runCli, loadInput, type CliDependencies } from "./cli.js";

function harness(channel = new FlowChannel(), initial: unknown = {}) {
  const stdin = new PassThrough();
  let out = "",
    err = "";
  const config = {
    model: { provider: "openai" as const, model: "fixture" },
    store: new InMemoryStore(),
    limits: { maxSteps: 7 },
  };
  const start = (input: LoginOptions | LogoutOptions | SwitchOptions) => {
    input.signal!.addEventListener(
      "abort",
      () => channel.finish({ status: "cancelled" }),
      { once: true },
    );
    return channel;
  };
  const client = {
    login: vi.fn(start),
    logout: vi.fn(start),
    switchAccount: vi.fn(start),
    accounts: createAuth(config).accounts,
  };
  const deps: Partial<CliDependencies> = {
    stdin,
    env: { BROWSER_AUTH_CDP_URL: "http://environment-browser" },
    stdout: new Writable({
      write(chunk, _encoding, callback) {
        out += String(chunk);
        callback();
      },
    }),
    stderr: {
      write(chunk) {
        err += String(chunk);
        return true;
      },
    },
    loadConfig: vi.fn(async () => config),
    loadInput: vi.fn(async () => initial),
    createClient: vi.fn(() => client),
  };
  return {
    channel,
    stdin,
    client,
    config,
    deps,
    output: () => out,
    error: () => err,
  };
}

it.each([
  [
    "login",
    "login",
    {
      credentials: { phone: "+15551234567", fields: { tenant: "north" } },
      save: "yes",
      label: "Personal",
      accountId: "old",
    },
    ["--save", "never", "--account-id", "new"],
    {
      save: "never",
      accountId: "new",
      label: "Personal",
      credentials: { phone: "+15551234567", fields: { tenant: "north" } },
    },
  ],
  [
    "logout",
    "logout",
    { accountId: "keep", forgetCredentials: false },
    [],
    { accountId: "keep", forgetCredentials: false },
  ],
  ["switch", "switchAccount", { accountId: "work" }, [], { accountId: "work" }],
] as const)(
  "forwards every %s option through the same SDK contract",
  async (command, method, options, flags, expected) => {
    const file = {
      cdpUrl: "http://file-browser",
      url: "https://file.example",
      targetId: "tab-file",
      cdpHeaders: { Authorization: "private-header" },
      ...options,
    };
    const h = harness(undefined, file);
    h.channel.finish({
      status: "authenticated",
      save: { status: "not-saved" },
    });
    expect(
      await runCli(
        [
          command,
          "https://flag.example",
          "--config",
          "config.mjs",
          "--input",
          "private.json",
          "--target-id",
          "tab-flag",
          "--json",
          ...flags,
        ],
        h.deps,
      ),
    ).toBe(0);
    expect(h.client[method]).toHaveBeenCalledWith({
      ...file,
      ...expected,
      url: "https://flag.example",
      targetId: "tab-flag",
      signal: expect.any(AbortSignal),
    });
    expect(h.deps.createClient).toHaveBeenCalledWith(h.config);
    expect(h.output()).not.toContain("private-header");
  },
);

it.each([
  [undefined, undefined, undefined, "http://127.0.0.1:9222"],
  [undefined, undefined, "http://env-browser", "http://env-browser"],
  [
    undefined,
    "http://file-browser",
    "http://env-browser",
    "http://file-browser",
  ],
  [
    "http://flag-browser",
    "http://file-browser",
    "http://env-browser",
    "http://flag-browser",
  ],
] as const)(
  "resolves CDP precedence for flag %s, file %s, env %s",
  async (flag, file, env, expected) => {
    const h = harness(undefined, file ? { cdpUrl: file } : {});
    h.deps.env = env ? { BROWSER_AUTH_CDP_URL: env } : {};
    h.channel.finish({
      status: "authenticated",
      save: { status: "not-saved" },
    });
    expect(
      await runCli(
        [
          "login",
          "https://site.example",
          "--config",
          "config.mjs",
          "--input",
          "input.json",
          "--json",
          ...(flag ? ["--cdp", flag] : []),
        ],
        h.deps,
      ),
    ).toBe(0);
    expect(h.client.login).toHaveBeenCalledWith({
      cdpUrl: expected,
      url: "https://site.example",
      signal: expect.any(AbortSignal),
    });
    expect(h.error()).not.toContain(expected);
    expect(h.error().includes("default local CDP")).toBe(
      !flag && !file && !env,
    );
  },
);

it.each([false, true])(
  "uses default model and environment key unless configured (override %s)",
  async (override) => {
    const h = harness();
    h.deps.env = { OPENAI_API_KEY: "synthetic-key" };
    h.channel.finish({
      status: "authenticated",
      save: { status: "not-saved" },
    });
    expect(
      await runCli(
        [
          "login",
          "https://site.example",
          "--json",
          ...(override ? ["--config", "config.mjs"] : []),
        ],
        h.deps,
      ),
    ).toBe(0);
    expect(h.deps.createClient).toHaveBeenCalledWith(
      override
        ? h.config
        : {
            model: {
              provider: "openai",
              model: "gpt-6-luna",
              apiKey: "synthetic-key",
            },
          },
    );
    expect(h.deps.loadConfig).toHaveBeenCalledTimes(override ? 1 : 0);
    expect(h.output() + h.error()).not.toContain("synthetic-key");
  },
);

it("explains connection failures without polluting JSON output", async () => {
  const h = harness();
  h.deps.env = {};
  h.channel.finish({
    status: "failed",
    error: { code: "browser_connect_failed", message: "Connection failed" },
  });
  expect(
    await runCli(
      ["login", "https://site.example", "--config", "config.mjs", "--json"],
      h.deps,
    ),
  ).toBe(1);
  expect(h.error()).toContain("--remote-debugging-port=9222");
  expect(h.error()).toContain("--user-data-dir");
  expect(JSON.parse(h.output())).toMatchObject({
    status: "done",
    result: { status: "failed" },
  });
});

it("lists and removes accounts without CDP and preserves empty exact-origin filters", async () => {
  const h = harness();
  h.deps.env = {};
  await h.config.store.save({
    id: "work",
    label: "Work",
    serviceOrigins: ["https://service.example"],
    credentialOrigins: ["https://identity.example"],
    credentials: [
      {
        origin: "https://identity.example",
        values: { password: "private-store-value" },
      },
    ],
  });
  expect(
    await runCli(
      [
        "accounts",
        "list",
        "--config",
        "config.mjs",
        "--service-origin",
        "",
        "--json",
      ],
      h.deps,
    ),
  ).toBe(0);
  expect(h.output()).toBe("[]\n");
  expect(
    await runCli(
      [
        "accounts",
        "list",
        "--config",
        "config.mjs",
        "--credential-origin",
        "https://identity.example",
        "--json",
      ],
      h.deps,
    ),
  ).toBe(0);
  expect(h.output()).toContain('"id":"work"');
  expect(h.output()).not.toContain("private-store-value");
  expect(
    await runCli(
      ["accounts", "remove", "work", "--config", "config.mjs", "--json"],
      h.deps,
    ),
  ).toBe(0);
  expect(await h.config.store.get("work")).toBeNull();
  expect(h.client.login).not.toHaveBeenCalled();
});

const jsonArgs = [
  "login",
  "https://service.example",
  "--config",
  "config.mjs",
  "--json",
];
it.each(["--work", "--help", ""])(
  "removes an exact account ID %j using --id",
  async (id) => {
    const h = harness();
    const remove = vi.spyOn(h.client.accounts, "remove");
    expect(
      await runCli(
        ["accounts", "remove", "--id", id, "--config", "config.mjs"],
        h.deps,
      ),
    ).toBe(0);
    expect(remove).toHaveBeenCalledWith(id);
  },
);

it.each(["waiting", "done"])(
  "settles on stdout failure during %s without leaking errors",
  async (status) => {
    const h = harness();
    const pending =
      status === "waiting"
        ? h.channel.ask(
            { kind: "external", message: "Waiting", choices: [] },
            new AbortController().signal,
          )
        : undefined;
    if (status === "done")
      h.channel.finish({
        status: "authenticated",
        save: { status: "not-saved" },
      });
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate(() => callback(new Error("private-output-error")));
      },
      destroy(error, callback) {
        setImmediate(() => callback(error));
      },
    });
    h.deps.stdout = stdout;
    expect(await runCli(jsonArgs, h.deps)).toBe(1);
    if (pending) expect(await pending).toBeNull();
    expect(h.client.login.mock.calls[0]![0].signal!.aborted).toBe(true);
    expect(h.error()).not.toContain("private-output-error");
    expect(h.stdin.listenerCount("data")).toBe(0);
    expect(stdout.listenerCount("error")).toBe(0);
  },
);

it("roundtrips JSONL responses with split UTF-8, rejects replay, and never echoes secrets", async () => {
  const h = harness();
  const response = h.channel.ask(
    {
      kind: "form",
      fields: [
        { id: "p", label: "Password", type: "password", required: true },
      ],
      choices: [],
    },
    new AbortController().signal,
  );
  const run = runCli(jsonArgs, h.deps);
  await vi.waitFor(() => expect(h.output()).toContain('"waiting"'));
  const waiting = JSON.parse(h.output().trim());
  const message = {
    kind: "submit",
    interactionId: waiting.interaction.id,
    values: { p: "päss🚀" },
  };
  const encoded = Buffer.from(JSON.stringify(message) + "\n");
  const split = encoded.indexOf(Buffer.from("🚀")) + 2;
  h.stdin.write(encoded.subarray(0, split));
  h.stdin.write(encoded.subarray(split));
  expect(await response).toEqual(message);
  h.stdin.write(encoded);
  await vi.waitFor(() => expect(h.error()).toContain("Stale response ignored"));
  h.channel.finish({ status: "authenticated", save: { status: "not-saved" } });
  expect(await run).toBe(0);
  expect(h.output()).not.toContain("päss");
  const snapshots = h
    .output()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(snapshots.at(-1)).toMatchObject({
    status: "done",
    result: { status: "authenticated" },
  });
  expect(h.stdin.listenerCount("data")).toBe(0);
  expect(h.stdin.isPaused()).toBe(true);
});

it.each(["cancel", "invalid", "oversized", "eof", "error"])(
  "settles JSONL on %s without leaking input or hanging",
  async (kind) => {
    const h = harness();
    const pending = h.channel.ask(
      { kind: "external", message: "Waiting", choices: [] },
      new AbortController().signal,
    );
    const run = runCli(jsonArgs, h.deps);
    await vi.waitFor(() => expect(h.output()).toContain('"waiting"'));
    if (kind === "cancel") h.stdin.write('{"kind":"cancel"}\n');
    if (kind === "invalid") h.stdin.write("private-invalid-input\n");
    if (kind === "oversized") h.stdin.write("x".repeat(256 * 1024 + 1));
    if (kind === "eof") h.stdin.end();
    if (kind === "error") h.stdin.destroy(new Error("private-read-error"));
    expect(await run).toBe(130);
    expect(await pending).toBeNull();
    expect(h.output()).not.toContain("private");
    expect(h.error()).not.toContain("private");
    expect(h.stdin.listenerCount("data")).toBe(0);
  },
);

it("bounds input files before parsing and rejects stdin file mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "auth-cli-input-"));
  try {
    const file = join(directory, "input.json");
    await writeFile(
      file,
      JSON.stringify({ credentials: { email: "synthetic@example.test" } }),
    );
    expect(await loadInput(file)).toEqual({
      credentials: { email: "synthetic@example.test" },
    });
    await writeFile(file, "x".repeat(256 * 1024 + 1));
    await expect(loadInput(file)).rejects.toThrow("input_too_large");
    const h = harness();
    expect(await runCli([...jsonArgs, "--input", "-"], h.deps)).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
