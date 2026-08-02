#!/usr/bin/env node
/** Renders the Floe app icon (1024²) with the same mark the UI rail uses. */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "app", "src-tauri", "icons");
mkdirSync(OUT, { recursive: true });

const html = `<html><body style="margin:0">
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0d1a22"/><stop offset="100%" stop-color="#04080b"/>
    </linearGradient>
    <linearGradient id="ice" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0%" stop-color="#8fe8f7"/><stop offset="100%" stop-color="#2f9fb4"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="228" fill="url(#bg)"/>
  <g transform="translate(512,512)">
    <path d="M0 -330 L286 -165 L286 165 L0 330 L-286 165 L-286 -165 Z"
          fill="none" stroke="url(#ice)" stroke-width="46" stroke-linejoin="round"/>
    <path d="M0 -155 L134 -78 L134 78 L0 155 L-134 78 L-134 -78 Z" fill="url(#ice)" opacity="0.85"/>
  </g>
</svg></body></html>`;

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(html);
await page.screenshot({ path: join(OUT, "icon.png"), omitBackground: true });
await browser.close();
console.log(`icon → ${join(OUT, "icon.png")}`);
