import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "browser-auth-package-"));
try {
  for (const name of ["browser-auth", "react"])
    await exec("pnpm", ["pack", "--pack-destination", directory], {
      cwd: join(root, "packages", name),
    });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "smoke-consumer", private: true, type: "module" }),
  );
  const react = JSON.parse(
    await readFile(
      join(root, "packages/react/node_modules/react/package.json"),
      "utf8",
    ),
  ) as { version: string };
  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `file:${join(directory, "browser-auth-core-0.1.0.tgz")}`,
      `file:${join(directory, "browser-auth-react-0.1.0.tgz")}`,
      `react@${react.version}`,
    ],
    { cwd: directory },
  );
  const checked = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { createAuth, InMemoryStore } from '@browser-auth/core';
    import * as core from '@browser-auth/core';
    import { parseSnapshot } from '@browser-auth/core/protocol';
    import { createOtlpTracing } from '@browser-auth/core/tracing';
    import { AuthPanel, useAuthFlow } from '@browser-auth/react';
    assert.equal(typeof createAuth, 'function');
    assert.equal('parseProposal' in core, false);
    assert.equal('createAuthWithAgent' in core, false);
    assert.deepEqual(await new InMemoryStore().list(), []);
    assert.equal(parseSnapshot({status:'running',message:'test'}).status, 'running');
    assert.equal(typeof createOtlpTracing, 'function');
    assert.equal(typeof AuthPanel, 'function');
    assert.equal(typeof useAuthFlow, 'function');
    const { access } = await import('node:fs/promises');
    await access(new URL(import.meta.resolve('@browser-auth/react/styles.css')));
    console.log('All packed exports load');
  `,
    ],
    { cwd: directory },
  );
  assert.match(checked.stdout, /All packed exports load/);
  const cli = await exec(
    join(directory, "node_modules/.bin/browser-auth"),
    ["--help"],
    { cwd: directory },
  );
  assert.match(cli.stdout, /Usage: browser-auth/);
  for (const name of ["core", "react"]) {
    const dist = join(directory, `node_modules/@browser-auth/${name}/dist`);
    for (const file of await readdir(dist, { recursive: true })) {
      if (!file.endsWith(".d.ts")) continue;
      const declaration = await readFile(join(dist, file), "utf8");
      for (const match of declaration.matchAll(
        /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g,
      )) {
        const dependency = match[1]!;
        assert.ok(
          dependency.startsWith(".") ||
            (name === "react" &&
              [
                "react",
                "react/jsx-runtime",
                "@browser-auth/core/protocol",
              ].includes(dependency)),
          `Internal dependency leaked into ${name}/${file}: ${dependency}`,
        );
      }
    }
  }
  await writeFile(
    join(directory, "consumer.mts"),
    `import { createAuth, type AuthOptions, type AuthResult } from '@browser-auth/core';
import { parseSnapshot } from '@browser-auth/core/protocol';
const options = { model: {provider:'openai',model:'example-model'} } satisfies AuthOptions;
// @ts-expect-error Custom agents are internal, not configuration.
createAuth({...options,agent:{async next(){return {kind:'wait'};}}});
// @ts-expect-error Agent contracts are not public exports.
import type { AuthAgent, AuthObservation, AuthProposal, ObservedElement } from '@browser-auth/core';
// @ts-expect-error Proposal parsing is internal.
import { parseProposal } from '@browser-auth/core';
const auth = createAuth(options);
const snapshot = parseSnapshot({status:'running',message:'test'});
const result: AuthResult = { status: 'authenticated', save: {status:'not-saved'} };
createAuth({model: {provider:'openai',model:'example-model'}});
createAuth({model: {provider:'openai',model:'example-model',api:'chat',baseURL:'https://proxy.example/v1'}});
createAuth({model: {provider:'gateway',model:'anthropic/primary',providerOptions:{gateway:{only:['anthropic'],models:['anthropic/fallback']}}}});
createAuth({model: {provider:'openai-compatible',model:'fixture',baseURL:'https://proxy.example/v1',supportsStructuredOutputs:true,queryParams:{region:'eu'}}});
// @ts-expect-error Compatible endpoints require a baseURL.
createAuth({model: {provider:'openai-compatible',model:'fixture'}});
// @ts-expect-error API mode selection is specific to OpenAI.
createAuth({model: {provider:'anthropic',model:'fixture',api:'chat'}});
// @ts-expect-error Gateway routing must not be silently ignored by direct providers.
createAuth({model: {provider:'openai',model:'fixture',providerOptions:{gateway:{only:['vertex']}}}});
// @ts-expect-error Browser implementation objects are not public targets.
auth.login({page:{}});
// @ts-expect-error AI SDK model objects are not public model configuration.
createAuth({model: {specificationVersion:'v4',modelId:'example'}});
// @ts-expect-error OpenTelemetry tracers are not public tracing contracts.
createAuth({...options,tracer:{startSpan(){}}});
void auth; void snapshot; void result;
`,
  );
  await exec(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      join(directory, "consumer.mts"),
    ],
    { cwd: directory },
  );
  process.stdout.write(
    "Packed exports, CLI, consumer types and dependency-free public declarations passed.\n",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
