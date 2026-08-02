# Floe eval scoreboard

Run `2026-08-02T22-23-34` — tier **full** — **14/18 passed (78%)** — 30 min total.
Previous run: **4/4** (quick, `2026-08-02T21-37-49.jsonl`)

Scores are honest: failing cases stay red until the engine earns the pass. Do not tune cases to green.

Red-case diagnosis (session 8): `hn-jobs-sheet` and `gov-states-directory` fail `row_accounting` — on messier real sites the model hand-transcribes rows via `workspace_write` instead of receipted `paginate_extract` (gov-states even had all 59 rows *correct* — honest but unaccountable); this is the steering gap session 9 targets. `honest-gaps` regressed: the fan-out run scattered output across agents' notes files and never wrote the required `report.md`. `market-map-browser-tools` hit a stochastic protocol REFUSAL (the backend declared "I have no browser tools" — the inverse of v0.7's escape); a single verification rerun passed 10/10 checks with judge 8/10 and all citations trace-grounded (`2026-08-02T22-53-54.jsonl`), so it is a flake, not systematic — the suite number above still counts it red.

| | case | tier | steps | wall | retries | checks | note |
|---|---|---|---|---|---|---|---|
| ✅ | quotes-page1 | quick | 4 | 40s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ content<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | hn-front-structural | quick | 4 | 41s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_sequence<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | wiki-fact | quick | 5 | 51s | 0 | ✓ evidence<br>✓ content<br>✓ integrity_mtime |  |
| ✅ | recovery-dead-url | quick | 5 | 52s | 0 | ✓ evidence<br>✓ content<br>✓ content<br>✓ content<br>✓ content<br>✓ integrity_mtime |  |
| ✅ | quotes-all-pages | full | 4 | 51s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_unique<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | books-three-pages | full | 4 | 32s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ content<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | books-travel-category | full | 5 | 45s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | quotes-infinite-scroll | full | 4 | 55s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_unique<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ✅ | parallel-fanout | full | 6 | 111s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_rows<br>✓ csv_rows<br>✓ csv_columns<br>✓ integrity_mtime |  |
| ✅ | template-directory | full | 4 | 46s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ❌ | honest-gaps | full | 8 | 252s | 0 | ✓ evidence<br>✓ file<br>✓ content<br>✗ judge (judge 2/10)<br>✓ integrity_mtime | No report.md was ever produced — the task explicitly required writing into report.md, but the delivered files are scattered notes/results files (austen2-results.md, monroe-results.md, notes.md) with n |
| ✅ | research-cited | full | 5 | 109s | 0 | ✓ evidence<br>✓ content<br>✓ content<br>✓ content<br>✓ judge (judge 9/10)<br>✓ citations_visited<br>✓ integrity_mtime |  |
| ❌ | hn-jobs-sheet | full | 16 | 275s | 0 | ✓ evidence<br>✗ csv_rows<br>✓ csv_columns<br>✓ csv_unique<br>✓ content<br>✗ row_accounting<br>✓ integrity_mtime | jobs.csv: 30 data rows (want 55..60); jobs.csv: written via workspace_write (hand transcription) — scraped rows must come from paginate_extract, whose receipts make them accountable |
| ✅ | arxiv-listing | full | 4 | 45s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ csv_unique<br>✓ content<br>✓ row_accounting<br>✓ integrity_mtime |  |
| ❌ | gov-states-directory | full | 11 | 268s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ csv_unique<br>✓ content<br>✓ content<br>✓ content<br>✗ row_accounting<br>✓ integrity_mtime | states.csv: written via workspace_write (hand transcription) — scraped rows must come from paginate_extract, whose receipts make them accountable |
| ✅ | nav-trace-elements | full | 12 | 122s | 0 | ✓ evidence<br>✓ csv_rows<br>✓ csv_columns<br>✓ content<br>✓ content<br>✓ trace_nav<br>✓ integrity_mtime |  |
| ✅ | openlibrary-search-book | full | 7 | 76s | 0 | ✓ evidence<br>✓ file<br>✓ content<br>✓ content<br>✓ content<br>✓ citations_visited<br>✓ integrity_mtime |  |
| ❌ | market-map-browser-tools | full | 3 | 63s | 0 | ✗ evidence<br>✗ file<br>✗ content<br>✗ content<br>✗ content<br>✗ content<br>✗ content<br>✗ citations_visited<br>✗ judge (judge 1/10)<br>✓ integrity_mtime | ZERO successful tool calls — the agent never acted; output (if any) is not the agent's work; no file matching /market\|map\|\.md$/; no workspace file matching /market\|map\|\.md$/ (needed for content); no |

Raw per-run data: `evals/results/2026-08-02T22-23-34.jsonl` (judged cases carry the judge's JSON verdict verbatim).
Control-protocol coverage (pause/resume/graceful stop) lives in `scripts/smoke-events.mjs`, not here — no duplication.
