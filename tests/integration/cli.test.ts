import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchSharedBrowser } from "../helpers/browser.js";
import { startAuthSite, fixturePassword } from "../fixtures/auth-site.js";
import { defaultResponse } from "../helpers/respond.js";
import { parseSnapshot } from "../../packages/browser-auth/src/protocol.js";
import { FixtureAgent } from "../helpers/scripted-agent.js";

it("runs the CLI subprocess end-to-end against an existing CDP browser using JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-auth-cli-"));
  const site = await startAuthSite();
  const shared = await launchSharedBrowser();
  const agent = new FixtureAgent();
  let transientFailures = 0;
  const model = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { messages } = JSON.parse(body);
      const content = messages.find(
        (message: { role: string }) => message.role === "user",
      ).content;
      const observation = JSON.parse(
        typeof content === "string"
          ? content
          : content.find((part: { type: string }) => part.type === "text").text,
      );
      if (
        !transientFailures &&
        observation.history?.some((entry: string) =>
          entry.startsWith("Field receipt:"),
        )
      ) {
        transientFailures++;
        response
          .writeHead(503, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              error: { message: "Synthetic transient failure" },
            }),
          );
        return;
      }
      const proposal = await agent.next(observation);
      const { kind, ...args } = proposal;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "fixture",
          created: 1,
          model: "fixture",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-fixture",
                    type: "function",
                    function: { name: kind, arguments: JSON.stringify(args) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    } catch {
      response.writeHead(500).end();
    }
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const page = await shared.context.newPage();
    await page.goto(site.url);
    const config = join(directory, "config.mjs");
    await writeFile(
      config,
      `export default ${JSON.stringify({
        model: {
          provider: "openai-compatible",
          model: "fixture",
          apiKey: "synthetic-key",
          baseURL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
        },
      })};`,
    );
    const input = join(directory, "input.json");
    await writeFile(
      input,
      JSON.stringify({
        cdpUrl: shared.cdpUrl,
        url: page.url(),
        credentials: { username: "alice" },
        save: "never",
      }),
      { mode: 0o600 },
    );
    const root = fileURLToPath(new URL("../../", import.meta.url));
    child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/browser-auth/src/cli/main.ts",
        "login",
        "--config",
        config,
        "--input",
        input,
        "--json",
      ],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
    );
    const exited = new Promise<number | null>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", resolve);
    });
    let errors = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk) => {
      errors += chunk;
    });
    const snapshots = [];
    for await (const line of createInterface({ input: child.stdout! })) {
      const snapshot = parseSnapshot(JSON.parse(line));
      snapshots.push(snapshot);
      if (snapshot.status === "waiting")
        child.stdin!.write(
          JSON.stringify(defaultResponse(snapshot.interaction)) + "\n",
        );
    }
    expect(await exited, JSON.stringify(snapshots.at(-1))).toBe(0);
    expect(transientFailures).toBe(1);
    expect(snapshots).toContainEqual({
      status: "running",
      message:
        "Model temporarily unavailable; retrying without repeating browser actions",
    });
    // The compatible provider warns that strict structured output is unavailable.
    expect(errors).not.toContain("browser-auth could not");
    expect(errors).not.toContain(fixturePassword);
    expect(agent.observations.length).toBeGreaterThan(0);
    expect(agent.observations[0]!.tree).toContain('"ref"');
    expect(agent.observations[0]!.tree).toContain("Username");
    expect(snapshots.at(-1)).toMatchObject({
      status: "done",
      result: { status: "authenticated" },
    });
    expect(JSON.stringify(snapshots)).not.toContain(fixturePassword);
    expect(await page.locator("body").innerText()).toContain(
      "Signed in as alice",
    );
    expect(page.isClosed()).toBe(false);
  } finally {
    if (child && child.exitCode === null) child.kill();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await shared.close();
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});
