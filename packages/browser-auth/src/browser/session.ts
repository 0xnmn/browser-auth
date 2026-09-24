import { randomUUID } from "node:crypto";
import type { BrowserContext, Dialog, Frame, Page } from "playwright-core";
import { AuthFailure } from "../errors.js";
import { originOf } from "../security/origins.js";

export interface PageMetadata {
  id: string;
  origin: string;
  active: boolean;
  openerId?: string;
  owned: boolean;
}

export interface FrameMetadata {
  id: string;
  origin: string;
  main: boolean;
  parentId?: string;
}

/** Owns only the bounded page capability for one authentication flow. */
export class BrowserSession {
  private readonly pages = new Map<
    Page,
    { id: string; owned: boolean; opener?: Page }
  >();
  nativeDialogSeen = false;
  private explicit: Page | undefined;

  constructor(
    private readonly context: BrowserContext,
    readonly initial: Page,
  ) {
    this.add(initial, false);
  }

  private add(page: Page, owned: boolean, opener?: Page): void {
    if (this.pages.has(page)) return;
    this.pages.set(page, {
      id: randomUUID(),
      owned,
      ...(opener ? { opener } : {}),
    });
    page.on("popup", this.onPopup);
    page.on("dialog", this.onDialog);
  }

  private readonly onPopup = (page: Page) => {
    this.add(page, false);
    const opener = page.opener().catch(() => null);
    void opener.then((value) => {
      if (value) this.pages.get(page)!.opener = value;
    });
  };

  private readonly onDialog = (dialog: Dialog) => {
    // Native modal authentication is not supported. Release the blocked browser
    // action without accepting the dialog or sending private values, then stop.
    this.nativeDialogSeen = true;
    void dialog.dismiss().catch(() => {});
  };

  current(): Page {
    if (this.initial.isClosed())
      throw new AuthFailure(
        "target_closed",
        "The selected browser tab was closed",
      );
    if (this.explicit && !this.explicit.isClosed()) return this.explicit;
    this.explicit = undefined;
    return (
      [...this.pages.keys()].reverse().find((page) => !page.isClosed()) ??
      this.initial
    );
  }

  list(): PageMetadata[] {
    const active = this.current();
    return [...this.pages.entries()]
      .filter(([page]) => !page.isClosed())
      .map(([page, entry]) => ({
        id: entry.id,
        origin: safeOrigin(page.url()),
        active: page === active,
        ...(entry.opener && this.pages.get(entry.opener)?.id
          ? { openerId: this.pages.get(entry.opener)!.id }
          : {}),
        owned: entry.owned,
      }));
  }

  switch(id: string): void {
    const page = this.find(id);
    if (page.isClosed()) throw invalidPage();
    this.explicit = page;
  }

  async create(): Promise<string> {
    const page = await this.context.newPage();
    this.add(page, true);
    this.explicit = page;
    return this.pages.get(page)!.id;
  }

  async close(id: string): Promise<void> {
    const page = this.find(id);
    const entry = this.pages.get(page)!;
    if (!entry.owned)
      throw new AuthFailure(
        "page_not_owned",
        "Only tabs created by this authentication flow can be closed",
      );
    await page.close({ runBeforeUnload: false });
    if (this.explicit === page) this.explicit = undefined;
  }

  frames(): FrameMetadata[] {
    const page = this.current();
    const frames = page.frames().slice(0, 10);
    const ids = new Map<Frame, string>(
      frames.map((frame) => [frame, randomUUID()]),
    );
    return frames.map((frame) => ({
      id: ids.get(frame)!,
      origin: safeOrigin(frame.url()),
      main: frame === page.mainFrame(),
      ...(frame.parentFrame() && ids.get(frame.parentFrame()!)
        ? { parentId: ids.get(frame.parentFrame()!)! }
        : {}),
    }));
  }

  clear(): void {
    for (const page of this.pages.keys()) {
      page.off("popup", this.onPopup);
      page.off("dialog", this.onDialog);
    }
  }

  private find(id: string): Page {
    for (const [page, entry] of this.pages) if (entry.id === id) return page;
    throw invalidPage();
  }
}

function safeOrigin(url: string): string {
  try {
    return originOf(url);
  } catch {
    return "opaque";
  }
}

function invalidPage(): AuthFailure {
  return new AuthFailure(
    "page_not_found",
    "The selected authentication tab is unavailable",
  );
}
