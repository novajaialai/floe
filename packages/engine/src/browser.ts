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
 * hands out fresh ids to newly-seen elements. It is per-document, so two
 * sessions indexing different pages never collide.
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

/**
 * One agent's browser handle: its own tab(s), isolated from every other
 * agent's. Every page action lives here, so N agents can act concurrently
 * without fighting over a single shared "active page" pointer.
 *
 * A session may own several tabs of its own, but never another session's —
 * cross-session bleed is impossible by construction.
 */
export class BrowserSession {
  private pages: Page[] = [];
  private active: Page;

  constructor(
    readonly name: string,
    private context: BrowserContext,
    firstPage: Page,
  ) {
    this.pages.push(firstPage);
    this.active = firstPage;
  }

  get page(): Page {
    return this.active;
  }

  async navigate(url: string): Promise<string> {
    if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
    await this.active.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await this.settle();
    return this.active.url();
  }

  private async settle(): Promise<void> {
    await this.active.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
    await this.active.waitForTimeout(400);
  }

  async snapshot(maxChars = 12_000): Promise<PageSnapshot> {
    const elements = (await this.active.evaluate(INDEX_SCRIPT)) as IndexedElement[];
    const [text, scroll] = await Promise.all([
      this.active.evaluate("document.body ? document.body.innerText : ''") as Promise<string>,
      this.active.evaluate(
        "({ y: Math.round(scrollY), maxY: Math.round(Math.max(0, document.documentElement.scrollHeight - innerHeight)) })",
      ) as Promise<{ y: number; maxY: number }>,
    ]);
    return {
      url: this.active.url(),
      title: await this.active.title(),
      text: text.replace(/\n{3,}/g, "\n\n").slice(0, maxChars),
      elements,
      scroll,
    };
  }

  private locator(elementId: number) {
    return this.active.locator(`[data-floe-id="${elementId}"]`).first();
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
      await this.active.keyboard.press("Enter");
      await this.settle();
    }
  }

  async press(key: string): Promise<void> {
    await this.active.keyboard.press(key);
    await this.settle();
  }

  async scroll(direction: "down" | "up", amount = 0.8): Promise<void> {
    await this.active.evaluate(
      `scrollBy({ top: ${direction === "down" ? "" : "-"}Math.round(innerHeight * ${amount}), behavior: 'instant' })`,
    );
    await this.active.waitForTimeout(300);
  }

  /** Code-side structured extraction of the page's dominant repeated structure. */
  async extractTable(): Promise<ExtractedTable> {
    return (await this.active.evaluate(EXTRACT_SCRIPT)) as ExtractedTable;
  }

  /**
   * Advance one "page" of a list. auto = click the detected next/more control;
   * scroll = infinite-feed scroll to the bottom and wait for growth.
   */
  async advancePage(mode: "auto" | "scroll" = "auto"): Promise<{ ok: boolean; detail: string }> {
    const before = this.active.url();
    if (mode === "scroll") {
      const height = () => this.active.evaluate("document.body.scrollHeight") as Promise<number>;
      const h0 = await height();
      await this.active.evaluate("scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })");
      for (let i = 0; i < 12; i++) {
        await this.active.waitForTimeout(500);
        if ((await height()) > h0) return { ok: true, detail: "scrolled; new content loaded" };
      }
      return { ok: false, detail: "scrolled to bottom but no new content loaded" };
    }
    const found = (await this.active.evaluate(FIND_NEXT_SCRIPT)) as { text: string; href: string } | null;
    if (!found) return { ok: false, detail: "no next/more control found on the page" };
    const loc = this.active.locator("[data-floe-next]").first();
    await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    await loc.click({ timeout: 15_000 });
    await this.settle();
    const after = this.active.url();
    return { ok: true, detail: `clicked "${found.text}"${after !== before ? ` -> ${after}` : " (same URL; content updated in place)"}` };
  }

  async screenshot(): Promise<Buffer> {
    return this.active.screenshot({ type: "png" });
  }

  /** Tabs owned by THIS session only. */
  async listTabs(): Promise<{ index: number; url: string; title: string; active: boolean }[]> {
    return Promise.all(
      this.pages.map(async (p, index) => ({
        index,
        url: p.url(),
        title: await p.title().catch(() => ""),
        active: p === this.active,
      })),
    );
  }

  async newTab(url?: string): Promise<number> {
    this.active = await this.context.newPage();
    this.pages.push(this.active);
    if (url) await this.navigate(url);
    return this.pages.indexOf(this.active);
  }

  async switchTab(index: number): Promise<void> {
    if (index < 0 || index >= this.pages.length)
      throw new Error(`No tab ${index} in this session; ${this.pages.length} tabs open`);
    this.active = this.pages[index];
    await this.active.bringToFront();
  }

  async close(): Promise<void> {
    for (const p of this.pages) await p.close().catch(() => {});
    this.pages = [];
  }
}

/**
 * The Chromium context plus a pool of per-agent sessions: one browser (one
 * persistent profile, so the user's logins are shared) driving many
 * independently-owned tabs — the substrate for parallel subagents.
 */
export class FloeBrowser {
  private context!: BrowserContext;
  private sessions = new Map<string, BrowserSession>();
  private mainSession!: BrowserSession;

  async launch(opts: BrowserOptions): Promise<BrowserSession> {
    this.context = await chromium.launchPersistentContext(opts.profileDir, {
      headless: opts.headless ?? false,
      channel: opts.executablePath ? undefined : (opts.channel ?? "chrome"),
      executablePath: opts.executablePath,
      viewport: null,
      args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
    });
    const first = this.context.pages()[0] ?? (await this.context.newPage());
    this.mainSession = new BrowserSession("main", this.context, first);
    this.sessions.set("main", this.mainSession);
    return this.mainSession;
  }

  /** The session the single-agent CLI (and the orchestrator) drives. */
  get main(): BrowserSession {
    return this.mainSession;
  }

  async createSession(name: string): Promise<BrowserSession> {
    if (this.sessions.has(name)) throw new Error(`Session "${name}" already exists`);
    const page = await this.context.newPage();
    const s = new BrowserSession(name, this.context, page);
    this.sessions.set(name, s);
    return s;
  }

  getSession(name: string): BrowserSession | undefined {
    return this.sessions.get(name);
  }

  listSessions(): string[] {
    return [...this.sessions.keys()];
  }

  async closeSession(name: string): Promise<void> {
    const s = this.sessions.get(name);
    if (!s || s === this.mainSession) return;
    await s.close();
    this.sessions.delete(name);
  }

  async close(): Promise<void> {
    await this.context?.close();
  }
}
