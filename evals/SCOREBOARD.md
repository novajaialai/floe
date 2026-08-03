# Floe eval scoreboard

Run `2026-08-03T01-27-02` — tier **full** — **1/1 passed (100%)** — 2 min total.
Previous run: **17/18** (full, `2026-08-03T00-47-36.jsonl`)

Scores are honest: failing cases stay red until the engine earns the pass. Do not tune cases to green.

| | case | tier | steps | wall | retries | checks | note |
|---|---|---|---|---|---|---|---|
| ✅ | hn-jobs-sheet | full | 5 | 143s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ csv_unique<br>✓ content<br>✓ row_accounting<br>✓ integrity_mtime |  |

Raw per-run data: `evals/results/2026-08-03T01-27-02.jsonl` (judged cases carry the judge's JSON verdict verbatim).
Control-protocol coverage (pause/resume/graceful stop) lives in `scripts/smoke-events.mjs`, not here — no duplication.
