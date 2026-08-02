#!/usr/bin/env node
/**
 * Screenshots the template surfaces: the app's Templates tab (grid + one open
 * template) against a running `floe ui`, and the generated static site
 * (landing + templates index) straight off site/dist.
 *
 *   floe ui --port 4322 --no-open &
 *   node scripts/shoot-gallery.mjs [--port 4322]
 * Output: docs/screenshots/*.png
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "screenshots");
const DIST = join(ROOT, "site", "dist");
const port = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "4321";

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
// jpeg at the repo's usual quality — a PNG of this UI is ~3x the bytes.
const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.jpg`), type: "jpeg", quality: 82 });
  console.log(`shot: ${name}.jpg`);
};

// ── the app ──────────────────────────────────────────────────────────────
await page.goto(`http://127.0.0.1:${port}/`);
await page.click(".tab:has-text('templates')");
await page.waitForSelector(".tcard");
const count = await page.locator(".tcard").count();
console.log(`gallery shows ${count} templates`);
await page.waitForTimeout(300);
await shot("floe-app-templates");

await page.click(".filter:has-text('research')");
await page.waitForTimeout(200);
await page.click(".tcard >> nth=0");
await page.waitForSelector(".prompt");
await page.waitForTimeout(300);
await shot("floe-app-template-detail");

// ── the generated site ───────────────────────────────────────────────────
if (existsSync(join(DIST, "index.html"))) {
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(pathToFileURL(join(DIST, "index.html")).href);
    await page.waitForTimeout(400);
    await shot(`floe-site-landing-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(pathToFileURL(join(DIST, "templates", "index.html")).href);
  await page.waitForSelector(".card");
  await page.waitForTimeout(300);
  await shot("floe-site-templates");
  await page.click(".filter:has-text('monitoring')");
  await page.waitForTimeout(300);
  await shot("floe-site-templates-filtered");
  await page.goto(pathToFileURL(join(DIST, "templates", "data-paginated-search-export.html")).href);
  await page.waitForTimeout(300);
  await shot("floe-site-template-page");
} else {
  console.log("site/dist not built — skipping site shots (npm run site)");
}

await browser.close();
console.log(`\nscreenshots in ${OUT}`);
