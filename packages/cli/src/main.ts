#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AnthropicProvider,
  OpenAICompatProvider,
  PromptToolsProvider,
  FloeBrowser,
  Workspace,
  runAgent,
  type Provider,
} from "@floe/engine";

function usage(): never {
  console.log(`floe — open-source browser agent (MIT)

Usage:
  floe run "<task>" [options]

Options:
  --max-steps <n>     Step limit (default 60)
  --headless          Run the browser headless
  --profile <dir>     Browser profile dir (default ~/.floe/profile)

Provider config (env):
  FLOE_PROVIDER       anthropic | openai (default: anthropic if ANTHROPIC_API_KEY set, else openai)
  ANTHROPIC_API_KEY   Anthropic key (BYO)
  FLOE_MODEL          Model id (default claude-sonnet-5 / provider default)
  FLOE_BASE_URL       OpenAI-compatible base URL (e.g. http://127.0.0.1:8088)
  FLOE_API_KEY        Key for the OpenAI-compatible endpoint`);
  process.exit(1);
}

function makeProvider(): Provider {
  const model = process.env.FLOE_MODEL;
  const kind =
    process.env.FLOE_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai");
  if (kind === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      console.error("ANTHROPIC_API_KEY not set");
      process.exit(1);
    }
    return new AnthropicProvider(key, model ?? "claude-sonnet-5");
  }
  const base = process.env.FLOE_BASE_URL;
  if (!base) {
    console.error("FLOE_BASE_URL not set for openai-compatible provider");
    process.exit(1);
  }
  const p = new OpenAICompatProvider(base, model ?? "gpt-5", process.env.FLOE_API_KEY ?? "none");
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

  const browser = new FloeBrowser();
  await browser.launch({
    profileDir: flag("--profile") ?? join(floeHome, "profile"),
    headless: args.includes("--headless"),
  });
  const workspace = new Workspace(join(floeHome, "workspaces"), taskId);
  console.log(`▸ workspace: ${workspace.dir}`);

  try {
    const result = await runAgent(makeProvider(), { browser, workspace }, task, {
      maxSteps: Number(flag("--max-steps") ?? 60),
      onEvent: (e) => {
        const tag = { thought: "🧠", tool_call: "▸", tool_result: "·", done: "✔", error: "✖" }[e.type];
        const detail = e.type === "tool_result" ? e.detail.split("\n")[0] : e.detail;
        console.log(`${tag} [${e.step}] ${detail}`);
      },
    });
    console.log(`\n${result.success ? "SUCCESS" : "INCOMPLETE"} after ${result.steps} steps`);
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
