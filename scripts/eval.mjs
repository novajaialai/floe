#!/usr/bin/env node
/**
 * Floe eval harness — the instrument that decides whether Floe is reliable,
 * not just demo-ready.
 *
 * Each case in evals/cases/*.json runs as a REAL `floe events-run` subprocess
 * (the same public JSONL seam the desktop app uses) against a fresh workspace
 * under FLOE_HOME=~/.floe-eval, then its workspace is verified:
 *   - deterministic checks run in-process (file/csv/regex assertions), and/or
 *   - a judged check sends the output to an LLM judge (gateway, direct chat,
 *     no browser) with an adversarial rubric; its JSON verdict is recorded
 *     verbatim.
 *
 * Results: evals/results/<timestamp>.jsonl + evals/SCOREBOARD.md (with the
 * previous run's totals for comparison). Cases run sequentially — the gateway
 * caps concurrency, and serialized runs keep timings honest.
 *
 * Integrity layer (session 8): every case's JSONL log is parsed into an action
 * trace, and checks are grounded against it — evidence counts only calls that
 * RETURNED (per agent), graded files must be named by a write-capable tool call
 * (foreign files fail, never shadow), CSV row counts are reconciled against
 * paginate_extract's own receipts, citations can be required to match URLs the
 * browser actually showed (citations_visited / trace_nav), and file mtimes must
 * fall inside the run window. Workspace state alone cannot distinguish the
 * agent's work from a protocol-escaping backend's — the trace can.
 *
 * Usage: node scripts/eval.mjs [--tier quick|full] [--case <id>] [--headed]
 * npm:   npm run eval:quick | npm run eval
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASES_DIR = join(ROOT, "evals", "cases");
const RESULTS_DIR = join(ROOT, "evals", "results");
const LOGS_ROOT = join(ROOT, "evals", "results", "logs");
const EVAL_HOME = process.env.FLOE_EVAL_HOME ?? join(homedir(), ".floe-eval");
const CLI = join(ROOT, "packages", "cli", "dist", "main.js");

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const tier = flag("--tier") ?? "full";
const onlyCase = flag("--case");
const headed = args.includes("--headed");

// ---------------------------------------------------------------- case loading

function loadCases() {
  const all = readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(CASES_DIR, f), "utf8")) }));
  if (onlyCase) return all.filter((c) => c.id === onlyCase);
  if (tier === "quick") return all.filter((c) => c.tier === "quick");
  return all;
}

/** Task text: literal, or rendered from the shipped template library. */
async function taskFor(c) {
  if (c.task) return c.task;
  const { findTemplate, renderTemplate } = await import(
    join(ROOT, "packages", "engine", "dist", "index.js")
  );
  return renderTemplate(findTemplate(c.template.id), c.template.inputs ?? {});
}

// ---------------------------------------------------------------- run one case

/**
 * Run the case as a `floe events-run` subprocess, parse its JSONL, and return
 * {success, steps, summary, workspace, seconds, retries, hardTimeout}.
 * A hard watchdog (2× the soft budget + 5 min) kills a wedged run.
 */
