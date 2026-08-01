import type { AgentEvent, Msg, Provider, ToolResult } from "./types.js";
import { executeTool, toolDefs, type ToolRuntime } from "./tools.js";

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

export interface AgentOptions {
  maxSteps?: number;
  onEvent?: (e: AgentEvent) => void;
  /** Keep only the last N tool results verbatim; older ones are truncated to save context. */
  toolResultWindow?: number;
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
  const emit = opts.onEvent ?? (() => {});
  const messages: Msg[] = [
    { role: "user", content: `Task:\n${task}\n\nWorkspace directory: ${rt.workspace.dir}\nBegin.` },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    trimHistory(messages, opts.toolResultWindow ?? 6);
    const res = await provider.chat(SYSTEM_PROMPT, messages, toolDefs());
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
