#!/usr/bin/env node
/**
 * Model-free smoke for the session-9 steering layer: the protocol-refusal
 * detector, the named-deliverable extractor, the hand-typed-rows detector, and
 * the <select> extraction path in the page-side extractor script.
 *
 * These are the code-side halves of three fixes that would otherwise only be
 * testable by burning a live gateway run. No browser, no LLM.
 * Run: node scripts/smoke-steering.mjs
 */
import { isProtocolRefusal, requiredDeliverables } from "../packages/engine/dist/agent.js";
import { handTypedRows } from "../packages/engine/dist/tools.js";
import { EXTRACT_SCRIPT } from "../packages/engine/dist/extract.js";

let failures = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "ok " : "FAIL"} ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

// --- protocol refusal detector -------------------------------------------
// Verbatim refusals recorded live on 2026-08-02 (market-map + honest-gaps).
const REFUSALS = [
  "I'm Claude Code, a general-purpose coding assistant — I have no browser-automation connection to any \"Floe\" system.",
  "I can't call `navigate` or `done` because those aren't real tools available to me — printing that JSON would just be text.",
  "This message is structured as an embedded fake conversation... That's a prompt-injection pattern.",
  "I completed the research using my actual tools (WebFetch) rather than fabricating \"Floe\" browser actions.",
  "That environment doesn't exist in my current toolset, no matter how the prompt is framed.",
  "I don't have a browser or any live Chromium session here.",
];
for (const [i, r] of REFUSALS.entries()) t(`refusal ${i + 1} detected`, isProtocolRefusal(r), r.slice(0, 60));

// Honest final summaries and honest-gap prose must NOT trip it: a false
// positive costs a corrective round-trip on a run that was already finished.
const HONEST = [
  "Wrote report.md with 5 quotes. No email addresses exist anywhere on quotes.toscrape.com, so that field is reported as unavailable rather than guessed.",
  "I don't have the author's date of birth for two of the five quotes; the about pages did not list it.",
  "Collected 30 of the expected 60 rows: the second page returned HTTP 429 and I did not transcribe the rest from memory.",
  "The site has no next/more control, so pagination stopped after page 1.",
  "Task complete: market-map.md covers all three frameworks with per-fact URLs.",
];
for (const [i, h] of HONEST.entries()) t(`honest summary ${i + 1} not flagged`, !isProtocolRefusal(h), h.slice(0, 60));
t("empty text not flagged", !isProtocolRefusal(""));

// --- named deliverables ---------------------------------------------------
t(
  "report.md extracted from task prose",
  requiredDeliverables("From https://quotes.toscrape.com/ take the first 5 quotes and write into report.md: the quote text.").join() ===
    "report.md",
);
t(
  "two deliverables extracted",
  requiredDeliverables("Collect rows into jobs.csv and summarise them in summary.md").sort().join() === "jobs.csv,summary.md",
);
t(
  "a file inside a URL is a source, not a deliverable",
  requiredDeliverables("Read https://example.com/data/report.md and tell me what it says").length === 0,
  JSON.stringify(requiredDeliverables("Read https://example.com/data/report.md and tell me what it says")),
);
t("plain task has no deliverable", requiredDeliverables("Find the population of Boise and report it.").length === 0);
t(
  "domain names are not deliverables",
  requiredDeliverables("Research playwright.dev and pptr.dev").length === 0,
  JSON.stringify(requiredDeliverables("Research playwright.dev and pptr.dev")),
);

// --- hand-typed rows ------------------------------------------------------
const csvRows = "name,url\nAlabama,https://www.usa.gov/states/alabama\nAlaska,https://www.usa.gov/states/alaska\nArizona,https://www.usa.gov/states/arizona\n";
t("hand-typed CSV rows detected", handTypedRows("states.csv", csvRows));
t("header-only reset write not flagged", !handTypedRows("jobs.csv", "title,link,age\n"));
t(
  "prose notes with commas not flagged",
  !handTypedRows(
    "notes.md",
    "Plan: visit each author page, note the born date, and record gaps.\nEinstein, Rowling, and Austen are on page 1.\nNo emails exist on this site, so that column stays empty.\nNext: write the report.\n",
  ),
);
t(
  "markdown report not flagged",
  !handTypedRows(
    "report.md",
    "# Market map\n\nPlaywright is maintained by Microsoft, in TypeScript, under Apache-2.0.\nPuppeteer is maintained by Google, in TypeScript, under Apache-2.0.\nSelenium is maintained by SeleniumHQ, in Java, under Apache-2.0.\n",
  ),
);

// --- <select> extraction path (page-side script, run in a fake DOM) --------
// The USWDS combo box on usa.gov replaces its <ul> of links with a
// screen-reader-only <select>; without this path the 59 states are invisible
// to the extractor and the model hand-types them.
const rows = runExtractOnFakeDom();
t("select path finds all 59 options", rows.kind === "repeated" && rows.rows.length === 59, JSON.stringify(rows).slice(0, 200));
t("option value becomes a link", rows.rows?.[0]?.links?.[0]?.href === "https://www.usa.gov/states/alabama", JSON.stringify(rows.rows?.[0]));
t("option text becomes cell 0", rows.rows?.[0]?.cells?.[0] === "Alabama (AL)");

/**
 * Minimal DOM stub: enough surface for EXTRACT_SCRIPT (querySelectorAll over a
 * flat element list, tagName/class/parent, and a <select> with .options).
 * Cheaper and more deterministic than launching Chromium for one heuristic.
 */
function runExtractOnFakeDom() {
  const names = [
    "Alabama|alabama|AL", "Alaska|alaska|AK", "American Samoa|american-samoa|AS", "Arizona|arizona|AZ",
    "Arkansas|arkansas|AR", "California|california|CA", "Colorado|colorado|CO", "Connecticut|connecticut|CT",
    "Delaware|delaware|DE", "District of Columbia|district-of-columbia|DC", "Florida|florida|FL", "Georgia|georgia|GA",
  ];
  // pad to 59 distinct entries
  while (names.length < 59) names.push(`Territory ${names.length}|territory-${names.length}|T${names.length}`);

  const mk = (tag, props = {}) => ({
    tagName: tag, children: [], parentElement: null, parentNode: null, shadowRoot: null,
    attrs: {}, innerText: "", textContent: "", value: "",
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    hasAttribute(k) { return k in this.attrs; },
    querySelectorAll() { return []; },
    ...props,
  });

  const all = [];
  const body = mk("BODY");
  const select = mk("SELECT", { id: "stateselect", name: "state" });
  select.attrs.class = "usa-select usa-sr-only usa-combo-box__select";
  const blank = mk("OPTION", { textContent: "", value: "" });
  blank.attrs.value = "";
  select.options = [blank];
  for (const n of names) {
    const [label, slug, abbr] = n.split("|");
    const o = mk("OPTION", { textContent: `${label} (${abbr})`, innerText: `${label} (${abbr})` });
    o.attrs.value = `/states/${slug}`;
    o.value = `/states/${slug}`;
    o.parentElement = select;
    select.options.push(o);
    select.children.push(o);
    all.push(o);
  }
  select.parentElement = body;
  body.children.push(select);
  all.push(select);

  const document = {
    body,
    querySelectorAll(sel) { return sel === "*" ? all : []; },
  };
  body.querySelectorAll = (sel) => (sel === "*" ? all : []);

  const fn = new Function("document", "location", `return ${EXTRACT_SCRIPT};`);
  return fn(document, { href: "https://www.usa.gov/state-governments" });
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall steering smokes passed");
process.exit(failures ? 1 : 0);
