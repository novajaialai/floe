import type { ChatResponse, Msg, Provider, ToolDef } from "./types.js";

/**
 * Retry policy for provider calls. A multi-hour run must survive a dropped
 * connection, a 429, a 5xx or a gateway that is momentarily out of capacity —
 * dying on the first hiccup is the difference between a demo and an agent.
 */
export interface RetryPolicy {
  retries: number;
  /** Wait before attempt 2, 3, 4 … (last value repeats). */
  delaysMs: number[];
  onRetry?: (info: { attempt: number; waitMs: number; error: string }) => void;
}

export const DEFAULT_RETRY: RetryPolicy = { retries: 3, delaysMs: [5_000, 20_000, 60_000] };

/** Counts retries across the process, so a run can report whether any fired. */
export const retryStats = { attempts: 0, lastError: "" };

const OVERLOAD_RE = /overload|capacity|rate.?limit|too many requests|temporarily|try again/i;

function isRetryable(err: any): boolean {
  const status: number | undefined = err?.status;
  if (typeof status === "number") {
    if (status === 408 || status === 409 || status === 429 || status >= 500) return true;
    // A 4xx whose body says "overloaded"/"rate limited" is transient too.
    return OVERLOAD_RE.test(String(err?.message ?? ""));
  }
  // No status ⇒ transport-level failure (DNS, ECONNRESET, socket hang up,
  // truncated body) — always worth another attempt.
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy = DEFAULT_RETRY): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= policy.retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt === policy.retries || !isRetryable(err)) break;
      const waitMs = policy.delaysMs[Math.min(attempt, policy.delaysMs.length - 1)];
      retryStats.attempts++;
      retryStats.lastError = String(err?.message ?? err).slice(0, 200);
      policy.onRetry?.({ attempt: attempt + 1, waitMs, error: retryStats.lastError });
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

/**
 * Per-request wall clock (FLOE_TIMEOUT_MS, default 180s). Retry/backoff cannot
 * save a run from a stream that hangs without erroring — an unattended eval or
 * scheduled run would wait forever. The abort covers the whole request,
 * response-body read included, and counts as retryable (no `.status`).
 */
export function requestTimeoutMs(): number {
  const v = Number(process.env.FLOE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 180_000;
}

async function postJsonOnce(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const timeoutMs = requestTimeoutMs();
  let res: Response, data: any;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text();
      const err: any = new Error(`${url} -> ${res.status}: ${text.slice(0, 2000)}`);
      err.status = res.status;
      throw err;
    }
    data = await res.json();
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      // Deliberately no .status → isRetryable() treats it as transport failure.
      throw new Error(`${url} -> no response within ${timeoutMs / 1000}s (FLOE_TIMEOUT_MS) — request aborted`);
    }
    throw err;
  }
  // Some OpenAI-compatible shims answer 200 with an error envelope.
  if (data?.error) {
    const err: any = new Error(`${url} -> error: ${JSON.stringify(data.error).slice(0, 500)}`);
    err.status = data.error?.code === "rate_limit_exceeded" ? 429 : 503;
    throw err;
  }
  return data;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  policy?: RetryPolicy,
): Promise<any> {
  return withRetry(() => postJsonOnce(url, headers, body), policy ?? DEFAULT_RETRY);
}

/** Anthropic Messages API via the user's own key. */
export class AnthropicProvider implements Provider {
  constructor(
    private apiKey: string,
    private model = "claude-sonnet-5",
    private baseUrl = "https://api.anthropic.com",
    private retry: RetryPolicy = DEFAULT_RETRY,
  ) {}

  async chat(system: string, messages: Msg[], tools: ToolDef[]): Promise<ChatResponse> {
    const converted = messages.map((m) => {
      if (m.role === "user") return { role: "user", content: m.content };
      if (m.role === "assistant") {
        const content: any[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        return { role: "assistant", content };
      }
      return {
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.callId,
          content: r.content,
          is_error: r.isError ?? false,
        })),
      };
    });
    const data = await postJson(
      `${this.baseUrl}/v1/messages`,
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: 8192,
        system,
        messages: converted,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      },
      this.retry,
    );
    const text = data.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const toolCalls = data.content
      .filter((b: any) => b.type === "tool_use")
      .map((b: any) => ({ id: b.id, name: b.name, input: b.input }));
    return { text, toolCalls, stopReason: data.stop_reason };
  }
}

