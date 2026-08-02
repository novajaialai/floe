#!/usr/bin/env node
/**
 * Live smoke for the headless runner protocol (`floe events-run`).
 *
 * Run A: pause mid-run → assert the agent stops taking steps → resume → it finishes.
 * Run B: stop mid-run   → assert a graceful wrap-up (a done/end with a real summary),
 *        not a kill.
 *
 * Needs the model endpoint (see README); tasks are deliberately tiny.
 *   node scripts/smoke-events.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "dist", "main.js");
const TASK = "Go to https://example.com and report the exact text of the page heading. Do not save any files.";
const PAUSE_WINDOW_MS = 15000;
const TIMEOUT_MS = 5 * 60 * 1000;

function startRun(extraArgs = []) {
  const child = spawn(process.execPath, [CLI, "events-run", TASK, "--headless", "--max-steps", "8", ...extraArgs], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const events = [];
  const waiters = [];
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      throw new Error(`stdout was not JSONL: ${line}`);
    }
    events.push(e);
    if (e.ev !== "log") console.log(`   ← ${e.ev}${e.step ? `[${e.agent}:${e.step}]` : ""} ${(e.detail ?? e.summary ?? e.dir ?? e.state ?? "").toString().slice(0, 90)}`);
    for (const w of [...waiters]) {
      if (w.test(e)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(e);
      }
    }
  });
  const until = (test, what) =>
    new Promise((resolve, reject) => {
      const w = { test, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), TIMEOUT_MS).unref();
    });
  const send = (cmd) => child.stdin.write(JSON.stringify({ cmd }) + "\n");
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, events, until, send, exited };
}

const isStep = (e) => e.ev === "thought" || e.ev === "tool_call" || e.ev === "tool_result";
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

async function runA() {
  console.log("\n== Run A: pause → resume → completes ==");
  const r = startRun();
  const start = await r.until((e) => e.ev === "start", "start event");
  if (!start.task) fail("start event has no task");
  await r.until((e) => e.ev === "workspace", "workspace event");
  await r.until((e) => e.ev === "tool_call", "first tool_call");

  r.send("pause");
  const paused = await r.until((e) => e.ev === "paused", "paused event");
  const at = r.events.length;
  console.log(`   paused at step ${paused.step}; watching for ${PAUSE_WINDOW_MS / 1000}s of silence…`);
  await new Promise((res) => setTimeout(res, PAUSE_WINDOW_MS));
  const during = r.events.slice(at).filter(isStep);
  if (during.length) fail(`${during.length} step events arrived while paused: ${JSON.stringify(during[0])}`);
  console.log("   OK: no step events while paused");

  r.send("resume");
  await r.until((e) => e.ev === "resumed", "resumed event");
  const end = await r.until((e) => e.ev === "end", "end event");
  const code = await r.exited;
  if (!r.events.some(isStep, at)) fail("no work resumed after resume");
  if (!end.summary) fail("end event has no summary");
  console.log(`   OK: finished — success=${end.success}, steps=${end.steps}, exit=${code}`);
  return true;
}

async function runB() {
  console.log("\n== Run B: stop → graceful wrap-up ==");
  const r = startRun();
  await r.until((e) => e.ev === "tool_call", "first tool_call");
  r.send("stop");
  const warn = await r.until((e) => e.ev === "error" && /stop requested/i.test(e.detail ?? ""), "stop warning");
  console.log(`   OK: agent told to wrap up at step ${warn.step}`);
  const end = await r.until((e) => e.ev === "end", "end event");
  await r.exited;
  if (!end.summary || end.summary.length < 10) fail(`stop produced no honest summary: ${JSON.stringify(end)}`);
  if (!end.workspace) fail("end event has no workspace");
  console.log(`   OK: graceful end after ${end.steps} steps — "${end.summary.slice(0, 120)}"`);
  return true;
}

await runA();
await runB();
console.log("\nsmoke-events: PASS");
