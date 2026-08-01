# Floe

**An open-source (MIT) browser agent.** Type a task; Floe drives a real Chromium browser — logged in as you — to complete it: navigating, clicking, typing, extracting data, and saving results. Bring your own model: any Anthropic key, any OpenAI-compatible endpoint (OpenRouter, Ollama, local gateways), with or without native function-calling.

Floe is an open replication of the capability behind commercial AI browsers (Polar, etc.): long-horizon browser automation on your own accounts, with no credits, no billing, and no cloud dependency.

## Status: v0.2 engine (early)

**What's new in v0.2** — extraction stopped being the model's job. `extract_table` finds the page's dominant repeated structure (a regular table, or listing cards / feed items / search results, segmented by repeated markers) with pure DOM heuristics, and `paginate_extract` walks pagination writing deduped rows straight to a CSV in code. On the Hacker News 3-page benchmark that took the run from 15 steps of hand-transcribed rows to **4 steps, 90 rows, zero duplicates**. Element ids are also sticky now, so an id stays glued to its element across snapshots instead of being reassigned from 0 (the stale-click bug in v0.1).

Working today:
- Persistent Chromium profile (log in once; sessions persist across tasks)
- Agent loop with indexed-element page snapshots (a11y-style: numbered interactive elements + page text), with **stable element ids** across re-renders
- Structured extraction with no model call: `extract_table` (tables + repeated cards), `paginate_extract` (multi-page scrape → CSV, code-side dedupe on a key column, auto "next"/"more"/infinite-scroll advance)
- Tools: navigate, read_page, click, type_text, press_key, scroll, tabs, extract_table, paginate_extract, workspace files, done
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

Model-free check of the browser/extraction layer (no API calls, launches headless Chrome):

```bash
node scripts/smoke-extract.mjs
```

Verified against Hacker News (3 pages → 90 deduped rows), a Wikipedia sortable table, quotes.toscrape.com, books.toscrape.com and lite.cnn.com. Logged-in templates (LinkedIn-style) are **untested** — the default profile has no accounts in it.

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
2. ✅ Reliability tools: generic structured extractor, list paginator with code-side dedupe, stable element ids (Google Sheets writer still to come)
3. Orchestrator/executor split + parallel windows
4. Scheduler: saved workflows on cron ("morning briefing at 7am")
5. Desktop app (Tauri): command bar, live view, pause/take-over
6. Template library + site
7. Eval harness (WebVoyager subset + real-work tasks)

## License

MIT. Chromium is BSD-3. No code from AGPL projects.
