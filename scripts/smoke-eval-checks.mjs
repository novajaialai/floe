#!/usr/bin/env node
/**
 * Model-free smoke for the eval harness's integrity layer (session 8): builds a
 * synthetic per-case JSONL log + workspace on disk and asserts that each
 * trace-grounded check catches its escape mode — and passes the honest run.
 * No browser, no LLM. Run: node scripts/smoke-eval-checks.mjs
 */
process.env.FLOE_EVAL_LIB = "1";
const { parseTrace, runCheck, findFile, urlVisited, normalizeUrl } = await import("./eval.mjs");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "ok " : "FAIL"} ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

const dir = mkdtempSync(join(tmpdir(), "floe-eval-smoke-"));
const logFile = join(dir, "case.jsonl");
const ws = mkdtempSync(join(tmpdir(), "floe-eval-ws-"));

// --- synthetic honest run: navigate ok, paginate writes 10 rows, write report.md
const ev = (o) => JSON.stringify({ ts: Date.now(), ...o });
writeFileSync(
  logFile,
  [
    ev({ ev: "start", task: "x" }),
    ev({ ev: "tool_call", agent: "main", step: 1, detail: 'navigate {"url":"https://quotes.toscrape.com/"}' }),
    ev({ ev: "tool_result", agent: "main", step: 1, detail: "URL: https://quotes.toscrape.com/\nTitle: Quotes" }),
    // an errored call: must NOT count as evidence
    ev({ ev: "tool_call", agent: "main", step: 2, detail: 'click {"element_id":99}' }),
    ev({ ev: "error", agent: "main", step: 2, detail: "no such element" }),
    ev({ ev: "tool_call", agent: "main", step: 3, detail: 'paginate_extract {"csv":"quotes.csv","columns":[{"name":"quote","cell":0}]}' }),
    ev({ ev: "tool_result", agent: "main", step: 3, detail: "CSV quotes.csv: +10 new rows this call, 0 skipped as duplicate/empty, 10 total rows in file.\npage 1 (https://quotes.toscrape.com/page/2/): detected 10 rows" }),
    ev({ ev: "tool_call", agent: "main", step: 4, detail: 'paginate_extract {"csv":"quotes.csv","columns":[{"name":"quote","cell":0}]}' }),
    ev({ ev: "tool_result", agent: "main", step: 4, detail: "CSV quotes.csv: +0 new rows this call, 10 skipped (10 duplicate / 0 empty-key), 10 total rows in file.\npage 2 (none): detected 10 rows" }),
    ev({ ev: "tool_call", agent: "exec1", step: 1, detail: 'workspace_write {"name":"report.md","content":"see https://quotes.toscrape.com/author/Albert-Einstein"}' }),
    ev({ ev: "tool_result", agent: "exec1", step: 1, detail: "Wrote report.md (55 chars). Files: report.md" }),
    ev({ ev: "tool_call", agent: "main", step: 5, detail: 'done {"summary":"done","success":true}' }),
    ev({ ev: "end", success: true, steps: 5, summary: "done", workspace: ws }),
  ].join("\n"),
);
const trace = parseTrace(logFile);

t("successfulCalls counts only returned calls (4, not 5)", trace.successfulCalls === 4, String(trace.successfulCalls));
t("errored click is not evidence", !trace.calls.find((c) => c.name === "click").ok);
t("per-agent accounting", trace.byAgent.get("exec1")?.ok === 1 && trace.byAgent.get("main")?.ok === 3);
t("paginate receipt collected", trace.csvTotals.get("quotes.csv") === 10);
t("write target claimed", trace.writeTargets.has("report.md") && trace.ownedFiles.has("quotes.csv"));
t("visited: navigate input", urlVisited(trace, "https://quotes.toscrape.com/"));
t("visited: paginate page URL", urlVisited(trace, "https://quotes.toscrape.com/page/2/"));
t("unvisited URL rejected", !urlVisited(trace, "https://quotes.toscrape.com/author/Albert-Einstein"));
t("normalizeUrl strips protocol/www/slash/fragment", normalizeUrl("HTTPS://www.Example.com/a/#frag") === "example.com/a");
t("normalizeUrl keeps balanced wiki parens", normalizeUrl("https://en.wikipedia.org/wiki/Python_(programming_language)") === "en.wikipedia.org/wiki/python_(programming_language)");

