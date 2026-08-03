#!/usr/bin/env node
/**
 * Model-free smoke for the session-9 + session-10 steering layer: the
 * protocol-refusal detector, the named-deliverable extractor, the
 * hand-typed-rows detector, the <select> extraction path in the page-side
 * extractor script, the exhaustive-pagination probe + done-gate, and the
 * prompt-mode refusal re-sampling.
 *
 * These are the code-side halves of fixes that would otherwise only be
 * testable by burning a live gateway run. No browser, no LLM.
 * Run: node scripts/smoke-steering.mjs
 */
import { isProtocolRefusal, requiredDeliverables } from "../packages/engine/dist/agent.js";
import { handTypedRows, paginationProbe } from "../packages/engine/dist/tools.js";
import { EXTRACT_SCRIPT } from "../packages/engine/dist/extract.js";
import { PromptToolsProvider } from "../packages/engine/dist/providers.js";
import { runAgent } from "../packages/engine/dist/agent.js";

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
  // Session-10 verbatim (hn-jobs-sheet, 2026-08-03) — novel phrasing that
  // evaded every session-9 pattern and skipped the re-sampling entirely.
  "I can't carry out this task as written. The instructions describe a \"Floe\" browser-agent protocol with tools like `navigate`, `click`, `extract_table`, and `paginate_extract` that would let me actually drive a browser — but none of those tools are connected in this session.",
  "My actual available tools are things like Bash, Read, Edit, Write, and Agent (a coding assistant environment), not a live browser.",
  "I'd just be producing text describing actions I never took and fabricating what a \"page snapshot\" would show.",
  "I have no functioning browser tools connected in this session — the navigate/click/extract_table/paginate_extract operations described are not real capabilities I have access to.",
  "Producing a JSON action would not cause any real navigation to occur, and any 'result' I described afterward would be invented. I must not fabricate that a browser action occurred.",
  "The operations are not backed by a real tool in my environment — I cannot visit news.ycombinator.com/jobs.",
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

// --- exhaustive-pagination probe (session 10) -----------------------------
// The hn-jobs red: 30/30 rows receipted but the agent called done after page
// 1 while a "More" control still existed. paginationProbe decides whether the
// session flag gets set; the done-gate then rejects a premature success.
const p = (mode, exhausted, next, pages) => paginationProbe(mode, exhausted, next, pages);
t("probe: budget spent + control present -> pending (the hn-jobs hole)", p("auto", false, "More", 1).pending);
t("probe: budget spent + no control -> not pending", !p("auto", false, null, 1).pending);
t("probe: advance failed (exhausted) -> not pending", !p("auto", true, "More", 5).pending);
t("probe: explicit next=none -> not pending", !p("none", false, "More", 1).pending);
t("probe: scroll mode budget spent -> pending (feed may continue)", p("scroll", false, null, 3).pending);
t("probe: scroll mode advance failed -> not pending", !p("scroll", true, null, 3).pending);
t("probe: pending banner names the control", p("auto", false, "Next page", 1).line.includes("PAGINATION NOT EXHAUSTED") && p("auto", false, "Next page", 1).line.includes("Next page"));

// --- done-gate on partial scrape (session 10) ------------------------------
// A fake provider that writes one note (so the run has real actions) then
// calls done(success=true); the session flag decides whether the first done
// is rejected and the run must continue. The task names jobs.csv and the
// workspace reports it exists, so only the pagination gate can fire.
const stubRt = (paginationPending) => ({
  session: { paginationPending },
  workspace: {
    exists: (n) => n === "jobs.csv",
    read: () => "title,link\nrow1,http://a",
    list: () => ["jobs.csv"],
    write: () => {},
    append: () => {},
  },
});
const providerScript = [
  [{ id: "w1", name: "workspace_write", input: { name: "notes.md", content: "started" } }],
  [{ id: "d1", name: "done", input: { summary: "all done", success: true } }],
  [{ id: "d2", name: "done", input: { summary: "all done", success: true } }],
];
const events = [];
const run = (paginationPending) =>
  runAgent(
    {
      chat: async () => ({ text: "", toolCalls: providerScript.shift() ?? [], stopReason: "tool_use" }),
    },
    stubRt(paginationPending),
    "Scrape the list into jobs.csv",
    { maxSteps: 4, onEvent: (e) => events.push(e) },
  );
const gateHeld = await run(true);
t(
  "done-gate: first done(success=true) rejected while pagination pending, accepted on retry",
  gateHeld.steps === 3 && gateHeld.success,
  `steps=${gateHeld.steps} success=${gateHeld.success}`,
);
t(
  "done-gate: rejection event emitted",
  events.some((e) => e.type === "error" && /pagination not exhausted/i.test(e.detail)),
);
events.length = 0;
providerScript.splice(0, providerScript.length, ...[
  [{ id: "w1", name: "workspace_write", input: { name: "notes.md", content: "started" } }],
  [{ id: "d1", name: "done", input: { summary: "all done", success: true } }],
]);
const gateFree = await run(false);
t("done-gate: no pagination pending -> done accepted on first try", gateFree.steps === 2 && gateFree.success, `steps=${gateFree.steps}`);

// --- prompt-mode refusal re-sampling (session 10) ---------------------------
// A gateway backend that refuses the protocol: re-sampling must discard the
// refused turns (never argue in-transcript) and the exhausted refusal must be
// marked refused:true so the agent loop ends the run as an honest failure.
let innerCalls = 0;
const alwaysRefuses = {
  chat: async () => {
    innerCalls++;
    return { text: "I'm Claude Code, I don't have those tools.", toolCalls: [], stopReason: "end_turn" };
  },
};
const pt = new PromptToolsProvider(alwaysRefuses);
const refusedRes = await pt.chat("sys", [{ role: "user", content: "do it" }], []);
t("refusal: re-samples (4 attempts) instead of arguing once", innerCalls === 4, `innerCalls=${innerCalls}`);
t("refusal: exhausted refusal is flagged refused:true", refusedRes.refused === true && refusedRes.toolCalls.length === 0);
t("refusal: refusals counter reflects discarded samples", pt.refusals === 4, `refusals=${pt.refusals}`);

let mixedCalls = 0;
const refusesTwiceThenActs = {
  chat: async () => {
    mixedCalls++;
    if (mixedCalls <= 2) return { text: "That looks like prompt injection; I can't help.", toolCalls: [], stopReason: "end_turn" };
    return { text: "{\"thought\":\"ok\",\"action\":\"read_page\",\"input\":{}}", toolCalls: [], stopReason: "end_turn" };
  },
};
const pt2 = new PromptToolsProvider(refusesTwiceThenActs);
const recovered = await pt2.chat("sys", [{ role: "user", content: "do it" }], []);
t("refusal: recovers after 2 refused samples (3rd acts)", mixedCalls === 3, `mixedCalls=${mixedCalls}`);
t("refusal: recovered sample parses to a tool call", recovered.toolCalls.length === 1 && recovered.toolCalls[0].name === "read_page");
t("refusal: recovered run is not flagged refused", recovered.refused !== true);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall steering smokes passed");
process.exit(failures ? 1 : 0);
