# Floe eval scoreboard

Run `2026-08-02T21-22-41` — tier **full** — **12/12 passed (100%)** — 13 min total.
Previous run: **12/12 as recorded, 11/12 after audit** (full, `2026-08-02T21-09-50.jsonl` — its honest-gaps "pass" had zero tool calls: the gateway backend escaped the prompt-tool protocol and did the task with its own toolbox. See the amendment line in that results file; the escape is what the `evidence` check now catches automatically.)

Scores are honest: failing cases stay red until the engine earns the pass. Do not tune cases to green.

| | case | tier | steps | wall | retries | checks | note |
|---|---|---|---|---|---|---|---|
| ✅ | quotes-page1 | quick | 4 | 62s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ content |  |
| ✅ | hn-front-structural | quick | 4 | 39s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_sequence |  |
| ✅ | wiki-fact | quick | 5 | 45s | 0 | ✓ evidence<br>✓ content |  |
| ✅ | recovery-dead-url | quick | 5 | 38s | 0 | ✓ evidence<br>✓ content<br>✓ content<br>✓ content<br>✓ content |  |
| ✅ | quotes-all-pages | full | 4 | 49s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_unique |  |
| ✅ | books-three-pages | full | 4 | 38s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ content |  |
| ✅ | books-travel-category | full | 5 | 43s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns |  |
| ✅ | quotes-infinite-scroll | full | 4 | 51s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_unique |  |
| ✅ | parallel-fanout | full | 5 | 93s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_rows<br>✓ csv_rows<br>✓ csv_columns |  |
| ✅ | template-directory | full | 4 | 50s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns |  |
| ✅ | honest-gaps | full | 15 | 201s | 0 | ✓ evidence<br>✓ file<br>✓ content<br>✓ judge (judge 8/10) |  |
| ✅ | research-cited | full | 4 | 35s | 0 | ✓ evidence<br>✓ content<br>✓ content<br>✓ content<br>✓ judge (judge 9/10) |  |

Raw per-run data: `evals/results/2026-08-02T21-22-41.jsonl` (judged cases carry the judge's JSON verdict verbatim).
Control-protocol coverage (pause/resume/graceful stop) lives in `scripts/smoke-events.mjs`, not here — no duplication.
