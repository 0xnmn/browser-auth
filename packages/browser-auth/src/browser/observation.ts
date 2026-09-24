import { randomUUID } from "node:crypto";
import type { ElementHandle, Frame, Page } from "playwright-core";
import type { AuthObservation, ObservedElement } from "../agent/proposals.js";
import { AuthFailure } from "../errors.js";
import { originOf } from "../security/origins.js";
import type { Redactor } from "../security/redaction.js";

interface Reference {
  element: ElementHandle;
  frame: Frame;
  frameUrl: string;
  pageUrl: string;
  origin: string;
}

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

  async observe(
    redactor: Redactor,
  ): Promise<Pick<AuthObservation, "origin" | "text" | "elements">> {
    await this.clear();
    const elements: ObservedElement[] = [];
    const texts: string[] = [];
    for (const frame of this.page.frames().slice(0, 10)) {
      let origin: string;
      try {
        origin = originOf(frame.url());
      } catch {
        continue;
      }
      const text = await frame
        .locator("body")
        .innerText({ timeout: this.timeout })
        .catch(() => "");
      const root = await frame.locator("html").elementHandle();
      if (root)
        this.documents.push({
          root,
          frame,
          url: frame.url(),
          text: text.slice(0, 6000),
        });
      texts.push(redactor.text(text).slice(0, 6000));
      const handles = await frame
        .locator(
          "input, button, a, [role=button], [role=menuitem], [role=option], [aria-expanded], select",
        )
        .elementHandles();
      for (const element of handles) {
        if (
          elements.length >= 100 ||
          !(await element.isVisible()) ||
          !(await element.isEnabled())
        ) {
          await element.dispose();
          continue;
        }
        const metadata = await element.evaluate((element) => {
          const node = element as HTMLElement;
          const input = element as HTMLInputElement;
          return {
            tag: node.tagName.toLowerCase(),
            type: node.getAttribute("type") ?? "",
            label:
              node.getAttribute("aria-label") ||
              input.labels?.[0]?.textContent ||
              node.getAttribute("placeholder") ||
              (node.tagName === "INPUT"
                ? node.getAttribute("name")
                : node.textContent) ||
              "",
            autocomplete: node.getAttribute("autocomplete") ?? "",
            expanded: node.getAttribute("aria-expanded"),
          };
        });
        const id = randomUUID();
        this.references.set(id, {
          element,
          frame,
          frameUrl: frame.url(),
          pageUrl: this.page.url(),
          origin,
        });
        elements.push({
          id,
          origin,
          tag: metadata.tag,
          type: redactor.text(metadata.type).slice(0, 80),
          autocomplete: redactor.text(metadata.autocomplete).slice(0, 160),
          label: redactor.text(metadata.label).slice(0, 160),
          ...(metadata.expanded === "true" || metadata.expanded === "false"
            ? { expanded: metadata.expanded === "true" }
            : {}),
        });
      }
    }
    return {
      origin: originOf(this.page.url()),
      text: texts.join("\n").slice(0, 12000),
      elements,
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
    ) {
      throw new AuthFailure(
        "stale_page",
        "The page changed; start a new authentication attempt",
      );
    }
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
}