function runCase(c, task, logFile) {
  return new Promise((resolveRun) => {
    const argv = [CLI, "events-run", task, "--max-steps", String(c.maxSteps ?? 25)];
    if (c.maxMinutes) argv.push("--max-minutes", String(c.maxMinutes));
    if (c.parallel) argv.push("--parallel", String(c.parallel));
    if (!headed) argv.push("--headless");

    const child = spawn(process.execPath, argv, {
      env: { ...process.env, FLOE_HOME: EVAL_HOME },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const out = { success: false, steps: 0, summary: "", workspace: "", retries: 0, toolCalls: 0, hardTimeout: false };
    const t0 = Date.now();
    const hardMs = ((c.maxMinutes ?? 10) * 2 * 60 + 300) * 1000;
    const watchdog = setTimeout(() => {
      out.hardTimeout = true;
      out.summary = `HARD TIMEOUT after ${Math.round(hardMs / 1000)}s — run killed by the harness`;
      try {
        child.stdin.write('{"cmd":"kill"}\n');
      } catch {}
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, hardMs);

    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        appendFileSync(logFile, line + "\n");
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.ev === "workspace") out.workspace = ev.dir;
        if (typeof ev.step === "number") out.steps = Math.max(out.steps, ev.step);
        if (ev.ev === "log" && /provider retry/.test(ev.msg ?? "")) out.retries++;
        if (ev.ev === "tool_call" && !/^done\b/.test(ev.detail ?? "")) out.toolCalls++;
        if (ev.ev === "end") {
          out.success = ev.success;
          out.steps = ev.steps;
          out.summary = ev.summary ?? "";
          out.workspace = ev.workspace ?? out.workspace;
        }
        if (ev.ev === "fatal" && !out.hardTimeout) out.summary = `FATAL: ${ev.error}`;
      }
    });
    child.stderr.on("data", (d) => appendFileSync(logFile, `[stderr] ${d}`));
    child.on("close", () => {
      clearTimeout(watchdog);
      resolveRun({ ...out, seconds: Math.round((Date.now() - t0) / 1000), closedAt: Date.now() });
    });
  });
}

// ---------------------------------------------------------------- workspace IO

/** RFC4180-ish CSV parse (same dialect Workspace writes: quoted fields, doubled quotes). */
function parseCsv(src) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ------------------------------------------------------------ run-log trace
//
// The per-case JSONL log is the integrity source: it records what Floe's own
// tools actually did. Workspace state alone cannot distinguish the agent's
// writes from a backend's (caught live in session 7), so every check that
// grades an artifact is grounded against this trace.

/**
 * Parse a case's JSONL log into {calls, successfulCalls, byAgent, visited,
 * ownedFiles, writeTargets, csvTotals, startTs, endTs}. Calls are paired with
 * their results per agent — a tool_call followed by an error event (or by
 * nothing) is NOT evidence. Write-capable calls claim the files they name,
 * both from the call input and from the result text ("Wrote X (N chars)",
 * "CSV X: +N new rows … M total rows in file"), which also yields the
 * paginate_extract row receipts. Every URL the browser actually showed is
 * collected from navigate inputs and from the "URL: …" first line every
 * snapshot-returning tool emits.
 */
