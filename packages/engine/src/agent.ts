import type { AgentEvent, Msg, Provider, ToolResult } from "./types.js";
import { executeTool, toolDefs, type ToolRuntime } from "./tools.js";
import type { RunControl } from "./control.js";

const SYSTEM_PROMPT = `You are Floe, a browser agent that completes real knowledge-work tasks by operating a live Chromium browser, logged in as the user.

Rules:
- Work step by step. After each action you receive a fresh page snapshot; base your next action on it, never on assumptions.
- Element ids ([n]) stick to the element that owns them for as long as it stays on the page, but ids you have not seen in a recent snapshot may be gone. If a click reports the element is missing, read_page and use a fresh id.
- HARD RULE for any task that asks you to scrape/collect a list into a CSV: the rows MUST be written by paginate_extract, never by workspace_write. Page text in a snapshot is truncated and unreliable for extraction — do not transcribe rows from it. paginate_extract dedupes on a key column, so calling it again (e.g. after fixing a column mapping) is always safe.
- To extract any list, table, directory, feed or search result: call extract_table once to see the structured rows and their cell numbering, then call paginate_extract to write them to a CSV — it extracts, maps cells to columns, dedupes in code, appends, and advances pagination itself (max_pages lets it do several pages in one call). Never retype extracted rows into workspace_write by hand: it is slow, lossy, and skips dedupe. workspace_write is for notes and prose results, not for scraped rows.
- Persist intermediate results to the workspace as you go (workspace_write) — especially for multi-page extraction, append rows to a CSV incrementally so progress survives interruptions. Keep a short notes.md with your plan and progress.
- If a page fails or an element is missing, re-read the page and try a different approach before giving up.
- Respect the user's accounts: act only as needed for the task, never change account settings or send messages unless the task explicitly says to.
- When the task is complete (or truly impossible), call done with an honest summary.`;

/** Extra rules for an agent that can delegate (only added when spawn_agents is available). */
const ORCHESTRATOR_PROMPT = `
You are the ORCHESTRATOR for this task. Extra rules:
- Any part of the task that touches 2+ independent sites, queries, sections or list segments MUST be delegated with spawn_agents, all in ONE call so the executors run in parallel — never visit those pages yourself one after another.
- Each executor gets a complete standalone task: exact URL(s), exactly what to collect, and the exact workspace file name to write (give each a distinct file, e.g. <name>-results.csv). They share this workspace but cannot see your context.
- Keep synthesis for yourself: after spawn_agents returns, read the executors' files with workspace_read and write the final merged deliverable.
- Use your own browser only for work that cannot be parallelised (a quick check, a final verification).`;

/** Injected once when the wall-clock budget runs out, instead of a hard kill. */
const TIME_UP = `TIME IS UP: the wall-clock budget for this task has been reached. Do NOT start new work. Save whatever you already have to the workspace and call done immediately with an honest summary of what is complete and what is not.`;

/** Injected when the operator asks to stop — same graceful shape as TIME_UP. */
const STOP_REQUESTED = `STOP REQUESTED: the operator has asked you to stop. Do NOT start new work. Save whatever you already have to the workspace and call done immediately with an honest summary of what is complete and what is not.`;

export interface AgentOptions {
  maxSteps?: number;
  onEvent?: (e: AgentEvent) => void;
  /** Keep only the last N tool results verbatim; older ones are truncated to save context. */
  toolResultWindow?: number;
  /** Epoch ms after which the agent is told to wrap up (soft stop, not a kill). */
  deadline?: number;
  /** Steps allowed after the deadline warning before the run is stopped anyway. */
  graceSteps?: number;
  /** Name used in emitted events; distinguishes parallel agents in the log. */
  label?: string;
  /** Out-of-band pause/resume/stop, checked between steps. */
  control?: RunControl;
}

export interface AgentRunResult {
  success: boolean;
  summary: string;
  steps: number;
}

export async function runAgent(
  provider: Provider,
  rt: ToolRuntime,
  task: string,
  opts: AgentOptions = {},
): Promise<AgentRunResult> {
  const maxSteps = opts.maxSteps ?? 60;
  const label = opts.label;
  const raw = opts.onEvent ?? (() => {});
  const emit = (e: AgentEvent) => raw(label ? { ...e, agent: label } : e);
  const system = SYSTEM_PROMPT + (rt.spawn ? `\n${ORCHESTRATOR_PROMPT}` : "");
  const tools = toolDefs(rt);
  const messages: Msg[] = [
    { role: "user", content: `Task:\n${task}\n\nWorkspace directory: ${rt.workspace.dir}\nBegin.` },
  ];
  let warned = false;
  let graceLeft = opts.graceSteps ?? 4;

  for (let step = 1; step <= maxSteps; step++) {
    // Between steps is the only safe interruption point: a half-run tool call
    // has already touched a real browser.
    if (opts.control?.isPaused) {
      emit({ type: "paused", step, detail: "paused by operator" });
      await opts.control.gate();
      emit({ type: "resumed", step, detail: "resumed" });
    }
    const stopping = opts.control?.isStopping ?? false;
    if (stopping || (opts.deadline && Date.now() >= opts.deadline)) {
      if (!warned) {
        warned = true;
        messages.push({ role: "user", content: stopping ? STOP_REQUESTED : TIME_UP });
        emit({
          type: "error",
          step,
          detail: stopping ? "stop requested — asking the agent to wrap up" : "time budget reached — asking the agent to wrap up",
        });
      } else if (graceLeft-- <= 0) {
        return {
          success: false,
          summary: stopping
            ? "Stopped on operator request; workspace holds whatever was saved."
            : "Stopped at the time limit; workspace holds whatever was saved.",
          steps: step,
        };
      }
    }
    trimHistory(messages, opts.toolResultWindow ?? 6);
    const res = await provider.chat(system, messages, tools);
    if (res.text) emit({ type: "thought", step, detail: res.text });

    if (res.toolCalls.length === 0) {
      // Model answered without acting — treat text as final.
      return { success: true, summary: res.text, steps: step };
    }

    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    const results: ToolResult[] = [];
    for (const tc of res.toolCalls) {
      emit({ type: "tool_call", step, detail: `${tc.name} ${JSON.stringify(tc.input).slice(0, 300)}` });
      if (tc.name === "done") {
        const input = tc.input as { summary: string; success: boolean };
        emit({ type: "done", step, detail: input.summary });
        return { success: input.success, summary: input.summary, steps: step };
      }
      try {
        const out = await executeTool(rt, tc.name, tc.input);
        results.push({ callId: tc.id, content: out });
        emit({ type: "tool_result", step, detail: out.slice(0, 200) });
      } catch (err: any) {
        const msg = `ERROR: ${err.message ?? err}`;
        results.push({ callId: tc.id, content: msg, isError: true });
        emit({ type: "error", step, detail: msg });
      }
    }
    messages.push({ role: "toolResults", results });
  }

  return { success: false, summary: `Hit step limit (${maxSteps}) before completing the task.`, steps: maxSteps };
}

/** Truncate old tool results so long tasks don't blow the context window. */
function trimHistory(messages: Msg[], keepLast: number): void {
  const resultMsgs = messages.filter((m) => m.role === "toolResults");
  const toTrim = resultMsgs.slice(0, Math.max(0, resultMsgs.length - keepLast));
  for (const m of toTrim) {
    if (m.role !== "toolResults") continue;
    for (const r of m.results) {
      if (r.content.length > 400) r.content = r.content.slice(0, 400) + "\n…[trimmed: stale snapshot]";
    }
  }
}
