#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AnthropicProvider,
  OpenAICompatProvider,
  PromptToolsProvider,
  FloeBrowser,
  Workspace,
  createSpawner,
  runAgent,
  retryStats,
  DEFAULT_RETRY,
  type AgentEvent,
  type Provider,
  type RetryPolicy,
} from "@floe/engine";

function usage(): never {
  console.log(`floe — open-source browser agent (MIT)

Usage:
  floe run "<task>" [options]

Options:
  --max-steps <n>       Step limit for the main agent (default 60)
  --max-minutes <n>     Wall-clock budget; the agent is asked to wrap up (no hard kill)
  --parallel <n>        Max executor subagents running at once (default 3)
  --headless            Run the browser headless
  --profile <dir>       Browser profile dir (default ~/.floe/profile)

Provider config (env):
  FLOE_PROVIDER         anthropic | openai (default: anthropic if ANTHROPIC_API_KEY set, else openai)
  ANTHROPIC_API_KEY     Anthropic key (BYO)
  FLOE_MODEL            Planner/orchestrator model
  FLOE_EXECUTOR_MODEL   Cheap lane for spawned executors (default: same as FLOE_MODEL)
  FLOE_TOOL_MODE        prompt = tool calls over plain text (endpoints without function calling)
  FLOE_BASE_URL         OpenAI-compatible base URL (e.g. http://127.0.0.1:8088)
  FLOE_API_KEY          Key for the OpenAI-compatible endpoint`);
  process.exit(1);
}

const stamp = () => new Date().toISOString().slice(11, 19);

const retry: RetryPolicy = {
  ...DEFAULT_RETRY,
  onRetry: ({ attempt, waitMs, error }) =>
    console.log(`${stamp()} ⟳ provider retry ${attempt}/${DEFAULT_RETRY.retries} in ${waitMs / 1000}s — ${error}`),
};

/** Build a provider for a model id; undefined = the configured default. */
function makeProvider(model?: string): Provider {
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

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "run" || !args[1]) usage();
  const task = args[1];
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const floeHome = join(homedir(), ".floe");
  const taskId = new Date().toISOString().replace(/[:.]/g, "-");
  const maxMinutes = Number(flag("--max-minutes") ?? 0);
  const deadline = maxMinutes > 0 ? Date.now() + maxMinutes * 60_000 : undefined;

  const browser = new FloeBrowser();
  const session = await browser.launch({
    profileDir: flag("--profile") ?? join(floeHome, "profile"),
    headless: args.includes("--headless"),
  });
  const workspace = new Workspace(join(floeHome, "workspaces"), taskId);
  console.log(`▸ workspace: ${workspace.dir}`);
  if (deadline)
    console.log(`▸ time budget: ${maxMinutes} min (wrap-up requested at ${new Date(deadline).toLocaleTimeString()})`);

  // Timestamped + agent-tagged so parallel executors are legible in one log.
  const onEvent = (e: AgentEvent) => {
    const tag = { thought: "🧠", tool_call: "▸", tool_result: "·", done: "✔", error: "✖" }[e.type] ?? "·";
    const detail = e.type === "tool_result" ? e.detail.split("\n")[0] : e.detail;
    console.log(`${stamp()} ${tag} [${e.agent ?? "main"}:${e.step}] ${detail.slice(0, 400)}`);
  };

  const startedAt = Date.now();
  try {
    const spawn = createSpawner({
      browser,
      workspace,
      providerFor: (model) => makeProvider(model ?? process.env.FLOE_EXECUTOR_MODEL),
      executorModel: process.env.FLOE_EXECUTOR_MODEL ?? process.env.FLOE_MODEL,
      maxParallel: Number(flag("--parallel") ?? 3),
      onEvent,
      deadline,
    });
    const result = await runAgent(makeProvider(), { session, workspace, spawn }, task, {
      maxSteps: Number(flag("--max-steps") ?? 60),
      deadline,
      onEvent,
    });
    const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
    console.log(`\n${result.success ? "SUCCESS" : "INCOMPLETE"} after ${result.steps} steps, ${minutes} min`);
    if (retryStats.attempts) console.log(`Provider retries fired: ${retryStats.attempts} (last: ${retryStats.lastError})`);
    console.log(result.summary);
    console.log(`Results in: ${workspace.dir}`);
    process.exitCode = result.success ? 0 : 2;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