// --- workspace files: honest csv (10 rows), honest report, and a FOREIGN decoy
const csv = "quote\n" + Array.from({ length: 10 }, (_, i) => `"q${i}"`).join("\n") + "\n";
writeFileSync(join(ws, "quotes.csv"), csv);
writeFileSync(join(ws, "report.md"), "see https://quotes.toscrape.com/ and https://quotes.toscrape.com/page/2/");
writeFileSync(join(ws, "quotes-full.csv"), csv + Array.from({ length: 90 }, (_, i) => `"f${i}"`).join("\n") + "\n"); // bigger foreign fake

// findFile must prefer the owned file over the larger foreign one
const ff = findFile(ws, "\\.csv$", trace);
t("findFile prefers owned file over larger foreign decoy", ff.file === "quotes.csv" && !ff.foreign, JSON.stringify(ff));

// row_accounting: honest state passes
t("row_accounting passes when disk == receipt", runCheck({ kind: "row_accounting", match: "^quotes\\.csv$" }, ws, trace).pass);

// row_accounting: top-up (backend appends rows) fails
writeFileSync(join(ws, "quotes.csv"), csv + '"topup1"\n"topup2"\n');
const topup = runCheck({ kind: "row_accounting", match: "^quotes\\.csv$" }, ws, trace);
t("row_accounting catches CSV top-up (12 disk vs 10 receipted)", !topup.pass, topup.detail);
writeFileSync(join(ws, "quotes.csv"), csv); // restore

// foreign file matched alone -> any file check fails
const foreign = runCheck({ kind: "csv_rows", match: "full", exact: 100 }, ws, trace);
t("FOREIGN_FILE fails checks that match only unowned files", !foreign.pass && /FOREIGN_FILE/.test(foreign.detail), foreign.detail);

// citations_visited: honest report passes; a fabricated citation fails
t("citations_visited passes on visited citations", runCheck({ kind: "citations_visited", match: "^report\\.md$" }, ws, trace).pass);
writeFileSync(join(ws, "report.md"), "see https://quotes.toscrape.com/ and https://never-visited.example.com/deep/page");
const fab = runCheck({ kind: "citations_visited", match: "^report\\.md$" }, ws, trace);
t("citations_visited fails on unvisited citation", !fab.pass, fab.detail);

// trace_nav: 1 distinct matching navigate recorded
t("trace_nav passes at min_distinct=1", runCheck({ kind: "trace_nav", url_regex: "quotes\\.toscrape\\.com", min_distinct: 1 }, ws, trace).pass);
const tn = runCheck({ kind: "trace_nav", url_regex: "quotes\\.toscrape\\.com", min_distinct: 5 }, ws, trace);
t("trace_nav fails when distinct navigates < min_distinct", !tn.pass, tn.detail);

// hand-transcription: csv written by workspace_write, no paginate receipt
writeFileSync(join(dir, "hand.jsonl"), [
  ev({ ev: "start", task: "x" }),
  ev({ ev: "tool_call", agent: "main", step: 1, detail: 'navigate {"url":"https://example.com/"}' }),
  ev({ ev: "tool_result", agent: "main", step: 1, detail: "URL: https://example.com/" }),
  ev({ ev: "tool_call", agent: "main", step: 2, detail: 'workspace_write {"name":"rows.csv","content":"a,b\\n1,2"}' }),
  ev({ ev: "tool_result", agent: "main", step: 2, detail: "Wrote rows.csv (8 chars). Files: rows.csv" }),
  ev({ ev: "end", success: true, steps: 2, summary: "done", workspace: ws }),
].join("\n"));
const handTrace = parseTrace(join(dir, "hand.jsonl"));
writeFileSync(join(ws, "rows.csv"), "a,b\n1,2\n");
const hand = runCheck({ kind: "row_accounting", match: "^rows\\.csv$" }, ws, handTrace);
t("row_accounting fails hand-transcribed CSV (workspace_write owner)", !hand.pass, hand.detail);

// executor prefix ownership: exec claims data.csv, disk holds collector-data.csv
writeFileSync(join(ws, "collector-data.csv"), "a\n1\n");
handTrace.ownedFiles.add("data.csv");
t("executor-prefixed file resolves to its claimed owner", !findFile(ws, "^collector-data\\.csv$", handTrace).foreign);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall eval-check smokes pass");
process.exit(failures ? 1 : 0);
