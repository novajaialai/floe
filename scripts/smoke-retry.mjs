#!/usr/bin/env node
// Model-free test of provider resilience: a fake OpenAI-compatible endpoint
// that fails with 503 / 429 / a 200-with-error-envelope before succeeding, and
// a 400 that must NOT be retried. Usage: node scripts/smoke-retry.mjs
import { createServer } from "node:http";
import { OpenAICompatProvider, retryStats } from "../packages/engine/dist/index.js";

let mode = "flaky";
let hits = 0;

const server = createServer((req, res) => {
  hits++;
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (mode === "fatal") return send(400, { error: { message: "bad request" } });
  if (mode === "flaky") {
    if (hits === 1) return send(503, { error: { message: "gateway overloaded" } });
    if (hits === 2) return send(429, { error: { message: "rate limit exceeded" } });
    if (hits === 3) return send(200, { error: { message: "upstream capacity" } }); // 200 + error envelope
    return send(200, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }] });
  }
  send(200, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }] });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const fast = { retries: 3, delaysMs: [10, 20, 30], onRetry: (i) => console.log(`  retry ${i.attempt} in ${i.waitMs}ms — ${i.error.slice(0, 60)}`) };
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "✓" : "✖"} ${msg}`);
  if (!ok) failures++;
};

// 1. survives three different transient failures, then succeeds
const p = new OpenAICompatProvider(base, "test", "k", fast);
const before = retryStats.attempts;
const res = await p.chat("sys", [{ role: "user", content: "hi" }], []);
check(res.text === "OK", `recovered after ${hits - 1} transient failures (got "${res.text}")`);
check(retryStats.attempts - before === 3, `retryStats counted 3 retries (got ${retryStats.attempts - before})`);

// 2. a non-transient 400 fails fast, no retries
mode = "fatal";
hits = 0;
const before2 = retryStats.attempts;
let threw = "";
await new OpenAICompatProvider(base, "test", "k", fast).chat("sys", [{ role: "user", content: "hi" }], []).catch((e) => (threw = e.message));
check(/400/.test(threw), `400 surfaced to the caller (${threw.slice(0, 60)})`);
check(hits === 1 && retryStats.attempts === before2, `400 was not retried (${hits} request, ${retryStats.attempts - before2} retries)`);

// 3. a server that accepts the request but NEVER responds (hung stream) is
//    aborted by FLOE_TIMEOUT_MS, and the timeout is retried like any transport error
const hung = createServer(() => {
  /* accept, hold the socket open, never write a byte */
});
await new Promise((r) => hung.listen(0, "127.0.0.1", r));
const hungBase = `http://127.0.0.1:${hung.address().port}`;
process.env.FLOE_TIMEOUT_MS = "300";
const before4 = retryStats.attempts;
const t0 = Date.now();
let threw4 = "";
await new OpenAICompatProvider(hungBase, "test", "k", { ...fast, retries: 1 })
  .chat("sys", [{ role: "user", content: "hi" }], [])
  .catch((e) => (threw4 = e.message));
const elapsed = Date.now() - t0;
delete process.env.FLOE_TIMEOUT_MS;
hung.closeAllConnections?.();
hung.close();
check(/no response within 0.3s/.test(threw4), `hung stream aborted by FLOE_TIMEOUT_MS (${threw4.slice(0, 80)})`);
check(retryStats.attempts - before4 === 1, `timeout was retried (${retryStats.attempts - before4} retry)`);
check(elapsed < 5_000, `gave up in ${elapsed}ms, not hung forever`);

// 4. connection refused (transport error) is retried, then gives up honestly
server.close();
const before3 = retryStats.attempts;
let threw3 = "";
await new OpenAICompatProvider(base, "test", "k", fast).chat("sys", [{ role: "user", content: "hi" }], []).catch((e) => (threw3 = e.message));
check(retryStats.attempts - before3 === 3, `dead endpoint retried 3× (got ${retryStats.attempts - before3})`);
check(threw3.length > 0, `dead endpoint eventually threw (${threw3.slice(0, 60)})`);

console.log(failures === 0 ? "\nRETRY SMOKE: PASS" : `\nRETRY SMOKE: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
