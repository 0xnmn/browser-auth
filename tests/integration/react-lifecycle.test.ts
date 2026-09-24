import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Page } from "playwright-core";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let closeServer: (() => Promise<void>) | undefined;
let url = "";

const snapshot = (page: Page) => page.getByTestId("snapshot").innerText();
const waitForRead = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => (window as any).lifecycle.pendingReads()))
    .toBe(1);

beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["tests/fixtures/react-lifecycle.tsx"],
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    nodePaths: ["packages/react/node_modules"],
  });
  const server = createServer((_request, response) => {
    response.setHeader(
      "content-type",
      _request.url === "/app.js" ? "text/javascript" : "text/html",
    );
    response.end(
      _request.url === "/app.js"
        ? bundle.outputFiles[0]!.text
        : '<div id="root"></div><script type="module" src="/app.js"></script>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
});

afterAll(async () => closeServer?.());

describe("useAuthFlow lifecycle", () => {
  it("turns premature EOF and rejected reads into an unknown result", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.evaluate(() => (window as any).lifecycle.mount());
      await waitForRead(page);
      await page.evaluate(() =>
        (window as any).lifecycle.emit({
          status: "running",
          message: "Working",
        }),
      );
      await expect.poll(() => snapshot(page)).toContain('"status":"running"');
      await waitForRead(page);
      await page.evaluate(() => (window as any).lifecycle.eof());
      await expect.poll(() => snapshot(page)).toContain('"status":"unknown"');

      await page.evaluate(() => (window as any).lifecycle.mount());
      await waitForRead(page);
      await page.evaluate(() =>
        (window as any).lifecycle.emit({
          status: "waiting",
          interaction: {
            id: "synthetic",
            kind: "external",
            message: "Waiting",
            choices: [],
          },
        }),
      );
      await expect.poll(() => snapshot(page)).toContain('"status":"waiting"');
      await waitForRead(page);
      await page.evaluate(() => (window as any).lifecycle.eof());
      await expect.poll(() => snapshot(page)).toContain('"status":"unknown"');

      await page.evaluate(() => (window as any).lifecycle.mount());
      await waitForRead(page);
      await page.evaluate(() => (window as any).lifecycle.error());
      await expect.poll(() => snapshot(page)).toContain('"status":"unknown"');
    } finally {
      await browser.close();
    }
  });

  it("preserves a terminal result across EOF and later read errors", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url);
      for (const ending of ["eof", "error"] as const) {
        await page.evaluate(() => (window as any).lifecycle.mount());
        await waitForRead(page);
        await page.evaluate(() =>
          (window as any).lifecycle.emit({
            status: "done",
            result: { status: "cancelled" },
          }),
        );
        await expect
          .poll(() => snapshot(page))
          .toContain('"status":"cancelled"');
        await waitForRead(page);
        await page.evaluate(
          (method) => (window as any).lifecycle[method](),
          ending,
        );
        await expect
          .poll(() => snapshot(page))
          .toContain('"status":"cancelled"');
      }
    } finally {
      await browser.close();
    }
  });

  it("handles synchronous subscription failures", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url);
      for (const failure of ["updates", "iterator"]) {
        await page.evaluate(
          (kind) => (window as any).lifecycle.mount(kind),
          failure,
        );
        await expect.poll(() => snapshot(page)).toContain('"status":"unknown"');
      }
    } finally {
      await browser.close();
    }
  });

  it("ignores pending reads after replacement or unmount and tears down", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.evaluate(() => (window as any).lifecycle.mount());
      await waitForRead(page);
      const previous = await page.evaluateHandle(() =>
        (window as any).lifecycle.replace(),
      );
      await expect
        .poll(() => previous.evaluate((value: any) => value.returns))
        .toBe(1);
      await previous.evaluate((value: any) =>
        value.send({
          kind: "value",
          value: { status: "running", message: "stale" },
        }),
      );
      await expect.poll(() => snapshot(page)).toBe("empty");
      await page.evaluate(() => (window as any).lifecycle.unmount());
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).lifecycle.currentReturns()),
        )
        .toBe(1);
    } finally {
      await browser.close();
    }
  });
});
