#!/usr/bin/env node
import { basename } from "node:path";
import {
  Scheduler,
  WorkflowStore,
  appendHistory,
  floeHome,
  loadTemplate,
  readHistory,
  renderTemplate,
  runStamp,
  runWorkspaceRoot,
  upcoming,
  type Workflow,
} from "@floe/engine";
import { runTask, stamp } from "./runner.js";
import { LABEL, agentStatus, installAgent, schedulerLogPath, uninstallAgent } from "./launchd.js";

function usage(): never {
  console.log(`floe — open-source browser agent (MIT)

Usage:
  floe run "<task>" [options]                 Run a one-off task
  floe workflow save <name> [...]             Save a reusable (optionally scheduled) workflow
  floe workflow list | show <name> | rm <name>
  floe workflow run <name> [--headed]         Run a saved workflow now
  floe history [<name>] [--limit <n>]         Recent runs
  floe schedule [--once] [--interval <sec>]   Run due workflows (daemon, or one pass)
  floe schedule install [--interval <sec>] | uninstall | status

Run options:
  --max-steps <n>       Step limit for the main agent (default 60)
  --max-minutes <n>     Wall-clock budget; the agent is asked to wrap up (no hard kill)
  --parallel <n>        Max executor subagents running at once (default 3)
  --headless            Run the browser headless
  --profile <dir>       Browser profile dir (default ~/.floe/profile)

workflow save options:
  --task "<prompt>"     The task text (or use --template)
  --template <file>     templates/*.yaml to build the prompt from
  --input k=value       Template input (repeatable); fills {k} placeholders
  --schedule "<cron>"   5-field cron, local time, e.g. "0 7 * * *"
  --no-schedule         Drop the schedule (re-saving an existing name edits it)
  --max-steps/--max-minutes/--parallel   as above
  --headed              Show the browser (scheduled runs are headless by default)

Provider config (env):
  FLOE_PROVIDER         anthropic | openai (default: anthropic if ANTHROPIC_API_KEY set, else openai)
  ANTHROPIC_API_KEY     Anthropic key (BYO)
  FLOE_MODEL            Planner/orchestrator model
  FLOE_EXECUTOR_MODEL   Cheap lane for spawned executors (default: same as FLOE_MODEL)
  FLOE_TOOL_MODE        prompt = tool calls over plain text (endpoints without function calling)
  FLOE_BASE_URL         OpenAI-compatible base URL (e.g. http://127.0.0.1:8088)
  FLOE_API_KEY          Key for the OpenAI-compatible endpoint
  FLOE_HOME             State dir (default ~/.floe)`);
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string): number | undefined => {
  const v = flag(name);
  return v === undefined ? undefined : Number(v);
};
const has = (name: string) => args.includes(name);
/** All values of a repeatable flag, e.g. --input a=1 --input b=2 */
const multi = (name: string): string[] =>
  args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));

async function main() {
  switch (args[0]) {
    case "run":
      return cmdRun();
    case "workflow":
      return cmdWorkflow();
    case "history":
      return cmdHistory();
    case "schedule":
      return cmdSchedule();
    default:
      usage();
  }
}

async function cmdRun() {
  if (!args[1]) usage();
  const r = await runTask({
    task: args[1],
    maxSteps: num("--max-steps"),
    maxMinutes: num("--max-minutes"),
    parallel: num("--parallel"),
    headless: has("--headless"),
    profileDir: flag("--profile"),
  });
  process.exitCode = r.success ? 0 : 2;
}

