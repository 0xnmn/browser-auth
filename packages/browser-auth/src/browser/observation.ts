import { randomUUID } from "node:crypto";
import type { ElementHandle, Frame, Page } from "playwright-core";
import { AuthFailure } from "../errors.js";
import { originOf } from "../security/origins.js";
import type { Redactor } from "../security/redaction.js";

export interface BrowserObservedElement {
  id: string;
  origin: string;
  tag: string;
  type: string;
  label: string;
  autocomplete: string;
  /** Presence only, never the value or its length. */
  filled?: boolean;
  expanded?: boolean;
  options?: Array<{
    index: number;
    label: string;
    disabled: boolean;
    selected: boolean;
  }>;
}

export interface BrowserObservation {
  origin: string;
  text: string;
  elements: BrowserObservedElement[];
  /** A bounded, hierarchical accessibility-oriented tree. Element refs are our captured ids. */
  tree: string;
  screenshot?: {
    mediaType: "image/png";
    data: string;
    width: number;
    height: number;
  };
}

export type BrowserAction =
  | { kind: "click"; elementId: string }
  | { kind: "doubleClick"; elementId: string }
  | { kind: "hover"; elementId: string }
  | { kind: "focus"; elementId: string }
  | { kind: "press"; elementId: string; key: BrowserKey }
  | { kind: "scroll"; elementId?: string; deltaX?: number; deltaY: number }
  | { kind: "check"; elementId: string; checked: boolean }
  | { kind: "select"; elementId: string; indices: number[] }
  | { kind: "drag"; sourceElementId: string; targetElementId: string }
  | { kind: "navigate"; url: string }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  | { kind: "wait"; milliseconds: number }
  | { kind: "inspect"; elementId: string };

export type BrowserKey =
  | "Enter"
  | "Tab"
  | "Escape"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown"
  | "Space";

export type BrowserActionResult =
  | { kind: "done" }
  | {
      kind: "inspection";
      element: BrowserObservedElement;
      visible: boolean;
      enabled: boolean;
      checked?: boolean;
      selectedIndex?: number;
    };

interface Reference {
  element: ElementHandle;
  frame: Frame;
  frameUrl: string;
  pageUrl: string;
  origin: string;
  metadata: BrowserObservedElement;
}

interface TreeNode {
  role: string;
  name?: string;
  ref?: string;
  children?: TreeNode[];
}

interface OutputTreeNode {
  role: string;
  name?: string;
  ref?: string;
  children?: OutputTreeNode[];
}

const INTERACTIVE =
  "input, textarea, button, a[href], [role=button], [role=menuitem], [role=option], [aria-expanded], select, [contenteditable], [tabindex]";

/** Handles are captured per observation, never rematched by selector after a prompt. */
export class BrowserSurface {
  private readonly references = new Map<string, Reference>();
  private readonly documents: Array<{
    root: ElementHandle;
    frame: Frame;
    url: string;
    text: string;
  }> = [];

  constructor(
    readonly page: Page,
    private readonly timeout: number,
    private readonly onWrite: () => void = () => {},
  ) {}

  async clear(): Promise<void> {
    const refs = [...this.references.values()];
    this.references.clear();
    await Promise.all(refs.map((ref) => ref.element.dispose().catch(() => {})));
    await Promise.all(
      this.documents
        .splice(0)
        .map(({ root }) => root.dispose().catch(() => {})),
    );
  }

