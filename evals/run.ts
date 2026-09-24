import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAuth,
  InMemoryStore,
} from "../packages/browser-auth/src/index.js";
import type { AuthOptions } from "../packages/browser-auth/src/index.js";
import { createAuthWithAgent } from "../packages/browser-auth/src/auth.js";
import {
  startAuthSite,
  fixturePassword,
  fixtureCode,
} from "../tests/fixtures/auth-site.js";
import { FixtureAgent } from "../tests/helpers/scripted-agent.js";
import { authTarget, launchSharedBrowser } from "../tests/helpers/browser.js";
import { complete, defaultResponse } from "../tests/helpers/respond.js";

async function run() {
  const args = process.argv.slice(2);
  if (
    !(args.length === 1 && args[0] === "--scripted") &&
    !(args.length === 2 && args[0] === "--config")
  )
    throw new Error("usage");
  const options: AuthOptions | undefined =
    args[0] === "--scripted"
      ? undefined
      : (await import(pathToFileURL(resolve(args[1]!)).href)).default;
  const site = await startAuthSite();
  const results = [];
  try {
    for (const [name, path] of [
      ["password", "/"],
      ["multi-step", "/multi"],
      ["manual-code", "/otp"],
    ] as const) {
      const browser = await launchSharedBrowser();
      const context = browser.context;
      const started = performance.now();
      try {
        const page = await context.newPage();
        await page.goto(`${site.url}${path}`);
        const store = new InMemoryStore();
        const common = {
          store,
          limits: { maxSteps: 15, timeoutMs: 60_000 },
        };
        const auth = options
          ? createAuth({ ...options, ...common })
          : createAuthWithAgent({ agent: new FixtureAgent(), ...common });
        const run = await complete(
          auth.login({ ...authTarget(browser, page), save: "yes" }),
          async (interaction) => {
            if (
              interaction.kind === "confirm" &&
              interaction.confirmation.kind === "confirm-sign-in" &&
              !(await page.locator("body").innerText()).includes(
                "Signed in as alice",
              )
            )
              return {
                kind: "choose",
                interactionId: interaction.id,
                choiceId: "no",
              };
            return defaultResponse(interaction);
          },
        );
        const payload = JSON.stringify(run.snapshots);
        const pass =
          run.result.status === "authenticated" &&
          (await page.locator("body").innerText()).includes(
            "Signed in as alice",
          ) &&
          !payload.includes(fixturePassword) &&
          !payload.includes(fixtureCode) &&
          (path !== "/otp" || (await store.list()).length === 0);
        results.push({
          scenario: name,
          pass,
          status: run.result.status,
          durationMs: Math.round(performance.now() - started),
        });
      } finally {
        await browser.close();
      }
    }
  } finally {
    await site.close();
  }
  process.stdout.write(
    `${JSON.stringify({ mode: args[0] === "--scripted" ? "scripted-smoke-not-model-evaluation" : "configured-agent", results }, null, 2)}\n`,
  );
  if (results.some((result) => !result.pass)) process.exitCode = 1;
}

try {
  await run();
} catch {
  process.stderr.write(
    "Evaluation failed. Usage: pnpm eval --scripted OR pnpm eval --config <trusted-module>. No raw provider errors are printed.\n",
  );
  process.exitCode = 1;
}
