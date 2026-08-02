import { join } from "node:path";
import {
  AnthropicProvider,
  DEFAULT_RETRY,
  FloeBrowser,
  OpenAICompatProvider,
  PromptToolsProvider,
  Workspace,
  createSpawner,
  floeHome,
  retryStats,
  runAgent,
  type AgentEvent,
  type Provider,
  type RetryPolicy,
} from "@floe/engine";

/** Local wall-clock time: cron slots are local, so logs must be too. */
export const stamp = () => new Date().toTimeString().slice(0, 8);

const retry: RetryPolicy = {
  ...DEFAULT_RETRY,
  onRetry: ({ attempt, waitMs, error }) =>
    console.log(`${stamp()} ⟳ provider retry ${attempt}/${DEFAULT_RETRY.retries} in ${waitMs / 1000}s — ${error}`),
};

/** Build a provider for a model id; undefined = the configured default. */
export function makeProvider(model?: string): Provider {
  const kind = process.env.FLOE_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai");
  if (kind === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      console.error("ANTHROPIC_API_KEY not set");
      process.exit(1);
    }
    return new AnthropicProvider(key, model ?? process.env.FLOE_MODEL ?? "claude-sonnet-5", undefined, retry);
  }
  const base = process.env.FLOE_BASE_URL;
  if (!base) {
    console.error("FLOE_BASE_URL not set for openai-compatible provider");
    process.exit(1);
  }
  const p = new OpenAICompatProvider(
    base,
    model ?? process.env.FLOE_MODEL ?? "gpt-5",
    process.env.FLOE_API_KEY ?? "none",
    retry,
  );
  // prompt mode: tool calling over plain text, for endpoints without function-calling
  return process.env.FLOE_TOOL_MODE === "prompt" ? new PromptToolsProvider(p) : p;
}

export interface TaskOptions {
  task: string;
  /** Parent dir of the run workspace (default ~/.floe/workspaces). */
  workspaceRoot?: string;
  /** Run-workspace dir name (default: a UTC timestamp). */
  taskId?: string;
  maxSteps?: number;
  maxMinutes?: number;
  parallel?: number;
  headless?: boolean;
  profileDir?: string;
}

export interface TaskOutcome {
  success: boolean;
  steps: number;
  summary: string;
  workspaceDir: string;
  start: string;
  end: string;
}

/** One agent run, end to end. Shared by `floe run`, `workflow run` and the scheduler. */
export async function runTask(opts: TaskOptions): Promise<TaskOutcome> {
  const home = floeHome();
  const taskId = opts.taskId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const maxMinutes = opts.maxMinutes ?? 0;
  const deadline = maxMinutes > 0 ? Date.now() + maxMinutes * 60_000 : undefined;

  const browser = new FloeBrowser();
  const session = await browser.launch({
    profileDir: opts.profileDir ?? join(home, "profile"),
    headless: opts.headless ?? false,
  });
  const workspace = new Workspace(opts.workspaceRoot ?? join(home, "workspaces"), taskId);
  console.log(`▸ workspace: ${workspace.dir}`);
  if (deadline)
    console.log(`▸ time budget: ${maxMinutes} min (wrap-up requested at ${new Date(deadline).toLocaleTimeString()})`);

  // Timestamped + agent-tagged so parallel executors are legible in one log.
  const onEvent = (e: AgentEvent) => {
    const tag = { thought: "🧠", tool_call: "▸", tool_result: "·", done: "✔", error: "✖" }[e.type] ?? "·";
    const detail = e.type === "tool_result" ? e.detail.split("\n")[0] : e.detail;
    console.log(`${stamp()} ${tag} [${e.agent ?? "main"}:${e.step}] ${detail.slice(0, 400)}`);
  };

  const start = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const spawn = createSpawner({
      browser,
      workspace,
      providerFor: (model) => makeProvider(model ?? process.env.FLOE_EXECUTOR_MODEL),
      executorModel: process.env.FLOE_EXECUTOR_MODEL ?? process.env.FLOE_MODEL,
      maxParallel: opts.parallel ?? 3,
      onEvent,
      deadline,
    });
    const result = await runAgent(makeProvider(), { session, workspace, spawn }, opts.task, {
      maxSteps: opts.maxSteps ?? 60,
      deadline,
      onEvent,
    });
    const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
    console.log(`\n${result.success ? "SUCCESS" : "INCOMPLETE"} after ${result.steps} steps, ${minutes} min`);
    if (retryStats.attempts) console.log(`Provider retries fired: ${retryStats.attempts} (last: ${retryStats.lastError})`);
    console.log(result.summary);
    console.log(`Results in: ${workspace.dir}`);
    return {
      success: result.success,
      steps: result.steps,
      summary: result.summary,
      workspaceDir: workspace.dir,
      start,
      end: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
}