  async observe(redactor: Redactor): Promise<BrowserObservation> {
    await this.clear();
    if (this.page.url() === "about:blank") {
      return {
        origin: "null",
        text: "",
        elements: [],
        tree: "[]",
      };
    }
    const elements: BrowserObservedElement[] = [];
    const texts: string[] = [];
    const trees: Array<{ role: string; name: string; children: TreeNode[] }> =
      [];
    for (const frame of this.page.frames().slice(0, 10)) {
      let origin: string;
      try {
        origin = originOf(frame.url());
      } catch {
        continue;
      }
      const text = await frame
        .locator("body")
        .evaluate((body) => {
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
          const text: string[] = [];
          while (walker.nextNode()) {
            const parent = walker.currentNode.parentElement;
            if (
              !parent ||
              parent.closest(
                "input,textarea,[contenteditable], [role=textbox],script,style,noscript",
              )
            )
              continue;
            if (!parent.checkVisibility()) continue;
            text.push(walker.currentNode.textContent ?? "");
          }
          return text.join(" ");
        })
        .catch(() => "");
      const root = await frame.locator("html").elementHandle();
      if (root)
        this.documents.push({
          root,
          frame,
          url: frame.url(),
          text: await frame
            .locator("body")
            .innerText({ timeout: this.timeout })
            .then((value) => value.slice(0, 6000))
            .catch(() => ""),
        });
      texts.push(redactor.text(text).slice(0, 6000));

      const handles = await frame.locator(INTERACTIVE).elementHandles();
      const captured: Array<{ element: ElementHandle; id: string }> = [];
      for (const element of handles) {
        if (
          elements.length >= 100 ||
          !(await element.isVisible()) ||
          !(await element.isEnabled()) ||
          (await element.evaluate((node) => {
            const privateAncestor = node.parentElement?.closest(
              "input,textarea,[contenteditable],[role=textbox]",
            );
            return privateAncestor != null;
          }))
        ) {
          await element.dispose();
          continue;
        }
        const raw = await element.evaluate((element) => {
          const node = element as HTMLElement;
          const input = element as HTMLInputElement;
          const privateSelector =
            "input,textarea,[contenteditable],[role=textbox]";
          // Object methods survive source runners' keepNames transforms when
          // Playwright serializes this callback into the browser.
          const textReader = {
            read(root: Element): string {
              const clone = root.cloneNode(true) as Element;
              if (clone.matches(privateSelector)) return "";
              for (const privateNode of clone.querySelectorAll(privateSelector))
                privateNode.remove();
              return clone.textContent ?? "";
            },
          };
          return {
            tag: node.tagName.toLowerCase(),
            type: node.getAttribute("type") ?? "",
            label:
              node.getAttribute("aria-label") ||
              (input.labels?.[0] ? textReader.read(input.labels[0]) : "") ||
              node.getAttribute("placeholder") ||
              (["INPUT", "TEXTAREA"].includes(node.tagName) ||
              node.isContentEditable
                ? node.getAttribute("name")
                : textReader.read(node)) ||
              "",
            autocomplete: node.getAttribute("autocomplete") ?? "",
            filled:
              (element instanceof HTMLInputElement &&
                [
                  "text",
                  "email",
                  "password",
                  "tel",
                  "search",
                  "url",
                  "number",
                ].includes(element.type)) ||
              element instanceof HTMLTextAreaElement
                ? (element as HTMLInputElement | HTMLTextAreaElement).value
                    .length > 0
                : node.isContentEditable
                  ? (node.textContent ?? "").length > 0
                  : undefined,
            expanded: node.getAttribute("aria-expanded"),
            options:
              element instanceof HTMLSelectElement
                ? [...element.options].map((option) => ({
                    index: option.index,
                    label: textReader.read(option),
                    disabled: option.disabled,
                    selected: option.selected,
                  }))
                : undefined,
          };
        });
        const id = randomUUID();
        const metadata: BrowserObservedElement = {
          id,
          origin,
          tag: raw.tag,
          type: redactor.text(raw.type).slice(0, 80),
          autocomplete: redactor.text(raw.autocomplete).slice(0, 160),
          label: redactor.text(raw.label).slice(0, 160),
          ...(raw.filled === undefined ? {} : { filled: raw.filled }),
          ...(raw.expanded === "true" || raw.expanded === "false"
            ? { expanded: raw.expanded === "true" }
            : {}),
          ...(raw.options
            ? {
                options: raw.options.map((option) => ({
                  ...option,
                  label: redactor.text(option.label).slice(0, 160),
                })),
              }
            : {}),
        };
        captured.push({ element, id });
        this.references.set(id, {
          element,
          frame,
          frameUrl: frame.url(),
          pageUrl: this.page.url(),
          origin,
          metadata,
        });
        elements.push(metadata);
      }

      // Playwright AI refs are deliberately not used: they are snapshot-local and do not
      // prove identity at dispatch. This DOM-grouped tree maps only captured handles.
      const tree = await frame
        .locator("body")
        .evaluate(
          (body, refs) => {
            const referenced = new Map<Node, string>(
              refs.elements.map((node, index) => [node, refs.ids[index]!]),
            );
            let count = 0;
            const visitor = {
              visit(node: Element, depth: number): TreeNode | undefined {
                if (
                  count >= 500 ||
                  depth > 12 ||
                  node.getAttribute("aria-hidden") === "true"
                )
                  return;
                const style = getComputedStyle(node);
                if (style.display === "none" || style.visibility === "hidden")
                  return;
                const privateNode =
                  node.matches("input, textarea, [contenteditable]") ||
                  node.getAttribute("role") === "textbox";
                const children = privateNode
                  ? []
                  : [...node.children]
                      .map((child) => visitor.visit(child, depth + 1))
                      .filter((child): child is TreeNode => !!child);
                const ref = referenced.get(node);
                const role =
                  node.getAttribute("role") ||
                  (
                    {
                      A: "link",
                      BUTTON: "button",
                      INPUT: "input",
                      SELECT: "select",
                      FORM: "form",
                      NAV: "navigation",
                      MAIN: "main",
                    } as Record<string, string>
                  )[node.tagName] ||
                  "group";
                const ownText = privateNode
                  ? ""
                  : [...node.childNodes]
                      .filter((child) => child.nodeType === Node.TEXT_NODE)
                      .map((child) => child.textContent ?? "")
                      .join(" ")
                      .replace(/\s+/g, " ")
                      .trim();
                const name = (node.getAttribute("aria-label") || ownText).slice(
                  0,
                  160,
                );
                if (ref === undefined && !name && children.length === 0) return;
                count++;
                return {
                  role,
                  ...(name ? { name } : {}),
                  ...(ref === undefined ? {} : { ref }),
                  ...(children.length ? { children } : {}),
                };
              },
            };
            return [...body.children]
              .map((node) => visitor.visit(node, 0))
              .filter((node): node is TreeNode => !!node);
          },
          {
            elements: captured.map(({ element }) => element),
            ids: captured.map(({ id }) => id),
          },
        )
        .catch(() => [] as TreeNode[]);
      const rewrite = (node: TreeNode): OutputTreeNode => ({
        role: redactor.text(node.role).slice(0, 80),
        ...(node.name ? { name: redactor.text(node.name).slice(0, 160) } : {}),
        ...(node.ref ? { ref: node.ref } : {}),
        ...(node.children ? { children: node.children.map(rewrite) } : {}),
      });
      trees.push({
        role: "document",
        name: origin,
        children: tree.map(rewrite),
      });
    }
    // Withhold images after private values are known: a page can echo them outside fields.
    // Before then mask editable controls in every frame. This is accidental-exposure
    // mitigation, not confidentiality against a hostile page or pre-existing account data.
    let screenshot: BrowserObservation["screenshot"];
    if (!redactor.hasValues) {
      try {
        const viewport = await this.page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        }));
        const bytes = await this.page.screenshot({
          type: "png",
          timeout: this.timeout,
          mask: this.page
            .frames()
            .map((frame) =>
              frame.locator("input,textarea,[contenteditable],[role=textbox]"),
            ),
          maskColor: "#000000",
        });
        screenshot = {
          mediaType: "image/png",
          data: bytes.toString("base64"),
          ...viewport,
        };
      } catch {
        /* A capture that cannot be masked is withheld. */
      }
    }
    return {
      origin: originOf(this.page.url()),
      text: texts.join("\n").slice(0, 12000),
      elements,
      tree: JSON.stringify(trees).slice(0, 40_000),
      ...(screenshot ? { screenshot } : {}),
    };
  }

  /** Session decisions must not rely on an obsolete document or visible state. */
  async validateSession(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    for (const { root, frame, url, text } of this.documents) {
      const current =
        frame.url() === url &&
        !frame.isDetached() &&
        (await root
          .evaluate(
            (node, previousText) =>
              node === document.documentElement &&
              document.body.innerText.slice(0, 6000) === previousText,
            text,
          )
          .catch(() => false));
      if (!current)
        throw new AuthFailure(
          "stale_page",
          "The page changed; start a new authentication attempt",
        );
    }
    if (!this.documents.length)
      throw new AuthFailure(
        "stale_page",
        "The session observation is no longer available",
      );
    signal.throwIfAborted();
  }

  async validate(id: string, signal: AbortSignal): Promise<Reference> {
    signal.throwIfAborted();
    const ref = this.references.get(id);
    if (
      !ref ||
      ref.frame.isDetached() ||
      this.page.url() !== ref.pageUrl ||
      ref.frame.url() !== ref.frameUrl ||
      !(await ref.element.evaluate((node) => node.isConnected))
    )
      throw new AuthFailure(
        "stale_page",
        "The page changed; start a new authentication attempt",
      );
    if (!(await ref.element.isVisible()) || !(await ref.element.isEnabled()))
      throw new AuthFailure(
        "stale_page",
        "The authentication control is no longer available",
      );
    signal.throwIfAborted();
    return ref;
  }

  async fill(
    id: string,
    value: string,
    expectedOrigin: string,
    signal: AbortSignal,
  ): Promise<void> {
    const ref = await this.validate(id, signal);
    if (
      ref.origin !== expectedOrigin ||
      originOf(ref.frame.url()) !== expectedOrigin
    )
      throw new AuthFailure("origin_changed", "Credential destination changed");
    if (!(await ref.element.isEditable()))
      throw new AuthFailure(
        "invalid_field",
        "The credential field is not editable",
      );
    signal.throwIfAborted();
    this.onWrite();
    await ref.element.fill(value, { timeout: this.timeout });
  }

  async isFormSubmit(
    fieldIds: string[],
    submitId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const submit = await this.validate(submitId, signal);
    const fields = await Promise.all(
      fieldIds.map((id) => this.validate(id, signal)),
    );
    if (!fields.length || fields.some((field) => field.frame !== submit.frame))
      return false;
    return submit.element.evaluate(
      (node, inputs) => {
        const button = node as HTMLButtonElement;
        return (
          !!button.form &&
          ["BUTTON", "INPUT"].includes(button.tagName) &&
          button.type === "submit" &&
          inputs.every(
            (input) => (input as HTMLInputElement).form === button.form,
          )
        );
      },
      fields.map((field) => field.element),
    );
  }

  async click(id: string, signal: AbortSignal): Promise<void> {
    const ref = await this.validate(id, signal);
    this.onWrite();
    await ref.element.click({ timeout: this.timeout });
  }

  async execute(
    action: BrowserAction,
    signal: AbortSignal,
  ): Promise<BrowserActionResult> {
    signal.throwIfAborted();
    if (action.kind === "wait") {
      if (
        !Number.isFinite(action.milliseconds) ||
        action.milliseconds < 0 ||
        action.milliseconds > this.timeout
      )
        throw new AuthFailure(
          "invalid_action",
          "Wait is outside the allowed range",
        );
      await this.page.waitForTimeout(action.milliseconds);
      signal.throwIfAborted();
      return { kind: "done" };
    }
    if (action.kind === "inspect") {
      const ref = await this.validate(action.elementId, signal);
      const state = await ref.element.evaluate((node) => ({
        checked:
          node instanceof HTMLInputElement &&
          ["checkbox", "radio"].includes(node.type)
            ? node.checked
            : undefined,
        selectedIndex:
          node instanceof HTMLSelectElement ? node.selectedIndex : undefined,
      }));
      return {
        kind: "inspection",
        element: ref.metadata,
        visible: true,
        enabled: true,
        ...(state.checked === undefined ? {} : { checked: state.checked }),
        ...(state.selectedIndex === undefined
          ? {}
          : { selectedIndex: state.selectedIndex }),
      };
    }
    try {
      if (action.kind === "navigate") {
        originOf(action.url);
        signal.throwIfAborted();
        this.onWrite();
        await this.page.goto(action.url, { timeout: this.timeout });
      } else if (action.kind === "back") {
        this.onWrite();
        await this.page.goBack({ timeout: this.timeout });
      } else if (action.kind === "forward") {
        this.onWrite();
        await this.page.goForward({ timeout: this.timeout });
      } else if (action.kind === "reload") {
        this.onWrite();
        await this.page.reload({ timeout: this.timeout });
      } else if (action.kind === "scroll" && !action.elementId) {
        const x = boundedDelta(action.deltaX ?? 0);
        const y = boundedDelta(action.deltaY);
        this.onWrite();
        await this.page.mouse.wheel(x, y);
      } else if (action.kind === "drag") {
        const source = await this.validate(action.sourceElementId, signal);
        const target = await this.validate(action.targetElementId, signal);
        const [sourceBox, targetBox] = await Promise.all([
          source.element.boundingBox(),
          target.element.boundingBox(),
        ]);
        if (!sourceBox || !targetBox)
          throw new AuthFailure(
            "stale_page",
            "The authentication control is no longer available",
          );
        this.onWrite();
        await this.page.mouse.move(
          sourceBox.x + sourceBox.width / 2,
          sourceBox.y + sourceBox.height / 2,
        );
        await this.page.mouse.down();
        await this.page.mouse.move(
          targetBox.x + targetBox.width / 2,
          targetBox.y + targetBox.height / 2,
          { steps: 5 },
        );
        await this.page.mouse.up();
      } else {
        const id = action.elementId;
        if (!id)
          throw new AuthFailure(
            "invalid_action",
            "The browser action requires an element",
          );
        const ref = await this.validate(id, signal);
        if (
          action.kind === "select" &&
          (action.indices.length > 20 ||
            action.indices.some(
              (index) => !Number.isInteger(index) || index < 0 || index > 1000,
            ))
        )
          throw new AuthFailure(
            "invalid_action",
            "Option index is outside the allowed range",
          );
        if (action.kind === "select") {
          const optionCount = await ref.element.evaluate((node) =>
            node instanceof HTMLSelectElement ? node.options.length : -1,
          );
          if (
            optionCount < 0 ||
            action.indices.some((index) => index >= optionCount)
          )
            throw new AuthFailure(
              "invalid_action",
              "Option index is unavailable",
            );
        }
        this.onWrite();
        switch (action.kind) {
          case "click":
            await ref.element.click({ timeout: this.timeout });
            break;
          case "doubleClick":
            await ref.element.dblclick({ timeout: this.timeout });
            break;
          case "hover":
            await ref.element.hover({ timeout: this.timeout });
            break;
          case "focus":
            await ref.element.focus();
            break;
          case "press":
            await ref.element.press(action.key, { timeout: this.timeout });
            break;
          case "scroll":
            await ref.element.evaluate(
              (node, delta) => (node as Element).scrollBy(delta.x, delta.y),
              {
                x: boundedDelta(action.deltaX ?? 0),
                y: boundedDelta(action.deltaY),
              },
            );
            break;
          case "check":
            action.checked
              ? await ref.element.check({ timeout: this.timeout })
              : await ref.element.uncheck({ timeout: this.timeout });
            break;
          case "select": {
            const changed = await ref.element.evaluate((node, indices) => {
              if (
                !(node instanceof HTMLSelectElement) ||
                indices.some((index) => index >= node.options.length)
              )
                return false;
              for (const option of node.options)
                option.selected = indices.includes(option.index);
              node.dispatchEvent(new Event("input", { bubbles: true }));
              node.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }, action.indices);
            if (!changed)
              throw new AuthFailure(
                "invalid_action",
                "Option index is unavailable",
              );
            break;
          }
        }
      }
      return { kind: "done" };
    } catch (error) {
      if (error instanceof AuthFailure) throw error;
      throw new AuthFailure(
        "browser_action_failed",
        "The browser action did not complete",
      );
    }
  }
}

function boundedDelta(value: number): number {
  if (!Number.isFinite(value))
    throw new AuthFailure(
      "invalid_action",
      "Scroll is outside the allowed range",
    );
  return Math.max(-10_000, Math.min(10_000, value));
}