async function cmdWorkflow() {
  const store = new WorkflowStore();
  const sub = args[1];
  const name = args[2];
  switch (sub) {
    case "save": {
      if (!name) usage();
      const tplFile = flag("--template");
      let task = flag("--task");
      let schedule = flag("--schedule");
      let inputs: Record<string, string> | undefined;
      if (tplFile) {
        const tpl = loadTemplate(tplFile);
        inputs = Object.fromEntries(
          multi("--input").map((kv) => {
            const i = kv.indexOf("=");
            if (i < 0) throw new Error(`--input must be key=value (got "${kv}")`);
            return [kv.slice(0, i), kv.slice(i + 1)];
          }),
        );
        task = renderTemplate(tpl, inputs);
        schedule ??= tpl.schedule;
      }
      const existing = store.get(name);
      // Re-saving an existing workflow edits it: only the flags you pass change.
      task ??= existing?.task;
      schedule ??= existing?.schedule;
      if (!task) {
        console.error("workflow save needs --task \"<prompt>\" or --template <file>");
        process.exit(1);
      }
      const wf: Workflow = {
        name,
        task,
        schedule: has("--no-schedule") ? undefined : schedule,
        maxSteps: num("--max-steps") ?? existing?.maxSteps ?? 60,
        maxMinutes: num("--max-minutes") ?? existing?.maxMinutes,
        parallel: num("--parallel") ?? existing?.parallel ?? 3,
        // Unattended by default: a scheduled run has no one watching.
        headless: has("--headed") ? false : (has("--headless") ? true : existing?.headless ?? true),
        template: tplFile ? basename(tplFile) : existing?.template,
        inputs: inputs ?? existing?.inputs,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      store.save(wf);
      const next = upcoming(wf);
      console.log(`saved workflow "${name}" → ${store.dir}/${name}.json`);
      if (wf.schedule) console.log(`  schedule: ${wf.schedule}  next: ${next ? next.toLocaleString() : "never"}`);
      else console.log("  no schedule (manual runs only)");
      return;
    }
    case "list": {
      const all = store.list();
      if (!all.length) return console.log("no workflows yet — floe workflow save <name> --task \"...\"");
      for (const wf of all) {
        const next = upcoming(wf);
        console.log(
          `${wf.name.padEnd(24)} ${(wf.schedule ?? "manual").padEnd(16)} ${next ? `next ${next.toLocaleString()}` : ""}`,
        );
        console.log(`  ${wf.task.replace(/\s+/g, " ").slice(0, 100)}`);
      }
      return;
    }
    case "show": {
      if (!name) usage();
      console.log(JSON.stringify(store.require(name), null, 2));
      return;
    }
    case "rm": {
      if (!name) usage();
      console.log(store.remove(name) ? `removed "${name}"` : `no workflow named "${name}"`);
      return;
    }
    case "run": {
      if (!name) usage();
      const wf = store.require(name);
      const ok = await executeWorkflow(wf, "manual", has("--headed") ? false : wf.headless);
      process.exitCode = ok ? 0 : 2;
      return;
    }
    default:
      usage();
  }
}

/** Run a saved workflow into its own timestamped workspace + a history line. */
async function executeWorkflow(wf: Workflow, trigger: string, headless = wf.headless): Promise<boolean> {
  console.log(`${stamp()} ▸ workflow "${wf.name}" (${trigger})`);
  const r = await runTask({
    task: wf.task,
    workspaceRoot: runWorkspaceRoot(wf.name),
    taskId: runStamp(),
    maxSteps: wf.maxSteps,
    maxMinutes: wf.maxMinutes,
    parallel: wf.parallel,
    headless,
  });
  appendHistory({
    name: wf.name,
    start: r.start,
    end: r.end,
    success: r.success,
    steps: r.steps,
    workspace: r.workspaceDir,
    summary: r.summary.replace(/\s+/g, " ").slice(0, 200),
    trigger,
  });
  return r.success;
}

function cmdHistory() {
  const name = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  const entries = readHistory(name, num("--limit") ?? 20);
  if (!entries.length) return console.log("no runs recorded yet");
  for (const e of entries) {
    const mins = ((new Date(e.end).getTime() - new Date(e.start).getTime()) / 60_000).toFixed(1);
    console.log(
      `${new Date(e.start).toLocaleString()}  ${e.success ? "OK  " : "FAIL"}  ${e.name}  ${e.steps} steps  ${mins} min  (${e.trigger})`,
    );
    console.log(`   ${e.summary}`);
    console.log(`   ${e.workspace}`);
  }
}

async function cmdSchedule() {
  switch (args[1]) {
    case "install": {
      const interval = num("--interval") ?? 300;
      const p = installAgent(interval);
      console.log(`installed ${LABEL} → ${p} (every ${interval}s, RunAtLoad)`);
      console.log(`log: ${schedulerLogPath()}`);
      console.log(agentStatus());
      return;
    }
    case "uninstall":
      console.log(uninstallAgent() ? `removed ${LABEL}` : `${LABEL} was not installed`);
      return;
    case "status": {
      console.log(`${LABEL}: ${agentStatus()}`);
      const store = new WorkflowStore();
      for (const wf of store.list().filter((w) => w.schedule)) {
        const next = upcoming(wf);
        console.log(`  ${wf.name}: ${wf.schedule} → next ${next ? next.toLocaleString() : "never"}`);
      }
      return;
    }
  }
  const store = new WorkflowStore();
  const scheduler = new Scheduler({
    listWorkflows: () => store.list(),
    run: (wf, trigger) => executeWorkflow(wf, trigger).then(() => undefined),
    log: (m) => console.log(`${stamp()} ${m}`),
  });
  if (has("--once")) {
    const ran = await scheduler.tick();
    console.log(`${stamp()} tick: ${ran.length ? `ran ${ran.join(", ")}` : "nothing due"}`);
    return;
  }
  const interval = (num("--interval") ?? 30) * 1000;
  console.log(`${stamp()} floe scheduler running (state: ${floeHome()}), polling every ${interval / 1000}s`);
  for (const wf of store.list().filter((w) => w.schedule)) {
    const next = upcoming(wf);
    console.log(`  ${wf.name}: ${wf.schedule} → next ${next ? next.toLocaleString() : "never"}`);
  }
  await scheduler.loop(interval);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
