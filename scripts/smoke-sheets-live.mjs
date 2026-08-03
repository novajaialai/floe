#!/usr/bin/env node
// Live sanity check of sheets_write's honest-failure lane: a temp profile
// with no Google accounts must produce the "not signed in" wall error via the
// real browser path (navigate -> sheets.new -> accounts.google.com redirect ->
// state probe -> typed error). Also exercises the not-a-sheet diagnostic.
import { FloeBrowser } from "../packages/engine/dist/index.js";
import { existsSync } from "node:fs";
import { rmSync } from "node:fs";

const profile = "/tmp/floe-sheets-smoke-profile";
if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });

const browser = new FloeBrowser();
await browser.launch({ profileDir: profile, headless: true });
let failures = 0;
try {
  // 1. Fresh profile, "new" sheet -> must hit the Google sign-in wall.
  try {
    await browser.main.sheetsWrite({ url: "new", rows: [["a", "b"], ["c", "d"]] });
    console.log("FAIL: expected a sign-in wall error, got success");
    failures++;
  } catch (e) {
    const msg = String(e?.message ?? e);
    const ok = msg.includes("not signed in to Google");
    console.log(`${ok ? "ok  " : "FAIL"} fresh profile -> login wall: ${msg.slice(0, 100)}`);
    if (!ok) failures++;
  }

  // 2. Non-sheet URL -> must say it's not a Google Sheet.
  try {
    await browser.main.sheetsWrite({ url: "https://example.com", rows: [["a"]] });
    console.log("FAIL: expected a not-a-sheet error, got success");
    failures++;
  } catch (e) {
    const msg = String(e?.message ?? e);
    const ok = msg.includes("not a Google Sheets document");
    console.log(`${ok ? "ok  " : "FAIL"} non-sheet URL -> diagnostic: ${msg.slice(0, 100)}`);
    if (!ok) failures++;
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILURES` : "all sheets live-failure-lane checks passed");
process.exit(failures ? 1 : 0);
