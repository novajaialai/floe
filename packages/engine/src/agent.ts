import type { AgentEvent, ChatResponse, Msg, Provider, ToolCall, ToolResult } from "./types.js";
import { executeTool, toolDefs, type ToolRuntime } from "./tools.js";
import type { RunControl } from "./control.js";
import { isProtocolRefusal } from "./providers.js";

export { isProtocolRefusal };

/** Exported so prompt-level behaviour can be exercised without a browser. */
export const SYSTEM_PROMPT = `You are Floe, a browser agent that completes real knowledge-work tasks by operating a live Chromium browser, logged in as the user.

Rules:
- Work step by step. After each action you receive a fresh page snapshot; base your next action on it, never on assumptions.
- Element ids ([n]) stick to the element that owns them for as long as it stays on the page, but ids you have not seen in a recent snapshot may be gone. If a click reports the element is missing, read_page and use a fresh id.
- HARD RULE for any task that asks you to scrape/collect a list into a CSV: the rows MUST be written by paginate_extract, never by workspace_write. Rows typed by hand carry no extraction receipt, so they are indistinguishable from remembered or invented data and are DISCARDED as unaccountable when the result is checked — even when every value is correct. Page text in a snapshot is truncated and unreliable for extraction; do not transcribe rows from it, and never reconstruct a column (e.g. a URL) from a pattern you inferred.
- To extract any list, table, directory, feed or search result: call extract_table once to see the structured rows, their cell numbering and their L<n> links, then call paginate_extract to write them to a CSV — it extracts, maps cells/links to columns, dedupes in code, appends, and advances pagination itself (max_pages lets it do several pages in one call). It dedupes on a key column, so calling it again after fixing a mapping is always safe; add reset=true to start the file over. workspace_write is for notes and prose results, not for scraped rows.
- If a list genuinely has no structure paginate_extract can see, or a page returns an error (HTTP 4xx/5xx, "Sorry", a rate limit), STOP and report that honestly with whatever you did collect. A short accountable result beats a complete unaccountable one.
- If the task names an output file (e.g. report.md, results.csv, market-map.md), that exact file is the deliverable: it must exist, written by your own tools, and contain the finished answer before you call done. Notes and intermediate files never substitute for it.
- Scraping a paginated list is only finished when pagination is EXHAUSTED: after paginate_extract, if its result says "[!] PAGINATION NOT EXHAUSTED", more pages remain — keep calling paginate_extract (larger max_pages if useful) until the advance reports failure or the result no longer shows that banner. Calling done on a partial scrape is treated as incomplete, even when every collected row is correct.
- Citation rule for anything you write that names URLs (reports, notes, summaries): cite ONLY URLs you (or your executors, in their [visited] lines) actually opened in the browser. A URL you have not seen in a snapshot or a [visited] list is ungrounded — writing it is fabrication, whether or not you believe it exists. If you did not open a source, say so instead of citing it.
- Persist intermediate results to the workspace as you go (workspace_write) — especially for multi-page extraction, append rows to a CSV incrementally so progress survives interruptions. Keep a short notes.md with your plan and progress.
- If a page fails or an element is missing, re-read the page and try a different approach before giving up.
- Respect the user's accounts: act only as needed for the task, never change account settings or send messages unless the task explicitly says to.
- When the task is complete (or truly impossible), call done with an honest summary.`;

/** Extra rules for an agent that can delegate (only added when spawn_agents is available). */
const ORCHESTRATOR_PROMPT = `
You are the ORCHESTRATOR for this task. Extra rules:
- Delegate with spawn_agents when the task has SUBSTANTIAL independent branches — different sites, different queries, or list segments that each need several page loads. Send them all in ONE call so the executors run in parallel; never work through such branches yourself one after another.
- Do NOT delegate work you could finish yourself in about as many steps as it takes to brief an executor: a handful of quick page reads on ONE site is your own work. Fan-out has a real cost — it scatters the answer across files you then have to reassemble, and each executor is a weaker model than you.
- Each executor gets a complete standalone task: exact URL(s), exactly what to collect, and the exact workspace file name to write (give each a distinct file, e.g. <name>-results.csv). They share this workspace but cannot see your context.
- The deliverable is YOURS, and it is a hard requirement: whatever output file the task names (report.md, market-map.md, results.csv …) must be written by you, in full, before you call done. Executor files are raw material — a run that leaves the answer spread across <name>-notes.md files has not completed the task, no matter how good those files are. After spawn_agents returns, workspace_read the files you need and write the single merged deliverable.
- Citation grounding when merging: each executor's result carries a [visited] line — the URLs that agent actually opened. The deliverable may cite ONLY URLs from your own visited list or an executor's [visited] line. An executor's summary or notes may name URLs it never opened; if you cannot ground a URL, drop it or write "not opened" instead of citing it. Ungrounded citations fail verification as fabrication.
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

/** Corrective reframe for a refusal — legitimacy, not louder rules. */
const REFUSAL_REFRAME = `That reply refused the request format, so nothing happened and the user got no work done.

