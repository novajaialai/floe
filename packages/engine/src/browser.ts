import { chromium, type BrowserContext, type Page } from "playwright-core";

/**
 * Injected into the page to index interactive elements. Each gets a
 * data-floe-id so the agent can act on stable short ids instead of selectors.
 */
const INDEX_SCRIPT = `(() => {
  const SELECTOR = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="combobox"], [contenteditable="true"], [onclick]';
  const els = Array.from(document.querySelectorAll(SELECTOR));
  const visible = els.filter((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  });
  const out = [];
  visible.forEach((el, i) => {
    el.setAttribute('data-floe-id', String(i));
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

  async click(elementId: number): Promise<void> {
    const loc = this.locator(elementId);
    await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    await loc.click({ timeout: 10_000 });
    await this.settle();
  }

  async type(elementId: number, text: string, submit = false): Promise<void> {
    const loc = this.locator(elementId);
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
