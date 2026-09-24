import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
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
    import { snapshotSchema } from '@browser-auth/core/protocol';
    import { createOtlpTracing } from '@browser-auth/core/tracing';
    import { AuthPanel, useAuthFlow } from '@browser-auth/react';
    assert.equal(typeof createAuth, 'function');
    assert.deepEqual(await new InMemoryStore().list(), []);
    assert.equal(snapshotSchema.parse({status:'running',message:'test'}).status, 'running');
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
  await writeFile(
    join(directory, "consumer.mts"),
    `import { createAuth, type AuthOptions, type AuthResult } from '@browser-auth/core';
import { snapshotSchema } from '@browser-auth/core/protocol';
const options = { agent: { async next() { return { kind: 'wait' as const }; } } } satisfies AuthOptions;
const auth = createAuth(options);
const snapshot = snapshotSchema.parse({status:'running',message:'test'});
const result: AuthResult = { status: 'authenticated', save: {status:'not-saved'} };
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
    "Packed SDK/protocol/tracing/React exports, CSS, executable CLI and consumer types passed.\n",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
