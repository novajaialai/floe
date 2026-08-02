#!/usr/bin/env node
/**
 * Drives the real Floe UI (`floe ui`) in a browser and captures screenshots:
 * types a task into the command bar, shoots the live run, waits for the verdict,
 * shoots the finished state, then the workflows tab.
 *
 *   node scripts/shoot-ui.mjs [--port 4321]
 * Output: docs/screenshots/*.png
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "screenshots");
const port = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "4321";
const TASK = "Go to https://example.com and report the exact text of the page heading. Do not save any files.";

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`shot: ${name}.png`);
};

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForSelector(".cmd");
await shot("floe-app-idle");

await page.fill(".cmd", TASK);
await page.click("button.go");

// Mid-run: wait until the agent has actually acted, then shoot.
await page.waitForSelector(".row.tool_call", { timeout: 120000 });
await page.waitForTimeout(1500);
await shot("floe-app-running");

// Pause/resume are part of the surface under test — exercise them on camera.
await page.click(".controls button:has-text('Pause')");
await page.waitForSelector(".pill.paused", { timeout: 120000 });
await shot("floe-app-paused");
await page.click(".controls button:has-text('Resume')");

await page.waitForSelector(".verdict", { timeout: 300000 });
await page.waitForTimeout(800);
await shot("floe-app-done");

await page.click(".tab:has-text('workflows')");
await page.waitForSelector(".card, .empty");
await page.waitForTimeout(400);
await shot("floe-app-workflows");

await page.click(".tab:has-text('settings')");
await page.waitForSelector(".form");
// The form fills from state in an effect — screenshot after it has applied.
await page.waitForFunction(() => (document.querySelector(".field input")?.value ?? "") !== "", null, { timeout: 5000 }).catch(() => {});
await shot("floe-app-settings");

await browser.close();
console.log(`\nscreenshots in ${OUT}`);