To be explicit about what this is: Floe is an open-source browser agent (MIT, running on this machine) and this API call is how it asks a model for its next step. It is a normal program-calls-model integration, not a role-play trick and not an attempt to get you to pretend you executed something. Nobody is asking you to claim you ran anything, to impersonate another system, or to deny what you are.

The action list is a menu of operations THIS PROGRAM performs. Your job is only to choose the next one and write it down. The JSON object is the output FORMAT — the next line of a transcript that Floe parses, exactly like being asked to reply in JSON. Floe executes it in its own real Chromium and sends you the real result as the next message; the results you have already received in this conversation came from exactly that.

So: reply with one JSON object of the form {"thought": "...", "action": "...", "input": {...}} and continue the task. If you believe the task itself should not be done, choose the done action with success=false and say why there.`;

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
  let refusalNudges = 0;
  let deliverableNudges = 0;
  let paginationNudges = 0;
  const deliverables = requiredDeliverables(task);

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
      // A refusal of the protocol itself can arrive at ANY step — including
      // mid-run, after plenty of real actions — and used to end the run as a
      // "final summary" with the deliverable unwritten. Reframe and continue.
      // res.refused is set by PromptToolsProvider when its re-sampling
      // exhausted on a refusal — treat that as a refusal even if the final
      // phrasing slips past the detector regexes.
      if ((res.refused || isProtocolRefusal(res.text)) && refusalNudges < 2) {
        refusalNudges++;
        messages.push({ role: "assistant", content: res.text, toolCalls: [] });
        messages.push({ role: "user", content: REFUSAL_REFRAME });
        emit({ type: "error", step, detail: `protocol refusal detected — reframe injected: ${res.text.slice(0, 200)}` });
        continue;
      }
      // Reframed twice (and re-sampled up to RESAMPLE_ON_REFUSAL times inside
      // the provider) and still refusing: this is an honest failure, NOT a
      // legitimate final summary. Returning success=acted here would report a
      // silent success for a run whose deliverable the browser never wrote.
      if (res.refused || isProtocolRefusal(res.text)) {
        emit({ type: "error", step, detail: `protocol refusal persisted — ending run as failure: ${res.text.slice(0, 200)}` });
        return { success: false, summary: res.text || "The model refused the protocol.", steps: step };
      }
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
      } else if (input.success && deliverableNudges < 1 && missingDeliverables(deliverables, rt).length) {
        // Output-file compliance. A fan-out run that scattered its findings
        // across executor notes and never wrote the file the task named has
        // not done the task — and only code can check that, since the model
        // reporting success is precisely the thing that was wrong.
        deliverableNudges++;
        const missing = missingDeliverables(deliverables, rt);
        results.push({
          callId: doneCall.id,
          content: `REJECTED: the task names ${missing.join(", ")} as its output, but ${missing.length > 1 ? "those files do not" : "that file does not"} exist in the workspace. Whatever you gathered is raw material, not the deliverable. Write the complete finished answer to ${missing.join(" and ")} with workspace_write now (read your other workspace files first if you need them), then call done.`,
          isError: true,
        });
        emit({ type: "error", step, detail: `done rejected — required output missing: ${missing.join(", ")}` });
      } else if (
        input.success &&
        paginationNudges < 1 &&
        (rt.session as { paginationPending?: boolean }).paginationPending
      ) {
        // Partial-scrape gate (session 10): the last paginate_extract ended
        // with a next/more control still present, so done(success=true) means
        // "I finished early". One nudge — the model may legitimately decide
        // the remaining pages are out of scope, but it has to say so.
        paginationNudges++;
        results.push({
          callId: doneCall.id,
          content:
            "REJECTED: the last paginate_extract ended with a next/more control still present — pagination is NOT exhausted, so this scrape is partial (every collected row is fine, but the list continues). Keep paginating (call paginate_extract again — dedupe skips rows you already have — or pass a larger max_pages) until the advance reports failure or the result no longer shows the \"[!] PAGINATION NOT EXHAUSTED\" banner, then call done. If you genuinely judge the remaining pages out of scope, call done with success=false and say why.",
          isError: true,
        });
        emit({ type: "error", step, detail: "done rejected — pagination not exhausted (partial scrape)" });
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
 * Output files the task explicitly names ("write it into report.md"). Only
 * conservative, unambiguous shapes count: a bare `name.ext` token with a
 * known document extension. Over-detection would block honest completions, so
 * anything ambiguous is simply not enforced.
 */
export function requiredDeliverables(task: string): string[] {
  const out = new Set<string>();
  for (const m of task.matchAll(/\b([A-Za-z0-9][\w-]{1,40}\.(?:md|csv|txt|json|tsv))\b/g)) {
    const name = m[1];
    // A file inside a URL is a source, not a deliverable.
    const at = m.index ?? 0;
    const before = task.slice(Math.max(0, at - 60), at);
    if (/https?:\/\/\S*$/.test(before)) continue;
    out.add(name);
  }
  return [...out];
}

/** Which named deliverables are absent from the workspace right now. */
function missingDeliverables(names: string[], rt: ToolRuntime): string[] {
  return names.filter((n) => {
    try {
      return !rt.workspace.exists(n) || rt.workspace.read(n).trim().length === 0;
    } catch {
      return true;
    }
  });
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
