import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AuthFlow, AuthSnapshot } from "../protocol.js";
import type { AuthClient } from "../auth.js";
import { FlowChannel } from "../flow/interaction.js";
import { runCli, type CliDependencies } from "./cli.js";

function flow(snapshots: AuthSnapshot[], respond = vi.fn()): AuthFlow {
  const last = snapshots.at(-1);
  const result =
    last?.status === "done" ? last.result : { status: "cancelled" as const };
  return {
    async *updates() {
      yield* snapshots;
    },
    respond,
    result: Promise.resolve(result),
  };
}

function controlledFlow() {
  const queued: AuthSnapshot[] = [];
  let wake: (() => void) | undefined;
  let finish!: (result: AuthSnapshot & { status: "done" }) => void;
  const done = new Promise<AuthSnapshot & { status: "done" }>((resolve) => {
    finish = resolve;
  });
  const respond = vi.fn(async () => {});
  const authFlow: AuthFlow = {
    async *updates() {
      while (true) {
        if (queued.length === 0)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        const snapshot = queued.shift()!;
        yield snapshot;
        if (snapshot.status === "done") return;
      }
    },
    respond,
    result: done.then((snapshot) => snapshot.result),
  };
  const publish = (snapshot: AuthSnapshot) => {
    queued.push(snapshot);
    if (snapshot.status === "done") finish(snapshot);
    wake?.();
    wake = undefined;
  };
  return { flow: authFlow, publish, respond };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(authFlow: AuthFlow) {
  let out = "";
  let err = "";
  const login = vi.fn(
    (_options: Parameters<AuthClient["login"]>[0]) => authFlow,
  );
  const deps: Partial<CliDependencies> = {
    env: { BROWSER_AUTH_CDP_URL: "ws://secret-endpoint" },
    stdout: new Writable({
      write: (value, _encoding, callback) => {
        out += String(value);
        callback();
      },
    }),
    stderr: {
      write: (value) => {
        err += String(value);
        return true;
      },
    },
    loadConfig: vi.fn(async () => ({
      model: { provider: "openai" as const, model: "fixture" },
    })),
    createClient: vi.fn(
      () =>
        ({
          login,
          accounts: {},
        }) as unknown as AuthClient,
    ),
    prompts: {
      input: vi.fn(),
      secret: vi.fn(),
      select: vi.fn(),
      confirm: vi.fn(),
    },
  };
  return { deps, login, output: () => out, error: () => err };
}

describe("runCli", () => {
  it("uses the environment CDP endpoint and forwards login options", async () => {
    const h = harness(
      flow([
        {
          status: "done",
          result: { status: "authenticated", save: { status: "not-saved" } },
        },
      ]),
    );
    expect(
      await runCli(
        [
          "login",
          "https://example.test/login",
          "--config",
          "config.mjs",
          "--save",
          "never",
          "--label",
          "work",
        ],
        h.deps,
      ),
    ).toBe(0);
    expect(h.login).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: "ws://secret-endpoint",
        url: "https://example.test/login",
        save: "never",
        label: "work",
      }),
    );
    expect(h.output()).toBe("authenticated\n");
  });

  it("hides both passwords and verification codes", async () => {
    const controlled = controlledFlow();
    const interaction = {
      status: "waiting" as const,
      interaction: {
        id: "i",
        kind: "form" as const,
        fields: [
          {
            id: "p",
            label: "Password",
            type: "password" as const,
            required: true,
          },
          { id: "c", label: "Code", type: "code" as const, required: true },
        ],
        choices: [],
      },
    };
    const h = harness(controlled.flow);
    const secret = vi
      .mocked(h.deps.prompts!.secret)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("pw")
      .mockResolvedValueOnce("123456");
    const run = runCli(
      ["login", "https://example.test", "--config", "config.mjs"],
      h.deps,
    );
    controlled.publish(interaction);
    await vi.waitFor(() => expect(controlled.respond).toHaveBeenCalled());
    controlled.publish({ status: "done", result: { status: "cancelled" } });
    await run;
    expect(secret).toHaveBeenCalledTimes(3);
    expect(controlled.respond).toHaveBeenCalledWith({
      kind: "submit",
      interactionId: "i",
      values: { p: "pw", c: "123456" },
    });
    expect(h.output()).not.toContain("pw");
  });

  it("keeps consuming updates, cancels replaced prompts, and ignores their late answers", async () => {
    const controlled = controlledFlow();
    const h = harness(controlled.flow);
    const first = deferred<string>();
    const second = deferred<string>();
    vi.mocked(h.deps.prompts!.select)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const run = runCli(
      ["login", "https://example.test", "--config", "config.mjs"],
      h.deps,
    );
    controlled.publish({
      status: "waiting",
      interaction: {
        id: "old",
        kind: "external",
        message: "Old",
        choices: [{ id: "old-choice", label: "Continue" }],
      },
    });
    await vi.waitFor(() =>
      expect(h.deps.prompts!.select).toHaveBeenCalledTimes(1),
    );
    const oldSignal = vi.mocked(h.deps.prompts!.select).mock.calls[0]![2];
    controlled.publish({
      status: "waiting",
      interaction: {
        id: "new",
        kind: "external",
        message: "New",
        choices: [{ id: "new-choice", label: "Continue" }],
      },
    });
    await vi.waitFor(() =>
      expect(h.deps.prompts!.select).toHaveBeenCalledTimes(2),
    );
    expect(oldSignal.aborted).toBe(true);
    first.resolve("old-choice");
    await Promise.resolve();
    expect(controlled.respond).not.toHaveBeenCalled();
    controlled.publish({ status: "done", result: { status: "cancelled" } });
    expect(await run).toBe(130);
    expect(vi.mocked(h.deps.prompts!.select).mock.calls[1]![2].aborted).toBe(
      true,
    );
    second.resolve("new-choice");
    await Promise.resolve();
    expect(controlled.respond).not.toHaveBeenCalled();
  });

  it("does not select when an external interaction has no choices", async () => {
    const controlled = controlledFlow();
    const h = harness(controlled.flow);
    const run = runCli(
      ["login", "https://example.test", "--config", "config.mjs"],
      h.deps,
    );
    controlled.publish({
      status: "waiting",
      interaction: {
        id: "empty",
        kind: "external",
        message: "Scan the code",
        choices: [],
      },
    });
    await vi.waitFor(() =>
      expect(h.output()).toContain("No actions are currently available"),
    );
    expect(h.deps.prompts!.select).not.toHaveBeenCalled();
    controlled.publish({ status: "done", result: { status: "cancelled" } });
    await run;
  });

  it("offers form actions before collecting secrets", async () => {
    const controlled = controlledFlow();
    const h = harness(controlled.flow);
    vi.mocked(h.deps.prompts!.select).mockResolvedValue("back");
    const run = runCli(
      ["login", "https://example.test", "--config", "config.mjs"],
      h.deps,
    );
    controlled.publish({
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
        choices: [
          { id: "back", label: "Back", kind: "back" },
          { id: "sso", label: "Use SSO" },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(controlled.respond).toHaveBeenCalledWith({
        kind: "choose",
        interactionId: "form",
        choiceId: "back",
      }),
    );
    expect(h.deps.prompts!.secret).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(h.deps.prompts!.select)
        .mock.calls[0]![1].map((choice) => choice.name),
    ).toEqual(["Enter details", "Back", "Use SSO"]);
    controlled.publish({ status: "done", result: { status: "cancelled" } });
    await run;
  });

  it("prompts for credential-use consent", async () => {
    const controlled = controlledFlow();
    const h = harness(controlled.flow);
    vi.mocked(h.deps.prompts!.confirm).mockResolvedValue(true);
    const run = runCli(
      ["login", "https://example.test", "--config", "config.mjs"],
      h.deps,
    );
    controlled.publish({
      status: "waiting",
      interaction: {
        id: "confirm",
        kind: "confirm",
        confirmation: {
          kind: "use-credentials",
          origin: "https://identity.example",
        },
        choices: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      },
    } as AuthSnapshot);
    await vi.waitFor(() =>
      expect(h.deps.prompts!.confirm).toHaveBeenCalledWith(
        "Allow credentials to be used for https://identity.example?",
        expect.any(AbortSignal),
      ),
    );
    controlled.publish({ status: "done", result: { status: "cancelled" } });
    await run;
  });

  it("answers a session interaction with the website-provided choice", async () => {
    const controlled = controlledFlow();
    const h = harness(controlled.flow);
    vi.mocked(h.deps.prompts!.select).mockResolvedValue("native-logout");
    const run = runCli(
      ["login", "https://example.test", "--config", "config.mjs"],
      h.deps,
    );
    controlled.publish({
      status: "waiting",
      interaction: {
        id: "session",
        kind: "session",
        choices: [
          { id: "done", label: "Keep using this account", kind: "finish" },
          { id: "native-logout", label: "Sign out here", kind: "logout" },
          { id: "work-account", label: "Work account", kind: "switch" },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(controlled.respond).toHaveBeenCalledWith({
        kind: "choose",
        interactionId: "session",
        choiceId: "native-logout",
      }),
    );
    expect(h.deps.prompts!.select).toHaveBeenCalledWith(
      "Already signed in. How would you like to proceed?",
      [
        { name: "Keep using this account", value: "done" },
        { name: "Sign out here", value: "native-logout" },
        { name: "Work account", value: "work-account" },
      ],
      expect.any(AbortSignal),
    );
    controlled.publish({
      status: "done",
      result: { status: "signed-out", deletion: "not-requested" },
    });
    expect(await run).toBe(0);
    expect(h.login).toHaveBeenCalledTimes(1);
  });

  it("rejects the removed --action option", async () => {
    const h = harness(flow([]));
    expect(
      await runCli(
        ["login", "https://example.test", "--action", "logout"],
        h.deps,
      ),
    ).toBe(2);
    expect(h.login).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        status: "authenticated",
        save: {
          status: "failed",
          error: { code: "private", message: "secret" },
        },
      },
      "credentials could not be saved",
    ],
    [
      {
        status: "signed-out",
        deletion: "failed",
        error: { code: "private", message: "secret" },
      },
      "Credentials could not be deleted",
    ],
  ] as const)(
    "reports independent storage failures safely",
    async (result, message) => {
      const h = harness(flow([{ status: "done", result }]));
      expect(
        await runCli(
          ["login", "https://example.test", "--config", "config.mjs"],
          h.deps,
        ),
      ).toBe(1);
      expect(h.error()).toContain(message);
      expect(h.error()).not.toContain("private");
      expect(h.error()).not.toContain("secret");
    },
  );

  it("prints help successfully without requiring configuration", async () => {
    const h = harness(flow([]));
    expect(await runCli(["--help"], h.deps)).toBe(0);
    expect(h.output()).toMatch(/^Usage:/);
    expect(h.error()).toBe("");
  });

  it("sanitizes terminal content and displays the safe result error", async () => {
    const h = harness(
      flow([
        { status: "running", message: "safe\u001b[31m\nforged" },
        {
          status: "done",
          result: {
            status: "failed",
            error: { code: "model_key_missing", message: "Set OPENAI_API_KEY" },
          },
        },
      ]),
    );
    expect(
      await runCli(
        ["login", "https://example.test", "--config", "config.mjs"],
        h.deps,
      ),
    ).toBe(1);
    expect(h.output()).toBe("safe [31m forged\nfailed\n");
    expect(h.error()).toBe("model_key_missing: Set OPENAI_API_KEY\n");
  });

  it("rejects missing required arguments with fixed usage", async () => {
    const h = harness(flow([]));
    expect(await runCli(["login"], h.deps)).toBe(2);
    expect(h.error()).toMatch(/^Usage:/);
  });

  it("prints the safe reason for an uncertain outcome", async () => {
    const h = harness(
      flow([
        {
          status: "done",
          result: {
            status: "unknown",
            message: "Inspect before retrying.\u001b[31m",
          },
        },
      ]),
    );
    expect(await runCli(["login", "https://example.test"], h.deps)).toBe(1);
    expect(h.error()).toContain("Inspect before retrying.");
    expect(h.error()).not.toContain("\u001b");
  });

  it("surfaces an oversized response without hanging on the still-pending interaction", async () => {
    const channel = new FlowChannel();
    const h = harness(channel);
    const factory = h.deps.createClient!;
    h.deps.createClient = (options) => ({
      ...factory(options),
      login(input) {
        input.signal!.addEventListener(
          "abort",
          () => channel.finish({ status: "cancelled" }),
          { once: true },
        );
        return channel;
      },
    });
    vi.mocked(h.deps.prompts!.secret).mockResolvedValue("x".repeat(8193));
    const pending = channel.ask(
      {
        kind: "form",
        fields: [
          { id: "secret", label: "Password", type: "password", required: true },
        ],
        choices: [],
      },
      new AbortController().signal,
    );
    expect(
      await runCli(
        ["login", "https://example.test", "--config", "config.mjs"],
        h.deps,
      ),
    ).toBe(130);
    expect(h.error()).toBe(
      "The response could not be accepted; cancelling the flow.\n",
    );
    expect(await pending).toBeNull();
  });
});
