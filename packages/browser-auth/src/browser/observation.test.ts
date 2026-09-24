import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Redactor } from "../security/redaction.js";
import { BrowserSurface } from "./observation.js";

describe("BrowserSurface", () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let origin: string;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><body></body>");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("test server unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
  });

  test("returns an empty opaque observation for a new blank tab", async () => {
    const blank = await browser.newPage();
    const surface = new BrowserSurface(blank, 2_000);

    await expect(surface.observe(new Redactor())).resolves.toEqual({
      origin: "null",
      text: "",
      elements: [],
      tree: "[]",
    });

    await blank.close();
  });

  test("still rejects unsupported non-blank page origins", async () => {
    await page.goto("data:text/html,<body>unsupported</body>");
    const surface = new BrowserSurface(page, 2_000);

    await expect(surface.observe(new Redactor())).rejects.toThrow(
      "Unsupported authentication URL",
    );
  });

  test("returns nested own refs and omits private values and screenshots", async () => {
    await page.goto(origin);
    await page.setContent(`
      <main><form><section><label>User <input name="user" value="private-value"></label>
      <textarea aria-label="Notes">textarea-secret</textarea>
      <div contenteditable="true" aria-label="Editor">editable-secret</div>
      <button>Continue</button></section></form></main>`);
    const surface = new BrowserSurface(page, 2_000);
    const redactor = new Redactor();
    redactor.add("private-value");
    const observation = await surface.observe(redactor);
    const tree = JSON.parse(observation.tree) as unknown;

    expect(tree).toEqual(expect.any(Array));
    expect(observation.tree).toContain(observation.elements[0]!.id);
    expect(observation.tree).toContain('"children"');
    expect(observation.tree).not.toContain("private-value");
    expect(observation.tree).not.toContain("textarea-secret");
    expect(observation.tree).not.toContain("editable-secret");
    expect(observation.text).not.toContain("textarea-secret");
    expect(observation.screenshot).toBeUndefined();
    await surface.clear();
  });

  test("omits unknown private text from every textual observation channel", async () => {
    await page.goto(origin);
    await page.setContent(`
      <main>Public
        <label>Account <input value="input-canary"></label>
        <div>Before <div contenteditable>empty-attribute-canary</div> After</div>
        <div contenteditable="plaintext-only">plaintext-canary</div>
        <div role="textbox">role-canary</div>
        <textarea>textarea-canary</textarea>
      </main>`);
    const surface = new BrowserSurface(page, 2_000);
    const observation = await surface.observe(new Redactor());

    for (const canary of [
      "input-canary",
      "empty-attribute-canary",
      "plaintext-canary",
      "role-canary",
      "textarea-canary",
    ]) {
      expect(observation.text).not.toContain(canary);
      expect(JSON.stringify(observation.elements)).not.toContain(canary);
      expect(observation.tree).not.toContain(canary);
    }
    expect(observation.screenshot).toMatchObject({
      mediaType: "image/png",
      width: 1280,
      height: 720,
    });

    const known = new Redactor();
    known.add("known-private-value");
    expect((await surface.observe(known)).screenshot).toBeUndefined();
    await surface.clear();
  });

  test("omits interactive private descendants and redacts bounded tree roles", async () => {
    await page.goto(origin);
    await page.setContent(`
      <main role="role-canary-${"x".repeat(200)}">
        Public
        <div role="textbox" tabindex="0" aria-label="Private editor">
          editor-canary
          <button aria-label="button-canary">button-canary</button>
          <span contenteditable="false" tabindex="0">chip-canary</span>
        </div>
      </main>`);
    const surface = new BrowserSurface(page, 2_000);
    const redactor = new Redactor();
    redactor.add("role-canary");
    const observation = await surface.observe(redactor);
    const textualObservation = JSON.stringify({
      origin: observation.origin,
      text: observation.text,
      elements: observation.elements,
      tree: observation.tree,
    });

    for (const canary of ["editor-canary", "button-canary", "chip-canary"])
      expect(textualObservation).not.toContain(canary);
    expect(observation.elements).toHaveLength(1);
    expect(observation.elements[0]).toMatchObject({
      tag: "div",
      label: "Private editor",
    });
    const documentTree = JSON.parse(observation.tree) as Array<{
      children: Array<{ role: string }>;
    }>;
    expect(documentTree[0]!.children[0]!.role).toContain("[redacted]");
    expect(documentTree[0]!.children[0]!.role.length).toBeLessThanOrEqual(80);
    await surface.clear();
  });

  test("keeps tree refs bound to captured handle identity after DOM reorder", async () => {
    await page.goto(origin);
    await page.setContent(`
      <input id="first" aria-label="First">
      <input id="second" aria-label="Second">
      <script>
        const first = document.querySelector('#first');
        const original = first.getAttribute;
        let reordered = false;
        first.getAttribute = function(name) {
          if (!reordered && name === 'type') {
            reordered = true;
            document.body.append(first);
          }
          return original.call(this, name);
        };
      </script>`);
    const surface = new BrowserSurface(page, 2_000);
    const observation = await surface.observe(new Redactor());
    const firstId = observation.elements.find(
      (element) => element.label === "First",
    )!.id;
    const firstTreeNode = JSON.parse(observation.tree)
      .flatMap((document: { children: unknown[] }) => document.children)
      .find((node: { name?: string }) => node.name === "First") as {
      ref: string;
    };

    expect(firstTreeNode.ref).toBe(firstId);
    await surface.execute(
      { kind: "focus", elementId: firstTreeNode.ref },
      AbortSignal.timeout(2_000),
    );
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("first");
    await surface.clear();
  });

  test("executes bounded controls and rejects stale captured identity before write", async () => {
    await page.goto(origin);
    await page.setContent(`
      <style>#scroll { height: 40px; overflow:auto } #space { height:300px }</style>
      <button id="hover" onmouseenter="this.dataset.hovered='yes'">Hover</button>
      <input id="key" aria-label="Key" onkeydown="this.dataset.key=event.key">
      <select><option>A</option><option>B</option></select>
      <div id="scroll" tabindex="0" aria-label="Scroller"><div id="space"><button id="bottom">Bottom</button></div></div>`);
    let writes = 0;
    const surface = new BrowserSurface(page, 2_000, () => writes++);
    const observed = await surface.observe(new Redactor());
    const byLabel = (label: string) =>
      observed.elements.find((item) => item.label === label)!.id;
    const select = observed.elements.find((item) => item.tag === "select")!.id;
    expect(
      observed.elements.find((item) => item.tag === "select")!.options,
    ).toEqual([
      { index: 0, label: "A", disabled: false, selected: true },
      { index: 1, label: "B", disabled: false, selected: false },
    ]);

    await surface.execute(
      { kind: "hover", elementId: byLabel("Hover") },
      AbortSignal.timeout(2_000),
    );
    await surface.execute(
      { kind: "press", elementId: byLabel("Key"), key: "Enter" },
      AbortSignal.timeout(2_000),
    );
    await surface.execute(
      { kind: "select", elementId: select, indices: [1] },
      AbortSignal.timeout(2_000),
    );
    await surface.execute(
      { kind: "scroll", elementId: byLabel("Scroller"), deltaY: 100 },
      AbortSignal.timeout(2_000),
    );
    expect(await page.locator("#hover").getAttribute("data-hovered")).toBe(
      "yes",
    );
    expect(await page.locator("#key").getAttribute("data-key")).toBe("Enter");
    expect(
      await page
        .locator("select")
        .evaluate((node) => (node as HTMLSelectElement).selectedIndex),
    ).toBe(1);
    expect(
      await page.locator("#scroll").evaluate((node) => node.scrollTop),
    ).toBeGreaterThan(0);

    const stale = byLabel("Hover");
    await page
      .locator("#hover")
      .evaluate((node) => node.replaceWith(node.cloneNode(true)));
    const before = writes;
    await expect(
      surface.execute(
        { kind: "click", elementId: stale },
        AbortSignal.timeout(2_000),
      ),
    ).rejects.toMatchObject({ code: "stale_page" });
    expect(writes).toBe(before);
    await surface.clear();
  });
});
