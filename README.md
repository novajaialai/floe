# Floe

**An open-source (MIT) browser agent.** Type a task; Floe drives a real Chromium browser — logged in as you — to complete it: navigating, clicking, typing, extracting data, and saving results. Bring your own model: any Anthropic key, any OpenAI-compatible endpoint (OpenRouter, Ollama, local gateways), with or without native function-calling.

Floe is an open replication of the capability behind commercial AI browsers (Polar, etc.): long-horizon browser automation on your own accounts, with no credits, no billing, and no cloud dependency.

## Status: v0.3 engine (early)

**What's new in v0.3** — Floe stopped being one agent in one tab. Every agent now owns its own `BrowserSession` (its own window/tabs), and an orchestrator can `spawn_agents` to run N executors **in parallel** — each with its own task, its own window, and a cheap model lane — coordinating through the shared task workspace. Live over a local gateway: three executors researched lite.cnn.com, text.npr.org and news.ycombinator.com **concurrently** (overlapping timestamps in one log), wrote three CSVs, and the orchestrator merged them into a briefing. Long runs got serious too: provider calls retry with exponential backoff (5s/20s/60s on network errors, 429, 5xx and overload envelopes), and `--max-minutes` ends a run by *telling the agent to wrap up and save*, never by killing it mid-write.

**v0.2** — extraction stopped being the model's job. `extract_table` finds the page's dominant repeated structure (a regular table, or listing cards / feed items / search results, segmented by repeated markers) with pure DOM heuristics, and `paginate_extract` walks pagination writing deduped rows straight to a CSV in code. On the Hacker News 3-page benchmark that took the run from 15 steps of hand-transcribed rows to **4 steps, 90 rows, zero duplicates**. Element ids are also sticky now, so an id stays glued to its element across snapshots instead of being reassigned from 0 (the stale-click bug in v0.1).

Working today:
- Persistent Chromium profile (log in once; sessions persist across tasks)
- **Parallel subagents**: `spawn_agents` launches 1–N executors, each owning a browser session and running the full agent loop; results come back as done-summaries plus files in the shared workspace (each executor is namespaced to its own `<name>-*` files)
- **Multi-model lanes**: `FLOE_MODEL` plans, `FLOE_EXECUTOR_MODEL` (cheap lane, e.g. haiku) does the page work
- **Long-run resilience**: provider retry with exponential backoff + a soft wall-clock budget (`--max-minutes`) that asks the agent to wrap up and save instead of killing it
- Agent loop with indexed-element page snapshots (a11y-style: numbered interactive elements + page text), with **stable element ids** across re-renders
- Structured extraction with no model call: `extract_table` (tables + repeated cards), `paginate_extract` (multi-page scrape → CSV, code-side dedupe on a key column, auto "next"/"more"/infinite-scroll advance)
- Tools: navigate, read_page, click, type_text, press_key, scroll, tabs (scoped to the agent's own session), extract_table, paginate_extract, workspace files, spawn_agents (orchestrator only), done
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

# Parallel research with a cheap executor lane and a time budget
export FLOE_EXECUTOR_MODEL=haiku
node packages/cli/dist/main.js run "Spawn agents for lite.cnn.com, text.npr.org and news.ycombinator.com in parallel; \
  each saves its top 10 headlines to its own CSV; then merge them into briefing.md" --parallel 3 --max-minutes 30
```

Model-free check of the browser/extraction layer (no API calls, launches headless Chrome):

```bash
node scripts/smoke-extract.mjs    # sticky ids, structure detector, pagination
node scripts/smoke-parallel.mjs   # 3 concurrent sessions: isolation + id stability
node scripts/smoke-retry.mjs      # provider retry/backoff against a fake flaky endpoint
```

Live-verified over a local OpenAI-compatible gateway (sonnet orchestrating, haiku executors):
- **Fan-out**: 3 executors on lite.cnn.com / text.npr.org / news.ycombinator.com started within the same second and ran concurrently (58s, 62s, 86s, overlapping in the log); 3 CSVs + a merged `briefing.md`, whole task 2.5 min / 6 orchestrator steps.
- **Sustained run**: a 10-phase, 22-executor scrape ran **20.7 minutes**, hit its `--max-minutes 20` budget mid-synthesis, was told to wrap up, wrote its report and exited cleanly (exit 0) with 20 CSVs (~1.4k rows), `notes.md` and `report.md` intact.
- Executor summaries are checked against the disk: in that run two executors claimed success having written nothing, the `[verified]` receipt caught both, and the orchestrator re-spawned them.

Extraction verified against Hacker News (3 pages → 90 deduped rows), a Wikipedia sortable table, quotes.toscrape.com, books.toscrape.com and lite.cnn.com. Logged-in templates (LinkedIn-style) are **untested** — the default profile has no accounts in it.

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
- **Multi-model by design**: the orchestrator plans on the frontier lane; executors click on the cheap lane (`FLOE_EXECUTOR_MODEL`).
- **Sessions, not a global "active tab".** `FloeBrowser` is a context + session pool; a `BrowserSession` owns its page(s) and all page actions. That single seam is what makes parallelism possible, and it makes cross-agent bleed impossible by construction.
- **Fan-out blocks, coordination is files.** `spawn_agents` returns when every executor is finished; executors report through their done summary plus the files they wrote into the shared workspace. Simple, restartable, and inspectable after the fact.
- **Time limits are soft.** Hitting `--max-minutes` injects a "time is up, save and wrap up" turn (with a few grace steps) rather than killing a run mid-write.

## Roadmap

1. ✅ Engine skeleton: end-to-end tasks over CDP
2. ✅ Reliability tools: generic structured extractor, list paginator with code-side dedupe, stable element ids (Google Sheets writer still to come)
3. ✅ Orchestrator/executor split + parallel windows, provider retry/backoff, soft time budget
4. Scheduler: saved workflows on cron ("morning briefing at 7am")
5. Desktop app (Tauri): command bar, live view, pause/take-over
6. Template library + site
7. Eval harness (WebVoyager subset + real-work tasks)

## License

MIT. Chromium is BSD-3. No code from AGPL projects.
