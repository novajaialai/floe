import { runAgent } from "./agent.js";
import type { FloeBrowser } from "./browser.js";
import type { SpawnFn, SpawnSpec } from "./tools.js";
import type { AgentEvent, Provider } from "./types.js";
import type { Workspace } from "./workspace.js";
import type { RunControl } from "./control.js";

export interface SpawnerOptions {
  browser: FloeBrowser;
  workspace: Workspace;
  /** Build a provider for a model id; undefined = the default executor lane. */
  providerFor: (model?: string) => Provider;
  /** Cheap lane used when an executor does not name a model. */
  executorModel?: string;
  /** Executors running at once (the gateway caps concurrent requests). */
  maxParallel?: number;
  maxStepsDefault?: number;
  onEvent?: (e: AgentEvent) => void;
  /** Shared wall-clock deadline; executors inherit the orchestrator's. */
  deadline?: number;
  /** Shared pause/stop control; executors inherit the orchestrator's. */
  control?: RunControl;
}

interface ExecutorOutcome {
  name: string;
  model: string;
  success: boolean;
  steps: number;
  seconds: number;
  startedAt: string;
  endedAt: string;
  summary: string;
  /** Code-side truth about what the executor actually wrote. */
  files: string;
}

/**
 * Fan-out: each executor gets its own BrowserSession (its own window), its own
 * agent loop with the ordinary browser tools, and the SHARED task workspace —
 * which is how results come back: files on disk plus the done summary.
 *
 * Blocking (the orchestrator's tool call returns when everyone is finished) is
 * deliberate: it is the simplest correct design, and it keeps the executors'
 * results and the orchestrator's synthesis in one causal order.
 */
export function createSpawner(opts: SpawnerOptions): SpawnFn {
  const limit = Math.max(1, opts.maxParallel ?? 3);
  const used = new Set<string>();

  return async (specs: SpawnSpec[]): Promise<string> => {
    const queue = specs.map((spec, i) => ({ spec, index: i, name: uniqueName(spec.name, i, used) }));
    const outcomes: ExecutorOutcome[] = new Array(queue.length);
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        const item = queue[cursor++];
        if (!item) return;
        outcomes[item.index] = await runExecutor(item.name, item.spec, opts);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));

    const files = opts.workspace.list();
    return [
      `${outcomes.length} executor(s) finished (${outcomes.filter((o) => o.success).length} succeeded), max ${limit} at a time.`,
      ...outcomes.map(
        (o) =>
          `\n--- ${o.name} [${o.model}] ${o.success ? "OK" : "INCOMPLETE"} — ${o.steps} steps, ${o.seconds}s (${o.startedAt} → ${o.endedAt})\n${o.summary.slice(0, 1500)}\n[verified] ${o.files}`,
      ),
      `\nWorkspace files now present: ${files.join(", ") || "(none)"}`,
      `The [verified] lines are measured from disk — trust them over an executor's own summary. If an executor wrote nothing, re-spawn it with a more explicit task.`,
      `Read the files you need with workspace_read, then write the merged deliverable yourself.`,
    ].join("\n");
  };
}

async function runExecutor(name: string, spec: SpawnSpec, opts: SpawnerOptions): Promise<ExecutorOutcome> {
  const model = spec.model ?? opts.executorModel ?? "(default)";
  const before = fileState(opts.workspace);
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  const emit = opts.onEvent ?? (() => {});
  emit({ type: "tool_call", step: 0, agent: name, detail: `executor started [${model}]` });

  let session;
  try {
    session = await opts.browser.createSession(name);
  } catch (err: any) {
    return finish(name, model, false, 0, t0, startedAt, `Could not open a browser window: ${err.message ?? err}`, opts.workspace, before);
  }
  try {
    const res = await runAgent(
      opts.providerFor(spec.model),
      { session, workspace: opts.workspace },
      executorTask(name, spec.task, opts.workspace.dir),
      {
        maxSteps: Math.min(Math.max(1, spec.max_steps ?? opts.maxStepsDefault ?? 25), 60),
        deadline: opts.deadline,
        control: opts.control,
        label: name,
        onEvent: opts.onEvent,
      },
    );
    return finish(name, model, res.success, res.steps, t0, startedAt, res.summary, opts.workspace, before);
  } catch (err: any) {
    return finish(name, model, false, 0, t0, startedAt, `Executor crashed: ${err.message ?? err}`, opts.workspace, before);
  } finally {
    await opts.browser.closeSession(name).catch(() => {});
    emit({ type: "tool_result", step: 0, agent: name, detail: `executor finished after ${Math.round((Date.now() - t0) / 1000)}s` });
  }
}

