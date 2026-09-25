import { PassThrough, Writable } from "node:stream";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCli, type CliDependencies } from "./cli.js";
import { FlowChannel } from "../flow/interaction.js";
import type { AuthClient } from "../auth.js";
import { parseSnapshot } from "../protocol.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "auth-transcript-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function harness(json: boolean) {
  const flow = new FlowChannel();
  const stdin = new PassThrough();
  let out = "",
    err = "";
  let aborted = false;
  const login = vi.fn((input: Parameters<AuthClient["login"]>[0]) => {
    input.signal!.addEventListener("abort", () => {
      aborted = true;
    });
    queueMicrotask(
      () =>
        void (async () => {
          flow.diagnostics.emit({ type: "start" });
          await flow.ask(
            {
              message: "Password",
              fields: [
                {
                  id: "p",
                  label: "Password",
                  type: "password",
                  required: true,
                },
              ],
              choices: [],
            },
            input.signal!,
          );
          flow.finish({
            status: "authenticated",
            save: { status: "not-saved" },
          });
        })(),
    );
    return flow;
  });
  const deps: Partial<CliDependencies> = {
    stdin,
    env: {},
    createClient: () => ({ login, accounts: {} }) as unknown as AuthClient,
    stdout: new Writable({
      write(chunk, _encoding, callback) {
        const line = String(chunk);
        out += line;
        if (json) {
          const snapshot = parseSnapshot(JSON.parse(line));
          if (snapshot.status === "waiting")
            queueMicrotask(() =>
              stdin.write(
                JSON.stringify({
                  kind: "submit",
                  interactionId: snapshot.interaction.id,
                  values: { p: "private-fixture-password" },
                }) + "\n",
              ),
            );
        }
        callback();
      },
    }),
    stderr: {
      write(chunk) {
        err += String(chunk);
        return true;
      },
    },
    prompts: {
      input: vi.fn(),
      secret: vi.fn(async () => "private-fixture-password"),
      select: vi.fn(),
      confirm: vi.fn(),
    },
  };
  const args = [
    "login",
    "https://example.test",
    "--transcript",
    join(directory, "private.jsonl"),
    ...(json ? ["--json"] : []),
  ];
  return {
    args,
    deps,
    login,
    flow,
    out: () => out,
    err: () => err,
    aborted: () => aborted,
  };
}

it.each([false, true])(
  "records separately with restrictive permissions and preserves the renderer (json=%s)",
  async (json) => {
    const h = harness(json);
    expect(await runCli(h.args, h.deps)).toBe(0);
    expect(h.login).toHaveBeenCalledTimes(1);
    expect(h.aborted()).toBe(false);
    const file = join(directory, "private.jsonl");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const raw = await readFile(file, "utf8");
    const events = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "interaction",
      "response",
      "result",
    ]);
    expect(events.at(-1)).toMatchObject({
      result: { status: "authenticated" },
    });
    expect(raw + h.out() + h.err()).not.toContain("private-fixture-password");
    if (json)
      expect(
        h
          .out()
          .trim()
          .split("\n")
          .map((line) => parseSnapshot(JSON.parse(line)))
          .at(-1),
      ).toMatchObject({ status: "done", result: { status: "authenticated" } });
    else expect(h.out()).toContain("authenticated\n");
  },
);

it("refuses an existing file before starting login and hides the path", async () => {
  const h = harness(true);
  const file = join(directory, "private.jsonl");
  await writeFile(file, "original");
  expect(await runCli(h.args, h.deps)).toBe(1);
  expect(h.login).not.toHaveBeenCalled();
  expect(await readFile(file, "utf8")).toBe("original");
  expect(h.err()).toContain("Transcript file could not be created");
  expect(h.err()).not.toContain(file);
  expect(JSON.parse(h.out())).toMatchObject({
    status: "done",
    result: { error: { code: "transcript_open_failed" } },
  });
});

it.each(["writeFile", "sync", "close"] as const)(
  "reports %s failure without changing successful authentication",
  async (method) => {
    const h = harness(true);
    const file = {
      writeFile: vi.fn(async () => {}),
      sync: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    file[method].mockRejectedValue(new Error("raw-private-filesystem-error"));
    h.deps.openTranscript = vi.fn(async () => file);
    expect(await runCli(h.args, h.deps)).toBe(1);
    expect(h.login).toHaveBeenCalledTimes(1);
    expect(h.aborted()).toBe(false);
    expect(file.close).toHaveBeenCalledTimes(1);
    expect(h.err()).toContain("authentication result is unchanged");
    expect(h.err()).not.toContain("raw-private-filesystem-error");
    const snapshots = h
      .out()
      .trim()
      .split("\n")
      .map((line) => parseSnapshot(JSON.parse(line)));
    expect(snapshots.filter((s) => s.status === "done")).toEqual([
      {
        status: "done",
        result: { status: "authenticated", save: { status: "not-saved" } },
      },
    ]);
  },
);

it("records overflow from a stalled writer without blocking or replacing the auth result", async () => {
  const h = harness(true);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstWrite = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const lines: string[] = [];
  const file = {
    async writeFile(data: unknown) {
      lines.push(String(data));
      if (lines.length === 1) {
        for (let i = 0; i < 70; i++) h.flow.diagnostics.emit({ type: "start" });
        entered();
        await gate;
      }
    },
    sync: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  h.deps.openTranscript = async () => file;
  const run = runCli(h.args, h.deps);
  await firstWrite;
  expect((await h.flow.result).status).toBe("authenticated");
  release();
  expect(await run).toBe(1);
  expect(
    lines
      .map((line) => JSON.parse(line))
      .some((event) => event.type === "gap" && event.reason === "overflow"),
  ).toBe(true);
  const snapshots = h
    .out()
    .trim()
    .split("\n")
    .map((line) => parseSnapshot(JSON.parse(line)));
  expect(snapshots.filter((s) => s.status === "done")).toEqual([
    {
      status: "done",
      result: { status: "authenticated", save: { status: "not-saved" } },
    },
  ]);
  expect(file.close).toHaveBeenCalledTimes(1);
  expect(h.login).toHaveBeenCalledTimes(1);
  expect(h.aborted()).toBe(false);
  expect(h.err()).toContain("authentication result is unchanged");
});

it("closes the new file if login construction throws", async () => {
  const h = harness(false);
  const close = vi.fn(async () => {});
  h.deps.openTranscript = async () => ({
    writeFile: async () => {},
    sync: async () => {},
    close,
  });
  h.login.mockImplementation(() => {
    throw new Error("private-login-error");
  });
  expect(await runCli(h.args, h.deps)).toBe(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(h.err()).not.toContain("private-login-error");
});