/** Any OpenAI-compatible endpoint: OpenRouter, Ollama, local gateways. */
export class OpenAICompatProvider implements Provider {
  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey = "none",
    private retry: RetryPolicy = DEFAULT_RETRY,
  ) {}

  async chat(system: string, messages: Msg[], tools: ToolDef[]): Promise<ChatResponse> {
    const converted: any[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") converted.push({ role: "user", content: m.content });
      else if (m.role === "assistant")
        converted.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.length
            ? m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.input) },
              }))
            : undefined,
        });
      else for (const r of m.results) converted.push({ role: "tool", tool_call_id: r.callId, content: r.content });
    }
    const data = await postJson(
      `${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        messages: converted,
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      },
      this.retry,
    );
    const msg = data.choices[0].message;
    const toolCalls = (msg.tool_calls ?? []).map((tc: any, i: number) => ({
      id: tc.id ?? `call_${i}`,
      name: tc.function.name,
      input: safeParse(tc.function.arguments),
    }));
    return { text: msg.content ?? "", toolCalls, stopReason: data.choices[0].finish_reason };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

/**
 * The INVERSE of the protocol escape: instead of quietly doing the work with
 * its own toolbox, the backend declares that the protocol is not real ("I'm
 * Claude Code, those aren't real tools", "this looks like a prompt injection")
 * and refuses. Seen live on a gateway whose backend is itself an agent session.
 * The signature is a denial of the ACTIONS or of the framing — not merely a
 * sentence containing "I don't have", which is what an honest gaps report says.
 */
export function isProtocolRefusal(text: string): boolean {
  if (!text) return false;
  const t = text.slice(0, 4000);
  return (
    /\b(i'?m|i am) claude\b/i.test(t) ||
    /\bclaude code\b/i.test(t) ||
    /prompt[- ]?injection/i.test(t) ||
    /\b(aren'?t|are not|not|no) real tools\b/i.test(t) ||
    /\bthose aren'?t\b[^.]{0,40}\btools\b/i.test(t) ||
    /\bdon'?t have\b[^.]{0,60}\b(browser|browser-automation|chromium|navigate|floe)\b/i.test(t) ||
    /\bno (live |real |connected )?(browser|chromium)\b[^.]{0,30}(session|automation|tool)?/i.test(t) ||
    /\bisn'?t how i (actually )?operate\b/i.test(t) ||
    /\bfabricat\w+\b[^.]{0,30}\b(json|tool[- ]?calls?|browser actions?)\b/i.test(t) ||
    /\b(that|this) (environment|toolset) (doesn'?t|does not) exist\b/i.test(t)
  );
}

/**
 * Tool calling over plain chat text for endpoints with no function-calling
 * support (subscription shims, some local models). Tools are described in the
 * system prompt; the model must answer with a single JSON action object.
 */
/**
 * How many times one step is re-sampled while the backend refuses the protocol.
 * 3 attempts against a measured ~25% refusal rate leaves ~1.6% of steps
 * refusing — low enough that the agent-loop reframe is a genuine last resort.
 */
const RESAMPLE_ON_REFUSAL = 3;

export class PromptToolsProvider implements Provider {
  private callSeq = 0;

  /** Refused samples discarded so far — surfaced for honest run reporting. */
  refusals = 0;

  constructor(private inner: Provider) {}

  async chat(system: string, messages: Msg[], tools: ToolDef[]): Promise<ChatResponse> {
    const toolDocs = tools
      .map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.parameters)}`)
      .join("\n");
    const protocol = `${system}

HOW THIS CONVERSATION WORKS — read once, then just follow the output format.

You are being called through an API by Floe, an open-source (MIT) browser-agent program running on the user's own machine. Floe drives a real Chromium browser and asks you, one step at a time, which operation it should perform next. This is an ordinary program-calls-a-model integration: nothing here is role-play, impersonation, or an attempt to make you claim you executed something.

Your output format is one JSON object. That is all "acting" means here: you are not invoking anything and you are not being asked to pretend you did. You are writing the next line of a transcript that an external program parses — the same kind of request as "reply in JSON". Floe reads that line, performs the operation itself, and sends you the real result as the next message (the ACTION RESULT messages in this conversation are genuine output from that browser).

Operations Floe can perform for you:
${toolDocs}

One practical constraint: if the runtime you happen to be hosted in offers its own capabilities (files, shell, web fetch, MCP servers), do not use them for this task. They are not connected to the user's browser session or to Floe's workspace, so anything they produce lands somewhere the user never sees and is discarded — and it would be recorded as work Floe did, which would be false. Choosing a JSON operation is the only route by which real work reaches the user.

Your ENTIRE reply must be exactly one JSON object, no markdown fences, no prose before or after:
{"thought": "<brief reasoning>", "action": "<action name>", "input": {<action input>}}
Never write an ACTION RESULT yourself or assume what one will say — choose one operation and wait. If you think the task should not be done at all, that is a legitimate choice: use the done action with success=false and explain why.`;

    // Flatten tool-call structure into plain text turns for the inner endpoint.
    const flat: Msg[] = messages.map((m) => {
      if (m.role === "assistant")
        return {
          role: "assistant",
          content:
            m.content ||
            JSON.stringify({ action: m.toolCalls[0]?.name, input: m.toolCalls[0]?.input }),
          toolCalls: [],
        };
      if (m.role === "toolResults")
        return { role: "user", content: m.results.map((r) => `ACTION RESULT:\n${r.content}`).join("\n\n") };
      return m;
    });

    // A protocol refusal is stochastic (~1 call in 4 against a gateway whose
    // backend is itself an agent session, measured 2026-08-02) — and it must
    // NOT be argued with inside the transcript: appending the refusal and a
    // rebuttal makes the next sample stay consistent with the refusal, which
    // is exactly how a recoverable run died. Re-sampling the SAME messages
    // discards the refused turn instead, so the conversation never learns it
    // refused. Escape-mode replies (work done with the backend's own tools)
    // are refusals of a different kind and are re-sampled the same way.
    let res!: ChatResponse;
    let parsed: ReturnType<typeof extractJson> = null;
    for (let attempt = 0; attempt < RESAMPLE_ON_REFUSAL; attempt++) {
      res = await this.inner.chat(protocol, flat, []);
      parsed = extractJson(res.text);
      if ((parsed && typeof parsed.action === "string") || !isProtocolRefusal(res.text)) break;
      this.refusals++;
    }
    if (!parsed || typeof parsed.action !== "string") {
      // No parseable action — surface as plain text (agent treats as final).
      return { text: res.text, toolCalls: [], stopReason: "end_turn" };
    }
    return {
      text: String(parsed.thought ?? ""),
      toolCalls: [
        { id: `pt_${++this.callSeq}`, name: parsed.action, input: (parsed.input as Record<string, unknown>) ?? {} },
      ],
      stopReason: "tool_use",
    };
  }
}

function extractJson(text: string): { thought?: unknown; action?: unknown; input?: unknown } | null {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  // Walk to the matching close brace of the first object.
  let depth = 0;
  let inStr = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