function finish(
  name: string,
  model: string,
  success: boolean,
  steps: number,
  t0: number,
  startedAt: string,
  summary: string,
  workspace: Workspace,
  before: Map<string, number>,
): ExecutorOutcome {
  const end = Date.now();
  return {
    name,
    model,
    success,
    steps,
    seconds: Math.round((end - t0) / 1000),
    startedAt: startedAt.slice(11, 19),
    endedAt: new Date(end).toISOString().slice(11, 19),
    summary,
    files: describeWrites(name, workspace, before),
  };
}

/** name → byte size, so we can tell what an executor really touched. */
function fileState(workspace: Workspace): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of workspace.list()) {
    try {
      out.set(f, workspace.read(f).length);
    } catch {
      out.set(f, -1);
    }
  }
  return out;
}

/**
 * An executor's summary is a *claim*; this is the receipt. Models — small ones
 * especially — will report "wrote results.csv" after skipping the write, so the
 * orchestrator is told what changed on disk, not what it was told.
 */
function describeWrites(agent: string, workspace: Workspace, before: Map<string, number>): string {
  const after = fileState(workspace);
  const mine: string[] = [];
  let others = 0;
  for (const [file, size] of after) {
    const prev = before.get(file);
    if (prev === size) continue;
    // Siblings run at the same time, so only this agent's namespace is its own.
    if (!file.startsWith(`${agent}-`) && !file.startsWith(agent)) {
      others++;
      continue;
    }
    const body = workspace.read(file).trim();
    const csv = file.endsWith(".csv");
    const rows = Math.max(0, body ? body.split("\n").length - (csv ? 1 : 0) : 0);
    mine.push(`${file} (${prev === undefined ? "new" : "updated"}, ${rows} ${csv ? "data rows" : "lines"})`);
  }
  const note = others ? ` (${others} other file(s) changed meanwhile — siblings running in parallel)` : "";
  return mine.length
    ? `files written: ${mine.join(", ")}${note}`
    : `FILES WRITTEN: NONE — nothing appeared on disk for this executor${note}. Treat its summary as unverified and re-spawn it if you need the data.`;
}

/** Framing that makes an executor safe to run beside its siblings. */
function executorTask(name: string, task: string, dir: string): string {
  return `You are executor agent "${name}", one of several agents working IN PARALLEL on one larger task, each in its own browser window.

Your assignment:
${task}

Shared-workspace rules:
- The workspace (${dir}) is shared with the other agents. Every file YOU create must start with "${name}-" (e.g. ${name}-results.csv). Never write to, overwrite or delete a file that does not start with "${name}-".
- You cannot see or talk to the other agents. Do only your own assignment; do not attempt the whole task.
- Report back by (1) writing your results to your file(s) and (2) calling done with a short summary that names the files you wrote and the number of records in them.
- Before you call done you MUST have actually run the action that writes your file (paginate_extract for rows, workspace_write for prose) and then read it back with workspace_read to confirm it exists and holds the expected content. Never report a file you have not seen come back from workspace_read — your caller checks the disk and an unwritten file is a failed task.`;
}

function uniqueName(requested: string | undefined, index: number, used: Set<string>): string {
  const base = (requested ?? `agent-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || `agent-${index + 1}`;
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}-${n++}`;
  used.add(name);
  return name;
}
