import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
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
  // Shadow-piercing walk (open roots, depth-capped): web-component sites
  // (Reddit, LWC apps, consent widgets) are invisible to a flat
  // querySelectorAll. Playwright's [data-floe-id] selectors pierce shadow
  // roots, so clicking works once the attribute is stamped here.
  const els = [];
  const dialogs = [];
  const frames = [];
  let nodeCount = 0;
  const walkAll = (root, depth) => {
    for (const el of root.querySelectorAll('*')) {
      nodeCount++;
      if (el.matches(SELECTOR)) els.push(el);
      if (el.matches('[role="dialog"], [aria-modal="true"], dialog[open]')) dialogs.push(el);
      if (el.tagName === 'IFRAME') frames.push(el);
      if (el.shadowRoot && depth < 5) walkAll(el.shadowRoot, depth + 1);
    }
  };
  walkAll(document, 0);
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
    // Stamp the label too: a virtualized list can recycle this node for
    // different content while it keeps its id — click() compares live vs
    // stamped label and refuses to click a lying id.
    el.setAttribute('data-floe-label', label.slice(0, 40));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const role = el.getAttribute('role');
    const inViewport = r.bottom > 0 && r.top < innerHeight;
    out.push({ id: i, tag, type, role, label, href: tag === 'a' ? (el.getAttribute('href') || '').slice(0, 120) : undefined, inViewport });
  });
  // An open dialog / near-full-viewport fixed overlay blocks everything else.
  let blocker = null;
  const vp = innerWidth * innerHeight;
  const describe = (el) => ((el.getAttribute('aria-label') || el.innerText || el.tagName) + '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  for (const d of dialogs) {
    const r = d.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(d).visibility !== 'hidden') { blocker = describe(d); break; }
  }
  if (!blocker && document.body) {
    for (const el of document.body.children) {
      const s = getComputedStyle(el);
      if (s.position !== 'fixed' && s.position !== 'sticky') continue;
      if (s.visibility === 'hidden' || s.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > vp * 0.6) { blocker = describe(el); break; }
    }
  }
  // Cross-origin consent managers (Sourcepoint etc.) render in an iframe this
  // script cannot enter — at least tell the agent the iframe is there.
  const iframes = [];
  for (const f of frames) {
    const r = f.getBoundingClientRect();
    if (r.width * r.height > vp * 0.2)
      iframes.push('page contains a large iframe (' + (f.getAttribute('src') || 'no src').slice(0, 100) + ', ~' + Math.round((r.width * r.height / vp) * 100) + '% of viewport) — likely a consent/embed dialog; Floe cannot index inside it');
  }
  return { els: out, blocker, iframes, nodeCount };
})()`;

/**
 * In-page helper shared by the scroll-related scripts: the page's main
 * scrollable. Window if the document itself scrolls, else the inner container
 * with the most scroll range (dashboards / chat panes scroll a div, not the
 * document — window-only scrolling reports maxY=0 and "no new content" there).
 */
const SCROLLER_FN = `const __floeScroller = () => {
  let best = null, bestD = 0;
  for (const el of document.querySelectorAll('*')) {
    const d = el.scrollHeight - el.clientHeight;
    if (d > bestD && el.clientHeight > 150) {
      const o = getComputedStyle(el).overflowY;
      if (o === 'auto' || o === 'scroll' || o === 'overlay') { best = el; bestD = d; }
    }
  }
  return best;
};`;

const SCROLL_INFO_SCRIPT = `(() => {
  ${SCROLLER_FN}
  const docMax = Math.round(Math.max(0, document.documentElement.scrollHeight - innerHeight));
  if (docMax > 100) return { y: Math.round(scrollY), maxY: docMax };
  const el = __floeScroller();
  if (!el) return { y: Math.round(scrollY), maxY: docMax };
  return { y: Math.round(el.scrollTop), maxY: Math.round(el.scrollHeight - el.clientHeight) };
})()`;

/** True when a "loaded" page is still visibly empty or spinning (SPA skeleton). */
const EMPTY_OR_BUSY_SCRIPT = `(() => {
  const text = document.body ? (document.body.innerText || '') : '';
  if (text.replace(/\\s+/g, '').length < 200) return true;
  const m = document.querySelector('[aria-busy="true"], .spinner, .loader, .loading, [class*="skeleton" i]');
  if (!m) return false;
  const r = m.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
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
  /** Label of an open dialog/overlay likely blocking the page, if detected. */
  blocker?: string | null;
  /** Warnings about large iframes (likely consent dialogs) that cannot be indexed. */
  iframes?: string[];
  /** Total DOM element count — a cost signal for expensive per-snapshot extras. */
  nodeCount?: number;
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

  /** Status + redirect info from the last explicit navigation, for honest snapshots. */
  lastNav?: { requested: string; finalUrl: string; status: number };

  async navigate(url: string): Promise<string> {
    if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
    const resp = await this.active.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await this.settle();
    this.lastNav = { requested: url, finalUrl: this.active.url(), status: resp?.status() ?? 0 };
    return this.active.url();
  }

  private async settle(): Promise<void> {
    await this.active.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
    await this.active.waitForTimeout(400);
    // SPA hydration: a "loaded" page that is still visibly empty or spinning
    // gets one bounded extra wait, so snapshots don't present skeletons as the
    // real page. Fast pages never hit this branch.
    const busy = await this.active.evaluate(EMPTY_OR_BUSY_SCRIPT).catch(() => false);
    if (busy) {
      await this.active.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      await this.active.waitForTimeout(300);
    }
  }

  async snapshot(maxChars = 12_000): Promise<PageSnapshot> {
    const idx = (await this.active.evaluate(INDEX_SCRIPT)) as {
      els: IndexedElement[];
      blocker: string | null;
      iframes: string[];
      nodeCount: number;
    };
    const [text, scroll] = await Promise.all([
      this.active.evaluate("document.body ? document.body.innerText : ''") as Promise<string>,
      this.active.evaluate(SCROLL_INFO_SCRIPT) as Promise<{ y: number; maxY: number }>,
    ]);
    return {
      url: this.active.url(),
      title: await this.active.title(),
      text: text.replace(/\n{3,}/g, "\n\n").slice(0, maxChars),
      elements: idx.els,
      scroll,
      blocker: idx.blocker,
      iframes: idx.iframes,
      nodeCount: idx.nodeCount,
    };
  }

  private async requireElement(elementId: number) {
    // Prefer the visible instance: cloned nodes (carousel loop slides,
    // desktop+mobile duplicate navs) can carry the same id on a hidden copy
    // that sits earlier in DOM order.
    const visible = this.active.locator(`[data-floe-id="${elementId}"]:visible`);
    if ((await visible.count().catch(() => 0)) > 0) return visible.first();
    const any = this.active.locator(`[data-floe-id="${elementId}"]`).first();
    if ((await any.count()) === 0) {
      throw new Error(
        `Element [${elementId}] is no longer on the page (navigated or re-rendered). Call read_page and use an id from the fresh snapshot.`,
      );
    }
    return any;
  }

  /**
   * A sticky id can survive on a recycled node whose content changed
   * (virtualized lists reuse DOM nodes for different rows) — compare the live
   * label against the one stamped at index time and refuse to act on a lie.
   */
  private async assertNotRecycled(elementId: number, loc: Locator): Promise<void> {
    const state = await loc
      .evaluate((el: any) => {
        const stamped = el.getAttribute("data-floe-label");
        const live = (
          (el.getAttribute("aria-label") ||
            el.getAttribute("placeholder") ||
            el.getAttribute("title") ||
            el.innerText ||
            el.value ||
            "") + ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 40);
        return { stamped, live };
      })
      .catch(() => null);
    if (!state || !state.stamped || !state.live) return;
    if (state.live !== state.stamped && !state.live.startsWith(state.stamped) && !state.stamped.startsWith(state.live))
      throw new Error(
        `Element [${elementId}] is stale: it now reads "${state.live}" but was "${state.stamped}" when last indexed (the page re-rendered or recycled the node). Call read_page and use an id from the fresh snapshot.`,
      );
  }

  /**
   * Run an action that MAY navigate, recording the resulting document status in
   * lastNav. Without this, only explicit navigate() calls got status warnings —
   * a click onto a 429/404 page looked like an ordinary blank page, and the
   * agent burned steps (and rate limit) retrying an error it could not see.
   */
  private async watchNav<T>(fn: () => Promise<T>): Promise<T> {
    const page = this.active;
    const before = page.url();
    let seen: { url: string; status: number } | undefined;
    const onResp = (r: any) => {
      try {
        const req = r.request();
        if (req.isNavigationRequest() && req.frame() === page.mainFrame()) seen = { url: r.url(), status: r.status() };
      } catch {
        /* a response from a closing page is not worth failing the action for */
      }
    };
    page.on("response", onResp);
    try {
      return await fn();
    } finally {
      page.off("response", onResp);
      if (seen && this.active === page && page.url() !== before)
        this.lastNav = { requested: seen.url, finalUrl: page.url(), status: seen.status };
    }
  }

  async click(elementId: number): Promise<void> {
    const loc = await this.requireElement(elementId);
    await this.assertNotRecycled(elementId, loc);
    await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    await this.watchNav(async () => {
      try {
        await loc.click({ timeout: 10_000 });
      } catch (err: any) {
        throw new Error(await this.explainBlockedClick(elementId, loc, err));
      }
      await this.settle();
    });
  }

  /** A click timeout is usually an overlay eating the pointer — say so, naming the culprit. */
  private async explainBlockedClick(elementId: number, loc: Locator, err: any): Promise<string> {
    const first = String(err?.message ?? err).split("\n")[0];
    const cover = await loc
      .evaluate((el: any) => {
        const r = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2));
        const y = Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2));
        const c = document.elementFromPoint(x, y) as any;
        if (!c || c === el || el.contains(c) || c.contains(el) || (c.shadowRoot && c.shadowRoot.contains(el))) return null;
        const label = ((c.getAttribute("aria-label") || c.innerText || "") + "").replace(/\s+/g, " ").trim().slice(0, 80);
        return { tag: c.tagName.toLowerCase(), label };
      })
      .catch(() => null);
    if (cover)
      return `Click on [${elementId}] is blocked by an overlay: <${cover.tag}> "${cover.label}" is covering it. Dismiss the overlay first (read_page and click its Accept/Close button, or press_key Escape), then retry.`;
    return `Click on [${elementId}] failed: ${first}. Re-read the page and use a fresh id or a different element.`;
  }

  async type(elementId: number, text: string, submit = false): Promise<void> {
    const loc = await this.requireElement(elementId);
    await this.assertNotRecycled(elementId, loc);
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
      `(() => { ${SCROLLER_FN}
  const dy = ${direction === "down" ? "" : "-"}Math.round(innerHeight * ${amount});
  const docMax = document.documentElement.scrollHeight - innerHeight;
  const el = docMax > 100 ? null : __floeScroller();
  if (el) el.scrollBy({ top: dy, behavior: 'instant' }); else scrollBy({ top: dy, behavior: 'instant' });
})()`,
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
      const h0 = await this.scrollToBottom();
      return (await this.scrollGrew(h0, 12))
        ? { ok: true, detail: "scrolled; new content loaded" }
        : { ok: false, detail: "scrolled to bottom but no new content loaded" };
    }
    const found = (await this.active.evaluate(FIND_NEXT_SCRIPT)) as { text: string; href: string } | null;
    if (!found) {
      // No control at all — probe once for an infinite feed before giving up,
      // so auto mode survives button-less feeds without the model guessing
      // to re-call with next=scroll.
      const h0 = await this.scrollToBottom();
      if (await this.scrollGrew(h0, 4))
        return {
          ok: true,
          detail: "no next/more control found, but the page grew after scrolling — this is an infinite feed; continuing in scroll mode",
        };
      return { ok: false, detail: "no next/more control found, and scrolling to the bottom loaded nothing new" };
    }
    const loc = this.active.locator("[data-floe-next]").first();
    await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    await this.watchNav(async () => {
      await loc.click({ timeout: 15_000 });
      await this.settle();
    });
    const after = this.active.url();
    const status = this.lastNav && this.lastNav.finalUrl === after ? this.lastNav.status : 0;
    // A "next page" that served 4xx/5xx is a failed advance, not a new page:
    // reporting ok here made paginate_extract keep going against an error page.
    if (status >= 400)
      return {
        ok: false,
        detail: `clicked "${found.text}" but the next page returned HTTP ${status} (${after}) — the site refused it (rate limit / blocked). Stop paginating here and report how far you got; do NOT transcribe the missing rows from memory.`,
      };
    return { ok: true, detail: `clicked "${found.text}"${after !== before ? ` -> ${after}` : " (same URL; content updated in place)"}` };
  }

  /** Scroll the page's main scrollable to its bottom; returns its content height. */
  private async scrollToBottom(): Promise<number> {
    return (await this.active.evaluate(
      `(() => { ${SCROLLER_FN}
  const docMax = document.documentElement.scrollHeight - innerHeight;
  const el = docMax > 100 ? null : __floeScroller();
  if (el) { el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }); return el.scrollHeight; }
  scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
  return document.body.scrollHeight;
})()`,
    )) as number;
  }

  /** Re-scroll to the bottom up to `tries` times, ~500ms apart, until the content grows. */
  private async scrollGrew(h0: number, tries: number): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      await this.active.waitForTimeout(500);
      if ((await this.scrollToBottom()) > h0) return true;
    }
    return false;
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