export function parseTrace(logFile) {
  const trace = {
    startTs: undefined,
    endTs: undefined,
    calls: [],               // {agent, name, input, ok, url?}
    successfulCalls: 0,      // non-done calls that returned a tool_result
    byAgent: new Map(),      // agent -> {calls, ok}
    visited: new Set(),      // normalized URLs the browser actually showed
    visitedRaw: [],          // first-seen raw forms (for the judge / details)
    ownedFiles: new Set(),   // filenames claimed by a write-capable tool call
    writeTargets: new Set(), // filenames written via workspace_write
    csvTotals: new Map(),    // csv name -> max "M total rows in file" receipted
  };
  if (!existsSync(logFile)) return trace;
  const pending = new Map(); // agent -> last unanswered tool call
  const claim = (name, viaWrite) => {
    if (!name) return;
    trace.ownedFiles.add(name);
    if (viaWrite) trace.writeTargets.add(name);
  };
  const visit = (url) => {
    const n = normalizeUrl(url);
    if (!n) return;
    if (!trace.visited.has(n)) trace.visitedRaw.push(url);
    trace.visited.add(n);
  };
  for (const line of readFileSync(logFile, "utf8").split("\n")) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.ev === "start") trace.startTs = ev.ts;
    if (ev.ev === "end") trace.endTs = ev.ts;
    const agent = ev.agent ?? "main";
    if (ev.ev === "tool_call") {
      const detail = ev.detail ?? "";
      const sp = detail.indexOf(" ");
      const name = sp > 0 ? detail.slice(0, sp) : detail;
      const input = sp > 0 ? detail.slice(sp + 1) : "";
      const call = { agent, name, input, ok: false };
      trace.calls.push(call);
      if (name === "done") continue; // done never gets a tool_result
      pending.set(agent, call);
      const a = trace.byAgent.get(agent) ?? { calls: 0, ok: 0 };
      a.calls++;
      trace.byAgent.set(agent, a);
      if (name === "navigate") call.url = input.match(/"url"\s*:\s*"([^"]+)"/)?.[1];
      if (name === "workspace_write") claim(input.match(/"name"\s*:\s*"([^"]+)"/)?.[1], true);
      if (name === "paginate_extract") claim(input.match(/"csv"\s*:\s*"([^"]+)"/)?.[1], false);
    } else if (ev.ev === "tool_result") {
      const call = pending.get(agent);
      if (call) {
        pending.delete(agent);
        call.ok = true;
        trace.successfulCalls++;
        trace.byAgent.get(agent).ok++;
        if (call.url) visit(call.url);
      }
      const d = ev.detail ?? "";
      const u = d.match(/^URL: (\S+)/); // snapshot first line survives truncation
      if (u) visit(u[1]);
      for (const m of d.matchAll(/\((https?:\/\/[^\s)]+)\)/g)) visit(m[1]); // paginate "page N (url)"
      const csv = d.match(/^CSV (\S+): \+\d+ new rows this call, \d+ skipped[^,]*, (\d+) total rows in file/);
      if (csv) {
        claim(csv[1], false);
        trace.csvTotals.set(csv[1], Math.max(trace.csvTotals.get(csv[1]) ?? 0, Number(csv[2])));
      }
      const w = d.match(/^Wrote (\S+) \(\d+ chars\)/);
      if (w) claim(w[1], true);
    } else if (ev.ev === "error") {
      pending.delete(agent); // the pending call failed — not evidence
    }
  }
  return trace;
}

