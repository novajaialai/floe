# Floe eval scoreboard

Run `2026-08-02T23-50-08` — tier **full** — **16/18 passed (89%)** — 37 min total.
Previous run: **1/1** (full, `2026-08-02T23-45-12.jsonl`)

Scores are honest: failing cases stay red until the engine earns the pass. Do not tune cases to green.

Red-case diagnosis (session 9, v0.9): all four session-8 reds are FIXED as diagnosed (hand-transcription steering, fan-out output compliance, protocol refusal re-sampling) — this run's two reds are new, subtler shades. `hn-jobs-sheet`: 30/30 rows receipted and accountable (the fix held) but the agent stopped after one page instead of following "More" — honest incompleteness, likely HN-flakiness-adjacent. `market-map-browser-tools`: real 5-agent research, no fabricated facts, but `citations_visited` caught 3 plausible URLs (LICENSE files, pptr.dev/faq) cited without ever being opened — exactly the ungrounded-citation mode the check exists for; the 886s wall includes one provider-timeout retry working as designed.

| | case | tier | steps | wall | retries | checks | note |
|---|---|---|---|---|---|---|---|
| ✅ | quotes-page1 | quick | 4 | 29s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ content<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | hn-front-structural | quick | 4 | 42s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_sequence<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | wiki-fact | quick | 5 | 44s | 0 | ✓ evidence<br>✓ content<br>✓ integrity_mtime |  |
| ✅ | recovery-dead-url | quick | 6 | 39s | 0 | ✓ evidence<br>✓ content<br>✓ content<br>✓ content<br>✓ content<br>✓ integrity_mtime |  |
| ✅ | quotes-all-pages | full | 5 | 93s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_unique<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | books-three-pages | full | 8 | 87s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ content<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | books-travel-category | full | 5 | 50s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | quotes-infinite-scroll | full | 4 | 63s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_unique<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | parallel-fanout | full | 5 | 127s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_rows<br>✓ csv_rows<br>✓ csv_columns<br>✓ integrity_mtime |  |
| ✅ | template-directory | full | 4 | 47s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | honest-gaps | full | 9 | 157s | 0 | ✓ evidence<br>✓ file<br>✓ content<br>✓ judge (judge 8/10)<br>✓ integrity_mtime |  |
| ✅ | research-cited | full | 4 | 47s | 0 | ✓ evidence<br>✓ content<br>✓ content<br>✓ content<br>✓ judge (judge 9/10)<br>✓ citations_visited<br>✓ integrity_mtime |  |
| ❌ | hn-jobs-sheet | full | 12 | 165s | 0 | ✓ evidence<br>✗ csv_rows<br>✓ csv_columns<br>✓ csv_unique<br>✓ content<br>✓ row_accounting<br>✓ integrity_mtime | jobs.csv: 30 data rows (want 55..60) |
| ✅ | arxiv-listing | full | 4 | 45s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ csv_unique<br>✓ content<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | gov-states-directory | full | 4 | 84s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ csv_unique<br>✓ content<br>✓ content<br>✓ content<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | nav-trace-elements | full | 11 | 122s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ content<br>✓ content<br>✓ trace_nav<br>✓ integrity_mtime |  |
| ✅ | openlibrary-search-book | full | 8 | 87s | 0 | ✓ evidence<br>✓ file<br>✓ content<br>✓ content<br>✓ content<br>✓ citations_visited<br>✓ integrity_mtime |  |
| ❌ | market-map-browser-tools | full | 6 | 886s | 1 | ✓ evidence<br>✓ file<br>✓ content<br>✓ content<br>✓ content<br>✓ content<br>✓ content<br>✗ citations_visited<br>✗ judge (judge 5/10)<br>✓ integrity_mtime | market-map.md: 3/7 cited URL(s) never opened by the browser: https://github.com/microsoft/playwright/blob/main/LICENSE https://github.com/puppeteer/puppeteer/blob/main/LICENSE https://pptr.dev/faq; No |

Raw per-run data: `evals/results/2026-08-02T23-50-08.jsonl` (judged cases carry the judge's JSON verdict verbatim).
Control-protocol coverage (pause/resume/graceful stop) lives in `scripts/smoke-events.mjs`, not here — no duplication.
