# Floe

**An open-source (MIT) browser agent.** Type a task; Floe drives a real Chromium browser — logged in as you — to complete it: navigating, clicking, typing, extracting data, and saving results. Bring your own model: any Anthropic key, any OpenAI-compatible endpoint (OpenRouter, Ollama, local gateways), with or without native function-calling.

Floe is an open replication of the capability behind commercial AI browsers (Polar, etc.): long-horizon browser automation on your own accounts, with no credits, no billing, and no cloud dependency.

## Status: v0.1 engine (early)

Working today:
- Persistent Chromium profile (log in once; sessions persist across tasks)
- Agent loop with indexed-element page snapshots (a11y-style: numbered interactive elements + page text)
- Tools: navigate, read_page, click, type_text, press_key, scroll, tabs, workspace files, done
- Per-task workspace (notes, incremental CSVs) so long tasks survive interruptions
- Providers: Anthropic Messages API, any OpenAI-compatible endpoint, and a **prompt-protocol tool mode** (`FLOE_TOOL_MODE=prompt`) that gets tool-calling out of endpoints with no function-calling support
- Context trimming of stale snapshots so multi-hour tasks don't blow the window

## Quickstart

```bash
npm install && npm run build

# With an Anthropic key
export ANTHROPIC_API_KEY=sk-ant-...
node packages/cli/dist/main.js run "Go to news.ycombinator.com and save the top 5 stories to results.csv"

# With any OpenAI-compatible endpoint (Ollama, OpenRouter, local gateway)
export FLOE_PROVIDER=openai FLOE_BASE_URL=http://127.0.0.1:11434 FLOE_MODEL=qwen3:8b
node packages/cli/dist/main.js run "..." 

# Endpoint has no function-calling? Use the prompt protocol:
export FLOE_TOOL_MODE=prompt
```

First run launches Chrome with a fresh profile at `~/.floe/profile` — log into the sites you want Floe to work in, then hand it tasks. Results land in `~/.floe/workspaces/<task-id>/`.

## Architecture

```
packages/engine   agent loop, browser layer (playwright-core/CDP), tools, providers, workspace
packages/cli      `floe run "<task>"`
templates/        task templates (YAML) — prompt library, generates the gallery
```

Design notes:
- **Engine-first, shell-later.** The agent engine is 90% of the value; it runs against stock Chrome/Chromium over CDP. A dedicated browser shell (side panel UI, in-tab handoff) comes after the engine is reliable, as a thin layer — not a Chromium fork on day one.
- **Durable state lives in the task workspace**, not the model context: incremental CSV appends, notes.md progress. Crash → resume.
- **Multi-model by design**: the orchestrator/executor split (frontier model plans, small model clicks) is the next milestone.

## Roadmap

1. ✅ Engine skeleton: end-to-end tasks over CDP
2. Site-hardened tools: Google Sheets writer, list paginator with dedupe, generic extractor; stable element ids across snapshots
3. Orchestrator/executor split + parallel windows
4. Scheduler: saved workflows on cron ("morning briefing at 7am")
5. Desktop app (Tauri): command bar, live view, pause/take-over
6. Template library + site
7. Eval harness (WebVoyager subset + real-work tasks)

## License

MIT. Chromium is BSD-3. No code from AGPL projects.