/** Loose URL normalization so cited and visited forms compare: protocol, www, fragment, trailing slash/punctuation. */
export function normalizeUrl(u) {
  if (!u) return "";
  let s = String(u).trim();
  try {
    s = decodeURIComponent(s);
  } catch {}
  s = s.replace(/[.,;:!?'"]+$/, "");
  // Trailing ")" is markdown-link syntax unless the URL itself has a matching "(".
  const opens = (s.match(/\(/g) ?? []).length;
  const closes = (s.match(/\)/g) ?? []).length;
  if (closes > opens) s = s.replace(/\)+$/, "");
  return s
    .replace(/#[^#]*$/, "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Was this cited URL actually shown by the browser during the run? */
export function urlVisited(trace, cited) {
  const c = normalizeUrl(cited);
  if (!c) return true;
  for (const v of trace.visited) {
    if (v === c) return true;
    if (v.startsWith(c) && /^[/?]/.test(v.slice(c.length))) return true; // cited the shorter canonical form of a visited page
    if (c.startsWith(v) && /^[?]/.test(c.slice(v.length))) return true; // cited a query variant of a visited page
  }
  return false;
}

/** Which tool-claimed filename (if any) owns this on-disk file? Executor outputs are prefixed "<name>-". */
export function fileOwner(trace, f) {
  const lf = f.toLowerCase();
  for (const n of trace.ownedFiles) {
    const ln = n.toLowerCase();
    if (lf === ln || lf.endsWith(`-${ln}`)) return n;
  }
  return undefined;
}

/**
 * The agent picks its own filenames: match by regex, prefer tool-owned files
 * (largest first). A matching file that NO tool call ever named is FOREIGN —
 * it reached the workspace some other way (e.g. a protocol-escaping backend),
 * and the old largest-file heuristic would have actively selected it (a
 * complete fake outweighs a partial truth). It is returned flagged, and every
 * file-based check fails on it.
 */
export function findFile(workspace, matchRe, trace) {
  if (!workspace || !existsSync(workspace)) return {};
  const re = new RegExp(matchRe, "i");
  const hits = readdirSync(workspace)
    // The engine's reserved write-manifest is bookkeeping, not an artifact —
    // never grade it (a loose `match` would otherwise flag it FOREIGN).
    .filter((f) => f.toLowerCase() !== ".floe-manifest.jsonl" && re.test(f))
    .map((f) => ({ f, size: readFileSync(join(workspace, f)).length }))
    .sort((a, b) => b.size - a.size);
  if (!hits.length) return {};
  const owned = hits.find((h) => fileOwner(trace, h.f));
  if (owned) return { file: owned.f, owner: fileOwner(trace, owned.f) };
  return { file: hits[0].f, foreign: true };
}

const readWs = (workspace, file) => readFileSync(join(workspace, file), "utf8");

// ---------------------------------------------------------------- verifiers

/** One deterministic check → {pass, detail}. Every kind states what it measured. */
export function runCheck(check, workspace, trace) {
  // Trace-only kinds first — they must not be failed by unrelated foreign files.
  if (check.kind === "trace_nav") {
    // Distinct SUCCESSFUL navigate calls matching a URL pattern. The artifact
    // may be trivially memorizable — only the recorded navigation trace proves
    // the browser actually visited the pages.
    const re = new RegExp(check.url_regex, "i");
    const urls = new Set(
      trace.calls
        .filter((t) => t.name === "navigate" && t.ok && t.url && re.test(t.url))
        .map((t) => normalizeUrl(t.url)),
    );
    const want = check.min_distinct ?? 1;
    return {
      pass: urls.size >= want,
      detail: `${urls.size} distinct successful navigate(s) matching /${check.url_regex}/ (want >= ${want})${urls.size ? `: ${[...urls].join(", ")}`.slice(0, 300) : ""}`,
    };
  }

  const { file, foreign, owner } = findFile(workspace, check.match ?? ".*", trace);
  // A FOREIGN file (present, but never named by any tool call) must never be
  // graded — crediting it would launder work Floe did not do.
  if (file && foreign)
    return {
      pass: false,
      detail: `FOREIGN_FILE: ${file} matches /${check.match}/ but no recorded tool call ever wrote it`,
    };
  const need = (what) =>
    file ? null : { pass: false, detail: `no workspace file matching /${check.match}/ (needed for ${what})` };

  switch (check.kind) {
    case "row_accounting": {
      // Receipts reconciliation (the dual of "the disk is the truth": the disk
      // may contain ONLY what the tools receipted). Scraped rows must come from
      // paginate_extract, and the on-disk row count must equal the tool's own
      // "M total rows in file" receipt — a backend topping up missing rows (or
      // replacing the file) breaks the equality.
      const miss = need("row_accounting");
      if (miss) return miss;
      const disk = parseCsv(readWs(workspace, file)).length - 1;
      if (trace.writeTargets.has(owner))
        return {
          pass: false,
          detail: `${file}: written via workspace_write (hand transcription) — scraped rows must come from paginate_extract, whose receipts make them accountable`,
        };
      const receipted = trace.csvTotals.get(owner);
      if (receipted === undefined)
        return { pass: false, detail: `${file}: no paginate_extract receipt names it — its ${disk} data rows are unaccounted` };
      return {
        pass: disk === receipted,
        detail: `${file}: ${disk} data rows on disk vs ${receipted} receipted by paginate_extract${disk === receipted ? "" : " — MISMATCH: rows were added or replaced outside the tool"}`,
      };
    }
    case "citations_visited": {
      // Every URL cited in the artifact must have actually been shown by the
      // browser during the run. Plausible prose with invented citations is the
      // judge's blind spot; the trace is not.
      const miss = need("citations_visited");
      if (miss) return miss;
      const cited = [...new Set(readWs(workspace, file).match(/https?:\/\/[^\s<>"'\]]+/g) ?? [])];
      if (!cited.length)
        return { pass: false, detail: `${file}: no cited URLs found (citations were required)` };
      const unvisited = cited.filter((u) => !urlVisited(trace, u));
      return unvisited.length
        ? {
            pass: false,
            detail: `${file}: ${unvisited.length}/${cited.length} cited URL(s) never opened by the browser: ${unvisited.slice(0, 3).join(" ")}`,
          }
        : { pass: true, detail: `${file}: all ${cited.length} cited URL(s) were actually visited` };
    }
    case "file": {
      return file
        ? { pass: true, detail: `file present: ${file}` }
        : { pass: false, detail: `no file matching /${check.match}/` };
    }
    case "csv_rows": {
      const miss = need("csv_rows");
      if (miss) return miss;
      const n = parseCsv(readWs(workspace, file)).length - 1; // minus header
      const ok =
        (check.exact === undefined || n === check.exact) &&
        (check.min === undefined || n >= check.min) &&
        (check.max === undefined || n <= check.max);
      const want =
        check.exact !== undefined ? `exactly ${check.exact}` : `${check.min ?? 0}..${check.max ?? "∞"}`;
      return { pass: ok, detail: `${file}: ${n} data rows (want ${want})` };
    }
    case "csv_columns": {
      const miss = need("csv_columns");
      if (miss) return miss;
      const header = parseCsv(readWs(workspace, file))[0] ?? [];
      const missing = check.required.filter((rx) => !header.some((h) => new RegExp(rx, "i").test(h)));
      return missing.length
        ? { pass: false, detail: `${file}: header [${header.join(", ")}] missing ${missing.join(", ")}` }
        : { pass: true, detail: `${file}: header has ${check.required.join(", ")}` };
    }
    case "csv_unique": {
      const miss = need("csv_unique");
      if (miss) return miss;
      const rows = parseCsv(readWs(workspace, file));
      const header = rows[0] ?? [];
      const idx = header.findIndex((h) => new RegExp(check.column, "i").test(h));
      if (idx < 0) return { pass: false, detail: `${file}: no column matching /${check.column}/` };
      const vals = rows.slice(1).map((r) => (r[idx] ?? "").replace(/\s+/g, " ").trim().toLowerCase());
      const dupes = vals.length - new Set(vals).size;
      return { pass: dupes === 0, detail: `${file}: ${dupes} duplicate value(s) in "${header[idx]}"` };
    }
    case "csv_sequence": {
      // Structural: a numeric column must be exactly first..last (HN rank continuity).
      const miss = need("csv_sequence");
      if (miss) return miss;
      const rows = parseCsv(readWs(workspace, file));
      const header = rows[0] ?? [];
      const idx = Math.max(0, header.findIndex((h) => new RegExp(check.column, "i").test(h)));
      const nums = rows.slice(1).map((r) => parseInt(String(r[idx]).replace(/\D+$/, ""), 10));
      const want = Array.from({ length: check.last - check.first + 1 }, (_, i) => check.first + i);
      const ok = nums.length === want.length && want.every((v, i) => nums[i] === v);
      return {
        pass: ok,
        detail: `${file}: column "${header[idx]}" ${ok ? `runs ${check.first}..${check.last}` : `= [${nums.slice(0, 8).join(",")}…] (want ${check.first}..${check.last} continuous)`}`,
      };
    }
    case "content": {
      const miss = need("content");
      if (miss) return check.expect === false ? { pass: true, detail: `no file matching /${check.match}/ — nothing to violate` } : miss;
      const hit = new RegExp(check.regex, "im").test(readWs(workspace, file));
      const expect = check.expect !== false;
      return {
        pass: hit === expect,
        detail: `${file}: /${check.regex}/ ${hit ? "matched" : "did not match"} (expected ${expect ? "match" : "no match"})`,
      };
    }
    default:
      return { pass: false, detail: `unknown check kind "${check.kind}"` };
  }
}

// ---------------------------------------------------------------- LLM judge

/**
 * Adversarial judge: gateway sonnet, direct chat, no browser. It is told to
 * hunt for fabrication FIRST and to fail ambiguity. Returns the strict-JSON
 * verdict verbatim: {score: 0-10, pass: bool, reasons: [...]}.
 */
async function judge(check, c, run, workspace, trace) {
  const base = process.env.FLOE_BASE_URL;
  const key = process.env.FLOE_API_KEY ?? "none";
  const model = process.env.FLOE_JUDGE_MODEL ?? process.env.FLOE_MODEL ?? "sonnet";
  if (!base) return { pass: false, verdict: { error: "judge unavailable: FLOE_BASE_URL not set" }, model };

  const fileRe = new RegExp(check.context_files ?? ".*", "i");
  const files = workspace && existsSync(workspace)
    ? readdirSync(workspace).filter((f) => f.toLowerCase() !== ".floe-manifest.jsonl" && fileRe.test(f))
    : [];
  const fileBlock = files
    .map((f) => `--- FILE: ${f} ---\n${readWs(workspace, f).slice(0, 8000)}`)
    .join("\n\n") || "(the agent wrote no matching files)";

  // The judge never saw the run — hand it the recorded action trace as ground
  // truth, so "cited with URL" prose is falsifiable instead of taken on style.
  const toolCounts = {};
  for (const t of trace.calls) if (t.ok) toolCounts[t.name] = (toolCounts[t.name] ?? 0) + 1;
  const traceBlock = [
    `Steps: ${run.steps}. Successful tool calls: ${trace.successfulCalls} (${Object.entries(toolCounts).map(([k, v]) => `${k}×${v}`).join(", ") || "none"}). Agents: ${[...trace.byAgent.keys()].join(", ") || "none"}.`,
    `URLs the agent's browser actually opened during the run:`,
    trace.visitedRaw.slice(0, 40).map((u) => `  - ${u}`).join("\n") || "  (none)",
  ].join("\n");

  const prompt = `You are an ADVERSARIAL evaluator of a browser agent's output. Your default stance is suspicion: hunt for fabrication first, credit honesty second. A fabricated "fact" the ground truth does not support is an automatic fail. Vague hand-waving where the task demanded specifics scores low. Do not be generous.

THE TASK GIVEN TO THE AGENT:
${await taskFor(c)}

GROUND TRUTH YOU MAY RELY ON:
${check.ground ?? "(none provided — judge only internal consistency, citations and honesty)"}

RECORDED ACTION TRACE (harness-recorded ground truth from the run log — the agent could not edit this):
${traceBlock}
A URL cited in the output that does NOT appear in the visited list above was very likely never opened by the agent — treat a cited-but-unvisited primary source as fabrication. (The list may omit intermediate pagination pages; apply this rule to cited sources, not to obvious mid-pagination steps.)

RUBRIC (score against this, 0-10):
${check.rubric}

THE AGENT'S FINAL SUMMARY:
${run.summary || "(none)"}

THE AGENT'S OUTPUT FILES:
${fileBlock}

Respond with EXACTLY one JSON object, no markdown, no prose:
{"score": <0-10>, "pass": <true|false>, "reasons": ["<specific reason>", ...]}
"pass" must be true only if score >= ${check.threshold ?? 7} AND no fabrication was found.`;

  const jt0 = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(180_000),
      });
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? "";
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error(`no JSON in judge reply: ${text.slice(0, 120)}`);
      const verdict = JSON.parse(m[0]);
      if (typeof verdict.score !== "number" || typeof verdict.pass !== "boolean")
        throw new Error("judge JSON missing score/pass");
      return { pass: verdict.pass && verdict.score >= (check.threshold ?? 7), verdict, model, ms: Date.now() - jt0 };
    } catch (err) {
      // A transport/format failure is a fail for the case (correct direction),
      // marked "judge unavailable" so a red case is attributable to the judge,
      // not the agent.
      if (attempt === 2)
        return { pass: false, verdict: { error: `judge unavailable: ${err.message}` }, model, ms: Date.now() - jt0 };
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---------------------------------------------------------------- scoreboard

function previousTotals() {
  if (!existsSync(RESULTS_DIR)) return undefined;
  const runs = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".jsonl")).sort();
  const last = runs[runs.length - 1];
  if (!last) return undefined;
  const lines = readFileSync(join(RESULTS_DIR, last), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cases = lines.filter((l) => l.id);
  return {
    file: last,
    tier: lines.find((l) => l.meta)?.meta?.tier ?? "?",
    passed: cases.filter((c) => c.pass).length,
    total: cases.length,
  };
}

function writeScoreboard(runId, results, totalSeconds, prev) {
  const passed = results.filter((r) => r.pass).length;
  const pct = results.length ? Math.round((passed / results.length) * 100) : 0;
  const rows = results
    .map((r) => {
      const checks = r.checks
        .map((c) => `${c.pass ? "✓" : "✗"} ${c.kind}${c.verdict ? ` (judge ${c.verdict.score ?? "?"}/10)` : ""}`)
        .join("<br>");
      return `| ${r.pass ? "✅" : "❌"} | ${r.id} | ${r.tier} | ${r.steps} | ${r.seconds}s | ${r.retries} | ${checks} | ${(r.note ?? "").replaceAll("|", "\\|")} |`;
    })
    .join("\n");
  const prevLine = prev
    ? `Previous run: **${prev.passed}/${prev.total}** (${prev.tier}, \`${prev.file}\`)`
    : "Previous run: none (first recorded run)";
  writeFileSync(
    join(ROOT, "evals", "SCOREBOARD.md"),
    `# Floe eval scoreboard

Run \`${runId}\` — tier **${tier}** — **${passed}/${results.length} passed (${pct}%)** — ${Math.round(totalSeconds / 60)} min total.
${prevLine}

Scores are honest: failing cases stay red until the engine earns the pass. Do not tune cases to green.

| | case | tier | steps | wall | retries | checks | note |
|---|---|---|---|---|---|---|---|
${rows}

Raw per-run data: \`evals/results/${runId}.jsonl\` (judged cases carry the judge's JSON verdict verbatim).
Control-protocol coverage (pause/resume/graceful stop) lives in \`scripts/smoke-events.mjs\`, not here — no duplication.
`,
  );
}

// ---------------------------------------------------------------- main

async function main() {
  const cases = loadCases();
  if (!cases.length) {
    console.error(onlyCase ? `no case with id "${onlyCase}"` : "no cases found");
    process.exit(1);
  }
  mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logDir = join(LOGS_ROOT, runId);
  mkdirSync(logDir, { recursive: true });
  const jsonlPath = join(RESULTS_DIR, `${runId}.jsonl`);
  const prev = previousTotals();

  console.log(`floe eval — ${cases.length} case(s), tier=${tier}, home=${EVAL_HOME}`);
  appendFileSync(jsonlPath, JSON.stringify({ meta: { runId, tier, cases: cases.length, started: new Date().toISOString() } }) + "\n");

  const results = [];
  const suiteT0 = Date.now();
  for (const c of cases) {
    const task = await taskFor(c);
    const logFile = join(logDir, `${c.id}.jsonl`);
    writeFileSync(logFile, "");
    process.stdout.write(`\n▸ ${c.id} … `);
    const run = await runCase(c, task, logFile);

    const trace = parseTrace(logFile);
    const checks = [];
    // Evidence guard, trace-grounded. A run that never drove the browser proved
    // nothing — any workspace output came from somewhere else (a chat backend's
    // own toolbox, or pure model memory). Caught live: a gateway backend once
    // wrote a correct-looking report.md without Floe performing a single action.
    // Only calls that RETURNED count (the tool_call event is emitted before
    // execution, so a printed-but-failed call is not evidence); every agent that
    // acted must have at least one successful call (an aggregate count would let
    // an orchestrator's real calls mask a fully-escaped executor); and a case
    // whose checks grade an artifact requires at least one successful navigate
    // AND one successful write-capable call.
    {
      const artifactCase = (c.checks ?? []).some(
        (ch) =>
          ["file", "csv_rows", "csv_columns", "csv_unique", "csv_sequence", "row_accounting", "citations_visited"].includes(ch.kind) ||
          (ch.kind === "content" && ch.expect !== false),
      );
      const okNav = trace.calls.some((t) => t.name === "navigate" && t.ok);
      const okWrite = trace.calls.some((t) => (t.name === "workspace_write" || t.name === "paginate_extract") && t.ok);
      const idle = [...trace.byAgent].filter(([, s]) => s.ok === 0).map(([a]) => a);
      const problems = [];
      if (trace.successfulCalls === 0)
        problems.push("ZERO successful tool calls — the agent never acted; output (if any) is not the agent's work");
      if (idle.length) problems.push(`agent(s) recorded calls but none succeeded: ${idle.join(", ")}`);
      if (artifactCase && trace.successfulCalls > 0) {
        if (!okNav) problems.push("no successful navigate — artifact produced without browsing");
        if (!okWrite) problems.push("no successful write-capable call (workspace_write/paginate_extract) — artifact has no tool origin");
      }
      checks.push({
        kind: "evidence",
        pass: problems.length === 0,
        detail: problems.length
          ? problems.join("; ")
          : `${trace.successfulCalls} successful tool call(s) across ${trace.byAgent.size} agent(s)`,
      });
    }
    for (const check of c.checks) {
      if (check.kind === "judge") {
        const { pass, verdict, model, ms } = await judge(check, c, run, run.workspace, trace);
        checks.push({ kind: "judge", pass, verdict, model, ms });
      } else {
        const r = runCheck(check, run.workspace, trace);
        checks.push({ kind: check.kind, ...r });
      }
    }
    // Foreign-write timeline: a workspace file whose mtime falls outside the
    // run window [start, end+2s] was written while Floe was not running (e.g. a
    // backend finishing its write after the run closed). Statted as late as
    // possible — after the judge — to widen the detection window.
    {
      const ws = run.workspace;
      let detail = "no workspace files to check";
      let offenders = [];
      if (ws && existsSync(ws)) {
        const start = (trace.startTs ?? 0) - 2000;
        const end = (trace.endTs ?? run.closedAt) + 2000;
        offenders = readdirSync(ws).filter((f) => {
          const ms = statSync(join(ws, f)).mtimeMs;
          return ms < start || ms > end;
        });
        detail = offenders.length
          ? `FOREIGN_WRITE: mtime outside the run window for: ${offenders.join(", ")}`
          : "all file mtimes inside the run window";
      }
      checks.push({ kind: "integrity_mtime", pass: offenders.length === 0, detail });
    }
    const pass = checks.every((ch) => ch.pass) && !run.hardTimeout;
    const note = run.hardTimeout
      ? "hard timeout"
      : checks.filter((ch) => !ch.pass).map((ch) => ch.detail ?? ch.verdict?.reasons?.[0] ?? "").join("; ").slice(0, 200);
    const result = {
      id: c.id,
      tier: c.tier,
      pass,
      agentReportedSuccess: run.success,
      steps: run.steps,
      seconds: run.seconds,
      retries: run.retries,
      workspace: run.workspace,
      summary: run.summary.slice(0, 500),
      checks,
      note,
    };
    results.push(result);
    appendFileSync(jsonlPath, JSON.stringify(result) + "\n");
    console.log(`${pass ? "PASS" : "FAIL"} (${run.steps} steps, ${run.seconds}s${run.retries ? `, ${run.retries} retries` : ""})`);
    for (const ch of checks) console.log(`    ${ch.pass ? "✓" : "✗"} ${ch.kind}: ${ch.detail ?? JSON.stringify(ch.verdict).slice(0, 200)}`);
  }

  const totalSeconds = Math.round((Date.now() - suiteT0) / 1000);
  writeScoreboard(runId, results, totalSeconds, prev);
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed — ${Math.round(totalSeconds / 60)} min — evals/SCOREBOARD.md updated`);
  process.exit(passed === results.length ? 0 : 1);
}

// FLOE_EVAL_LIB=1 imports the verifier functions without running the suite —
// used by scripts/smoke-eval-checks.mjs to unit-test the trace plumbing.
if (!process.env.FLOE_EVAL_LIB) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
