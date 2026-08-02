import { createInterface } from "node:readline";
import { RunControl, appendHistory, runStamp, runWorkspaceRoot, type AgentEvent, type Workflow } from "@floe/engine";
import { closeActiveBrowser, runTask, setLogSink, type TaskOptions } from "./runner.js";

/**
 * Headless runner protocol — the seam every UI (and any embedder) talks to.
 *
 * stdout is pure JSONL, one object per line, each with an `ev` discriminator:
 *   {"ev":"start","ts":…,"task":…}          run accepted
 *   {"ev":"workspace","ts":…,"dir":…}       run workspace on disk
 *   {"ev":"log","ts":…,"msg":…}             human-readable line (never parse it)
 *   {"ev":"thought"|"tool_call"|"tool_result"|"done"|"error"|"paused"|"resumed"|"ws_write",
 *    "ts":…,"agent":"main","step":3,"detail":…}
 *   ("ws_write" = a receipted workspace write: file, bytes added, size after, owning tool)
 *   {"ev":"control","ts":…,"state":"running"|"paused"|"stopping"}
 *   {"ev":"end","ts":…,"success":…,"steps":…,"summary":…,"workspace":…}
 *   {"ev":"fatal","ts":…,"error":…}
 *
 * stdin accepts one JSON command per line:
 *   {"cmd":"pause"} {"cmd":"resume"} {"cmd":"stop"} {"cmd":"kill"} {"cmd":"ping"}
 * `stop` is graceful (the agent is told to wrap up and call done); `kill` closes
 * the browser and exits immediately.
 */
export interface EventsRunOptions extends Omit<TaskOptions, "control" | "onEvent" | "onWorkspace"> {
  /** Saved workflow this run came from; its history line is written on end. */
  workflow?: Workflow;
}

const emit = (obj: Record<string, unknown>): void => {
  process.stdout.write(JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
};

export async function eventsRun(opts: EventsRunOptions): Promise<number> {
  const control = new RunControl();
  control.onChange = (state) => emit({ ev: "control", state });
  // stdout is the protocol: every human line becomes a log event instead.
  setLogSink((msg) => emit({ ev: "log", msg }));

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let cmd: string | undefined;
    try {
      cmd = (JSON.parse(text) as { cmd?: string }).cmd;
    } catch {
      // Bare words are accepted too, so a human can drive it from a terminal.
      cmd = text;
    }
    switch (cmd) {
      case "pause":
        return control.pause();
      case "resume":
        return control.resume();
      case "stop":
        return control.stop();
      case "ping":
        return emit({ ev: "control", state: control.state });
      case "kill":
        emit({ ev: "fatal", error: "killed by operator" });
        void closeActiveBrowser().finally(() => process.exit(137));
        return;
      default:
        emit({ ev: "error", step: 0, agent: "main", detail: `unknown command: ${cmd}` });
    }
  });

  emit({ ev: "start", task: opts.task, workflow: opts.workflow?.name });
  try {
    const r = await runTask({
      ...opts,
      control,
      // Structured events are the protocol; the prose log would duplicate them.
      logEvents: false,
      onWorkspace: (dir) => emit({ ev: "workspace", dir }),
      onEvent: (e: AgentEvent) =>
        emit({ ev: e.type, agent: e.agent ?? "main", step: e.step, detail: e.detail }),
    });
    if (opts.workflow) {
      appendHistory({
        name: opts.workflow.name,
        start: r.start,
        end: r.end,
        success: r.success,
        steps: r.steps,
        workspace: r.workspaceDir,
        summary: r.summary.replace(/\s+/g, " ").slice(0, 200),
        trigger: "app",
      });
    }
    emit({
      ev: "end",
      success: r.success,
      steps: r.steps,
      summary: r.summary,
      workspace: r.workspaceDir,
    });
    rl.close();
    return r.success ? 0 : 2;
  } catch (err: any) {
    emit({ ev: "fatal", error: err?.message ?? String(err) });
    rl.close();
    return 1;
  }
}

/** Workspace root + id for a workflow run, matching `floe workflow run`. */
export function workflowRunPaths(wf: Workflow): { workspaceRoot: string; taskId: string } {
  return { workspaceRoot: runWorkspaceRoot(wf.name), taskId: runStamp() };
}
