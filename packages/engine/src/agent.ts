import type { AgentEvent, ChatResponse, Msg, Provider, ToolCall, ToolResult } from "./types.js";
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
  // Deliberately NOT the filesystem path: workspace files are addressed by
  // bare name through the tools, and a backend that never learns the path
  // cannot write "results" into it behind Floe's back.
  const messages: Msg[] = [
    {
      role: "user",
      content: `Task:\n${task}\n\nYou have a private task workspace for files; address them by bare file name via workspace_write / workspace_read / paginate_extract.\nBegin.`,
    },
  ];
  let warned = false;
  let graceLeft = opts.graceSteps ?? 4;
  let acted = false; // has ANY tool call happened this run?
  let protocolNudges = 0;

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
    let res: ChatResponse;
    try {
      res = await provider.chat(system, messages, tools);
    } catch (err: any) {
      // A terminal provider failure must still leave a terminal event in the
      // stream — JSONL consumers otherwise see a run that just stops.
      emit({ type: "error", step, detail: `provider failed permanently: ${err?.message ?? err}` });
      throw err;
    }
    if (res.text) emit({ type: "thought", step, detail: res.text });

    if (res.toolCalls.length === 0) {
      // A text-only answer after real actions is a legitimate final summary.
      // A text-only answer when NOTHING has ever been done is the signature of
      // a protocol escape (e.g. a chat backend "completing" the task with its
      // own toolbox, or claiming work it never performed) — reject it, twice.
      if (!acted && protocolNudges < 2) {
        protocolNudges++;
        messages.push({ role: "assistant", content: res.text, toolCalls: [] });
        messages.push({
          role: "user",
          content:
            "You have not performed a single action in this run: this browser has visited nothing and no workspace file has been written by it, so any result you describe is unverified and will be discarded. Do not answer in prose and do not use any tools of your own environment. Begin the task now by requesting your first action (for example navigate), or call done with success=false if you truly cannot act.",
        });
        emit({ type: "error", step, detail: "model answered without ever acting — protocol nudge injected" });
        continue;
      }
      return { success: acted, summary: res.text, steps: step };
    }

    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    const results: ToolResult[] = [];
    let doneCall: ToolCall | undefined;
    for (const tc of res.toolCalls) {
      emit({ type: "tool_call", step, detail: `${tc.name} ${JSON.stringify(tc.input).slice(0, 300)}` });
      if (tc.name === "done") {
        // Deferred until the siblings ran: models batch "final write + done" in
        // one turn, and returning here would silently drop those writes.
        doneCall = tc;
        continue;
      }
      try {
        const out = await executeTool(rt, tc.name, tc.input);
        // "Acted" means a tool actually EXECUTED — a call that merely parsed
        // (or threw before touching anything) is not evidence of work.
        acted = true;
        results.push({ callId: tc.id, content: out });
        emit({ type: "tool_result", step, detail: eventDetail(out) });
      } catch (err: any) {
        const msg = `ERROR: ${err.message ?? err}`;
        results.push({ callId: tc.id, content: msg, isError: true });
        emit({ type: "error", step, detail: msg });
      }
    }
    if (doneCall) {
      const input = doneCall.input as { summary: string; success: boolean };
      if (input.success && !acted && protocolNudges < 2) {
        // done(success=true) after zero executed actions is the same escape
        // signature as a text-only answer — reject it the same way.
        protocolNudges++;
        results.push({
          callId: doneCall.id,
          content:
            "REJECTED: you report success but this run has not executed a single action — no page was visited and no workspace file was written by your tools, so there is no result to succeed with. Perform the task through your tool actions, or call done with success=false.",
          isError: true,
        });
        emit({ type: "error", step, detail: "done(success=true) with zero executed actions — rejected" });
      } else {
        emit({ type: "done", step, detail: input.summary });
        return { success: input.success, summary: input.summary, steps: step };
      }
    }
    messages.push({ role: "toolResults", results });
  }

  return { success: false, summary: `Hit step limit (${maxSteps}) before completing the task.`, steps: maxSteps };
}

/**
 * What a tool_result event carries: the head of the output, plus any WARNING /
 * [!] lines that fall beyond it — paginate_extract puts its most important
 * line last, and the operator watching the stream must see it too.
 */
function eventDetail(out: string): string {
  const head = out.slice(0, 600);
  const tail = out
    .slice(600)
    .split("\n")
    .filter((l) => /^(WARNING|\[!\])/.test(l.trim()));
  return tail.length ? `${head}\n${tail.join("\n")}` : head;
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
