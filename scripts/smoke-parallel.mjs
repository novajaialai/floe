#!/usr/bin/env node
// Model-free smoke test of per-agent page ownership: three BrowserSessions
// snapshot + extract on three different sites *at the same time*, then prove
// (a) each session still sees its own page, (b) element ids are stable across
// the concurrent round, (c) no ids or rows bleed between sessions.
// Usage: node scripts/smoke-parallel.mjs
import { FloeBrowser } from "../packages/engine/dist/index.js";

const SITES = [
  { name: "hn", url: "https://news.ycombinator.com", host: "news.ycombinator.com" },
  { name: "quotes", url: "https://quotes.toscrape.com/", host: "quotes.toscrape.com" },
  { name: "books", url: "https://books.toscrape.com/", host: "books.toscrape.com" },
];

const browser = new FloeBrowser();
await browser.launch({ profileDir: "/tmp/floe-smoke-profile", headless: true });
let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  ✖ ${msg}`);
};

try {
  const sessions = [];
  for (const s of SITES) sessions.push(await browser.createSession(s.name));
  console.log(`sessions: ${browser.listSessions().join(", ")}`);

  // --- everyone navigates + works concurrently ---
  const t0 = Date.now();
  const spans = [];
  const round = (session, site, pass) =>
    (async () => {
      const start = Date.now();
      if (pass === 1) await session.navigate(site.url);
      const snap = await session.snapshot();
      const table = await session.extractTable();
      const end = Date.now();
      spans.push({ name: site.name, pass, start: start - t0, end: end - t0 });
      return { site, snap, table };
    })();

  const pass1 = await Promise.all(sessions.map((s, i) => round(s, SITES[i], 1)));
  const pass2 = await Promise.all(sessions.map((s, i) => round(s, SITES[i], 2)));

  // Concurrency evidence: pass-1 spans must overlap in wall-clock time.
  const p1 = spans.filter((s) => s.pass === 1);
  const overlap = Math.min(...p1.map((s) => s.end)) - Math.max(...p1.map((s) => s.start));
  console.log(`\nconcurrent work spans (ms since start): ${p1.map((s) => `${s.name} ${s.start}-${s.end}`).join(", ")}`);
  console.log(`overlap of all three: ${overlap}ms (want > 0)`);
  if (overlap <= 0) fail("sessions did not actually overlap in time");

  // --- isolation + stability checks ---
  for (let i = 0; i < SITES.length; i++) {
    const site = SITES[i];
    const a = pass1[i];
    const b = pass2[i];
    console.log(`\n[${site.name}] url=${a.snap.url}`);
    console.log(`  elements=${a.snap.elements.length} rows=${a.table.rows.length} (${a.table.kind}/${a.table.source})`);
    if (!a.snap.url.includes(site.host)) fail(`${site.name} session is on the wrong page: ${a.snap.url}`);
    if (!b.snap.url.includes(site.host)) fail(`${site.name} session drifted on pass 2: ${b.snap.url}`);
    if (a.table.rows.length === 0) fail(`${site.name} extracted 0 rows`);

    // ids stable across the concurrent second pass. Compare only on
    // unambiguous label|href keys (a page can hold several identical links),
    // and also require the whole id set to be unchanged.
    const seen = new Map();
    const ambiguous = new Set();
    for (const e of a.snap.elements) {
      const k = `${e.label}|${e.href}`;
      if (seen.has(k)) ambiguous.add(k);
      seen.set(k, e.id);
    }
    let changed = 0;
    for (const e of b.snap.elements) {
      const k = `${e.label}|${e.href}`;
      const prev = seen.get(k);
      if (prev === undefined || ambiguous.has(k)) continue;
      if (prev !== e.id) changed++;
    }
    const idsA = [...new Set(a.snap.elements.map((e) => e.id))].sort((x, y) => x - y).join(",");
    const idsB = [...new Set(b.snap.elements.map((e) => e.id))].sort((x, y) => x - y).join(",");
    console.log(`  ids reassigned across concurrent pass: ${changed} (want 0); id set identical: ${idsA === idsB}`);
    if (changed > 0) fail(`${site.name} reassigned ${changed} element ids`);
    if (idsA !== idsB) fail(`${site.name} id set changed between concurrent passes`);

    // no content bleed: this session's rows must not contain another site's text
    const mine = a.table.rows.map((r) => r.text).join(" ").toLowerCase();
    for (const other of SITES) {
      if (other.name === site.name) continue;
      const otherRows = pass1[SITES.indexOf(other)].table.rows.slice(0, 3).map((r) => r.text.slice(0, 60).toLowerCase());
      for (const row of otherRows) if (row.length > 30 && mine.includes(row)) fail(`${site.name} contains ${other.name} content`);
    }
  }

  // --- tabs are per-session, not global ---
  const extra = await sessions[0].newTab("https://example.com");
  const tabs0 = await sessions[0].listTabs();
  const tabs1 = await sessions[1].listTabs();
  console.log(`\nsession hn tabs=${tabs0.length} (opened index ${extra}), session quotes tabs=${tabs1.length} (want 1)`);
  if (tabs1.length !== 1) fail("a tab opened by one session was visible to another");
  await sessions[0].switchTab(0);
  if (!(await sessions[0].snapshot()).url.includes(SITES[0].host)) fail("switchTab did not return to the session's first tab");

  await browser.closeSession("books");
  console.log(`sessions after close: ${browser.listSessions().join(", ")}`);
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nPARALLEL SMOKE: PASS" : `\nPARALLEL SMOKE: FAIL (${failures} problems)`);
process.exit(failures === 0 ? 0 : 1);
