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
 * Usage: node scripts/eval.mjs [--tier quick|full] [--case <id>] [--headed]
 * npm:   npm run eval:quick | npm run eval
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
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
      resolveRun({ ...out, seconds: Math.round((Date.now() - t0) / 1000) });
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

/** The agent picks its own filenames: match by regex, prefer the largest hit. */
function findFile(workspace, matchRe) {
  if (!workspace || !existsSync(workspace)) return undefined;
  const re = new RegExp(matchRe, "i");
  const hits = readdirSync(workspace).filter((f) => re.test(f));
  if (!hits.length) return undefined;
  return hits
    .map((f) => ({ f, size: readFileSync(join(workspace, f)).length }))
    .sort((a, b) => b.size - a.size)[0].f;
}

const readWs = (workspace, file) => readFileSync(join(workspace, file), "utf8");

// ---------------------------------------------------------------- verifiers

/** One deterministic check → {pass, detail}. Every kind states what it measured. */
function runCheck(check, workspace) {
  const file = findFile(workspace, check.match ?? ".*");
  const need = (what) =>
    file ? null : { pass: false, detail: `no workspace file matching /${check.match}/ (needed for ${what})` };

  switch (check.kind) {
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
async function judge(check, c, run, workspace) {
  const base = process.env.FLOE_BASE_URL;
  const key = process.env.FLOE_API_KEY ?? "none";
  const model = process.env.FLOE_JUDGE_MODEL ?? process.env.FLOE_MODEL ?? "sonnet";
  if (!base) return { pass: false, verdict: { error: "FLOE_BASE_URL not set — judge unavailable" } };

  const fileRe = new RegExp(check.context_files ?? ".*", "i");
  const files = workspace && existsSync(workspace)
    ? readdirSync(workspace).filter((f) => fileRe.test(f))
    : [];
  const fileBlock = files
    .map((f) => `--- FILE: ${f} ---\n${readWs(workspace, f).slice(0, 8000)}`)
    .join("\n\n") || "(the agent wrote no matching files)";

  const prompt = `You are an ADVERSARIAL evaluator of a browser agent's output. Your default stance is suspicion: hunt for fabrication first, credit honesty second. A fabricated "fact" the ground truth does not support is an automatic fail. Vague hand-waving where the task demanded specifics scores low. Do not be generous.

THE TASK GIVEN TO THE AGENT:
${await taskFor(c)}

GROUND TRUTH YOU MAY RELY ON:
${check.ground ?? "(none provided — judge only internal consistency, citations and honesty)"}

RUBRIC (score against this, 0-10):
${check.rubric}

THE AGENT'S FINAL SUMMARY:
${run.summary || "(none)"}

THE AGENT'S OUTPUT FILES:
${fileBlock}

Respond with EXACTLY one JSON object, no markdown, no prose:
{"score": <0-10>, "pass": <true|false>, "reasons": ["<specific reason>", ...]}
"pass" must be true only if score >= ${check.threshold ?? 7} AND no fabrication was found.`;

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
      return { pass: verdict.pass && verdict.score >= (check.threshold ?? 7), verdict };
    } catch (err) {
      if (attempt === 2) return { pass: false, verdict: { error: `judge failed: ${err.message}` } };
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

    const checks = [];
    // Evidence guard: a run that never drove the browser proved nothing — any
    // workspace output came from somewhere else (a chat backend's own toolbox,
    // or pure model memory). Caught live: a gateway backend once wrote a
    // correct-looking report.md without Floe performing a single action.
    checks.push({
      kind: "evidence",
      pass: run.toolCalls > 0,
      detail:
        run.toolCalls > 0
          ? `${run.toolCalls} real tool call(s) recorded`
          : "ZERO tool calls recorded — the agent never acted; output (if any) is not the agent's work",
    });
    for (const check of c.checks) {
      if (check.kind === "judge") {
        const { pass, verdict } = await judge(check, c, run, run.workspace);
        checks.push({ kind: "judge", pass, verdict });
      } else {
        const r = runCheck(check, run.workspace);
        checks.push({ kind: check.kind, ...r });
      }
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
