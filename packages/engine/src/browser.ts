import { chromium, type BrowserContext, type Page } from "playwright-core";
import { EXTRACT_SCRIPT, FIND_NEXT_SCRIPT, type ExtractedTable } from "./extract.js";

/**
 * Injected into the page to index interactive elements. Each gets a
 * data-floe-id so the agent can act on stable short ids instead of selectors.
 *
 * Ids are *sticky*: an element keeps the id it was first given for as long as
 * it stays in the DOM, so an id the model saw in an earlier snapshot still
 * points at the same element after a re-render. The counter lives on `window`,
 * so it resets naturally on a real navigation (fresh document) and only ever
 * hands out fresh ids to newly-seen elements.
 */
const INDEX_SCRIPT = `(() => {
  const SELECTOR = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="combobox"], [contenteditable="true"], [onclick]';
  if (typeof window.__floeNextId !== 'number') window.__floeNextId = 0;
  const els = Array.from(document.querySelectorAll(SELECTOR));
  const visible = els.filter((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  });
  const out = [];
  const seen = new Set();
  visible.forEach((el) => {
    let id = el.getAttribute('data-floe-id');
    if (id === null || seen.has(id)) {
      id = String(window.__floeNextId++);
      el.setAttribute('data-floe-id', id);
    }
    seen.add(id);
    const i = Number(id);
    const r = el.getBoundingClientRect();
    const label = (
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      (el.innerText || el.value || '').trim()
    ).replace(/\\s+/g, ' ').slice(0, 80);
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const role = el.getAttribute('role');
    const inViewport = r.bottom > 0 && r.top < innerHeight;
    out.push({ id: i, tag, type, role, label, href: tag === 'a' ? (el.getAttribute('href') || '').slice(0, 120) : undefined, inViewport });
  });
  return out;
})()`;

export interface IndexedElement {
  id: number;
  tag: string;
  type?: string | null;
  role?: string | null;
  label: string;
  href?: string;
  inViewport: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: IndexedElement[];
  scroll: { y: number; maxY: number };
}

export interface BrowserOptions {
  profileDir: string;
  headless?: boolean;
  executablePath?: string;
  channel?: string;
}

export class FloeBrowser {
  private context!: BrowserContext;
  private activePage!: Page;

  async launch(opts: BrowserOptions): Promise<void> {
    this.context = await chromium.launchPersistentContext(opts.profileDir, {
      headless: opts.headless ?? false,
      channel: opts.executablePath ? undefined : (opts.channel ?? "chrome"),
      executablePath: opts.executablePath,
      viewport: null,
      args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
    });
    this.activePage = this.context.pages()[0] ?? (await this.context.newPage());
  }

  get page(): Page {
    return this.activePage;
  }

  async navigate(url: string): Promise<string> {
    if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
    await this.activePage.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await this.settle();
    return this.activePage.url();
  }

  private async settle(): Promise<void> {
    await this.activePage.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
    await this.activePage.waitForTimeout(400);
  }

  async snapshot(maxChars = 12_000): Promise<PageSnapshot> {
    const elements = (await this.activePage.evaluate(INDEX_SCRIPT)) as IndexedElement[];
    const [text, scroll] = await Promise.all([
      this.activePage.evaluate("document.body ? document.body.innerText : ''") as Promise<string>,
      this.activePage.evaluate(
        "({ y: Math.round(scrollY), maxY: Math.round(Math.max(0, document.documentElement.scrollHeight - innerHeight)) })",
      ) as Promise<{ y: number; maxY: number }>,
    ]);
    return {
      url: this.activePage.url(),
      title: await this.activePage.title(),
      text: text.replace(/\n{3,}/g, "\n\n").slice(0, maxChars),
      elements,
      scroll,
    };
  }

  private locator(elementId: number) {
    return this.activePage.locator(`[data-floe-id="${elementId}"]`).first();
  }

  private async requireElement(elementId: number) {
    const loc = this.locator(elementId);
    if ((await loc.count()) === 0) {
      throw new Error(
        `Element [${elementId}] is no longer on the page (navigated or re-rendered). Call read_page and use an id from the fresh snapshot.`,
      );
    }
    return loc;
  }

  async click(elementId: number): Promise<void> {
    const loc = await this.requireElement(elementId);
    await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    await loc.click({ timeout: 10_000 });
    await this.settle();
  }

  async type(elementId: number, text: string, submit = false): Promise<void> {
    const loc = await this.requireElement(elementId);
    await loc.click({ timeout: 10_000 });
    await loc.fill("").catch(() => {});
    await loc.pressSequentially(text, { delay: 20 });
    if (submit) {
      await this.activePage.keyboard.press("Enter");
      await this.settle();
    }
  }

  async press(key: string): Promise<void> {
    await this.activePage.keyboard.press(key);
    await this.settle();
  }

  async scroll(direction: "down" | "up", amount = 0.8): Promise<void> {
    await this.activePage.evaluate(
      `scrollBy({ top: ${direction === "down" ? "" : "-"}Math.round(innerHeight * ${amount}), behavior: 'instant' })`,
    );
    await this.activePage.waitForTimeout(300);
  }

  /** Code-side structured extraction of the page's dominant repeated structure. */
  async extractTable(): Promise<ExtractedTable> {
    return (await this.activePage.evaluate(EXTRACT_SCRIPT)) as ExtractedTable;
  }

  /**
   * Advance one "page" of a list. auto = click the detected next/more control;
   * scroll = infinite-feed scroll to the bottom and wait for growth.
   */
  async advancePage(mode: "auto" | "scroll" = "auto"): Promise<{ ok: boolean; detail: string }> {
    const before = this.activePage.url();
    if (mode === "scroll") {
      const height = () => this.activePage.evaluate("document.body.scrollHeight") as Promise<number>;
      const h0 = await height();
      await this.activePage.evaluate("scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })");
      for (let i = 0; i < 12; i++) {
        await this.activePage.waitForTimeout(500);
        if ((await height()) > h0) return { ok: true, detail: "scrolled; new content loaded" };
      }
      return { ok: false, detail: "scrolled to bottom but no new content loaded" };
    }
    const found = (await this.activePage.evaluate(FIND_NEXT_SCRIPT)) as { text: string; href: string } | null;
    if (!found) return { ok: false, detail: "no next/more control found on the page" };
    const loc = this.activePage.locator("[data-floe-next]").first();
    await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    await loc.click({ timeout: 15_000 });
    await this.settle();
    const after = this.activePage.url();
    return { ok: true, detail: `clicked "${found.text}"${after !== before ? ` -> ${after}` : " (same URL; content updated in place)"}` };
  }

  async screenshot(): Promise<Buffer> {
    return this.activePage.screenshot({ type: "png" });
  }

  async listTabs(): Promise<{ index: number; url: string; title: string; active: boolean }[]> {
    const pages = this.context.pages();
    return Promise.all(
      pages.map(async (p, index) => ({ index, url: p.url(), title: await p.title().catch(() => ""), active: p === this.activePage })),
    );
  }

  async newTab(url?: string): Promise<number> {
    this.activePage = await this.context.newPage();
    if (url) await this.navigate(url);
    return this.context.pages().indexOf(this.activePage);
  }

  async switchTab(index: number): Promise<void> {
    const pages = this.context.pages();
    if (index < 0 || index >= pages.length) throw new Error(`No tab ${index}; ${pages.length} tabs open`);
    this.activePage = pages[index];
    await this.activePage.bringToFront();
  }

  async close(): Promise<void> {
    await this.context?.close();
  }
}
