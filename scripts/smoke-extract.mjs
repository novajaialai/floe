#!/usr/bin/env node
// Model-free smoke test of the code-side pieces: sticky element ids, the
// structure detector, and pagination advance. Usage: node scripts/smoke-extract.mjs
import { FloeBrowser } from "../packages/engine/dist/index.js";

const browser = new FloeBrowser();
const b = await browser.launch({ profileDir: "/tmp/floe-smoke-profile", headless: true });
try {
  // --- sticky ids across snapshots + re-render ---
  await b.navigate("https://news.ycombinator.com");
  const s1 = await b.snapshot();
  await b.scroll("down");
  const s2 = await b.snapshot();
  const byLabel = new Map();
  const dupes = new Set();
  for (const e of s1.elements) {
    const k = e.label + "|" + e.href;
    if (byLabel.has(k)) dupes.add(k);
    byLabel.set(k, e.id);
  }
  let same = 0, changed = 0;
  for (const e of s2.elements) {
    const k = e.label + "|" + e.href;
    const prev = byLabel.get(k);
    if (prev === undefined || dupes.has(k)) continue;
    prev === e.id ? same++ : changed++;
  }
  console.log(`sticky ids: ${same} stable, ${changed} reassigned (want 0 reassigned)`);

  // --- extractor: HN front page ---
  const t = await b.extractTable();
  console.log(`HN: kind=${t.kind} source=${t.source} rows=${t.rows.length}`);
  console.log("row0 cells:", JSON.stringify(t.rows[0]?.cells));
  console.log("row0 text:", t.rows[0]?.text.slice(0, 160));
  console.log("row0 link:", t.rows[0]?.links[0]?.href);

  // --- pagination advance ---
  const adv = await b.advancePage("auto");
  console.log("advance:", JSON.stringify(adv));
  const t2 = await b.extractTable();
  console.log(`HN page2: rows=${t2.rows.length}, first title=${t2.rows[0]?.cells[1]}`);

  // --- extractor: a real <table> ---
  await b.navigate("https://en.wikipedia.org/wiki/List_of_countries_by_population_(United_Nations)");
  const t3 = await b.extractTable();
  console.log(`Wikipedia: kind=${t3.kind} source=${t3.source} rows=${t3.rows.length}`);
  console.log("columns:", JSON.stringify(t3.columns));
  console.log("row0:", JSON.stringify(t3.rows[0]?.cells));

  // --- generality: different repeated-structure shapes + auto pagination ---
  for (const url of ["https://quotes.toscrape.com/", "https://books.toscrape.com/", "https://lite.cnn.com/"]) {
    await b.navigate(url);
    const t = await b.extractTable();
    console.log(`${url} -> ${t.kind}/${t.source} rows=${t.rows.length} first=${JSON.stringify(t.rows[0]?.cells.slice(0, 3))}`);
    const adv = await b.advancePage("auto");
    console.log(`   advance: ${adv.detail}`);
  }
} finally {
  await browser.close();
}
