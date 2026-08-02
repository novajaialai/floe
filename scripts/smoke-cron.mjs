#!/usr/bin/env node
// Model-free test of the cron parser + scheduler due-logic (no browser, no API).
// Usage: node scripts/smoke-cron.mjs
import { parseCron, cronMatches, nextRun, prevRun, dueWorkflows } from "../packages/engine/dist/index.js";

let failures = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "  ✔" : "  ✖"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};
const at = (s) => new Date(s); // local time
const iso = (d) => (d ? d.toLocaleString("sv-SE") : "none"); // "YYYY-MM-DD HH:MM:SS" local

console.log("1. every 5 minutes  */5 * * * *");
{
  const e = parseCron("*/5 * * * *");
  ok(cronMatches(e, at("2026-08-01T10:05:00")), "matches 10:05");
  ok(!cronMatches(e, at("2026-08-01T10:07:00")), "does not match 10:07");
  ok(iso(nextRun(e, at("2026-08-01T10:07:30"))) === "2026-08-01 10:10:00", "next after 10:07:30 = 10:10", iso(nextRun(e, at("2026-08-01T10:07:30"))));
  ok(iso(prevRun(e, at("2026-08-01T10:07:30"))) === "2026-08-01 10:05:00", "prev before 10:07:30 = 10:05", iso(prevRun(e, at("2026-08-01T10:07:30"))));
}

console.log("2. daily 7:00  0 7 * * *");
{
  const e = parseCron("0 7 * * *");
  ok(iso(nextRun(e, at("2026-08-01T07:00:00"))) === "2026-08-02 07:00:00", "next is strictly after (tomorrow)");
  ok(iso(prevRun(e, at("2026-08-01T06:59:00"))) === "2026-07-31 07:00:00", "prev before 06:59 = yesterday 07:00", iso(prevRun(e, at("2026-08-01T06:59:00"))));
  ok(iso(prevRun(e, at("2026-08-01T07:00:00"))) === "2026-08-01 07:00:00", "prev at the slot = the slot itself");
}

console.log("3. weekly  30 6 * * 1  (Mondays 06:30)");
{
  const e = parseCron("30 6 * * 1");
  const n = nextRun(e, at("2026-08-01T12:00:00")); // 2026-08-01 is a Saturday
  ok(iso(n) === "2026-08-03 06:30:00", "next after Sat = Mon 06:30", iso(n));
  ok(parseCron("0 0 * * 7").dayOfWeek.has(0), "dow 7 normalises to Sunday");
}

console.log("4. ranges, lists, steps");
{
  const e = parseCron("0 9-17/4 * * 1-5");
  ok([...e.hour].join(",") === "9,13,17", "9-17/4 = 9,13,17", [...e.hour].join(","));
  ok(!cronMatches(e, at("2026-08-01T09:00:00")), "Saturday excluded by 1-5");
  ok(cronMatches(e, at("2026-08-03T13:00:00")), "Monday 13:00 matches");
  const lists = parseCron("0,15,30 * 1,15 1-3 *");
  ok([...lists.minute].join(",") === "0,15,30", "minute list");
  ok(lists.month.size === 3 && lists.dayOfMonth.size === 2, "month range + dom list");
  // Vixie rule: with both day fields restricted, either may match.
  const both = parseCron("0 0 13 * 5");
  ok(cronMatches(both, at("2026-08-13T00:00:00")), "dom 13 matches (dom OR dow)");
  ok(cronMatches(both, at("2026-08-07T00:00:00")), "Friday matches (dom OR dow)");
}

console.log("5. invalid expressions rejected");
for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "0 0 0 * *", "0 0 * 13 *", "*/0 * * * *", "abc * * * *", "5-1 * * * *", "1/2/3 * * * *"]) {
  let threw = false;
  try { parseCron(bad); } catch { threw = true; }
  ok(threw, `rejected ${JSON.stringify(bad)}`);
}

console.log("6. scheduler due-logic (normal fire, catch-up, exactly-once)");
{
  const wf = { name: "brief", task: "t", schedule: "0 7 * * *", maxSteps: 10, parallel: 1, headless: true, createdAt: "" };
  const now = at("2026-08-01T09:30:00"); // 2.5h after the 07:00 slot
  let state = { lastRun: {} };
  const due1 = dueWorkflows([wf], state, now);
  ok(due1.length === 1 && due1[0].catchUp, "missed slot within 24h runs as catch-up");
  state.lastRun.brief = now.toISOString();
  ok(dueWorkflows([wf], state, now).length === 0, "not due again after being served (exactly once)");
  // Slot older than the catch-up horizon is abandoned, not run stale.
  const weekly = { ...wf, schedule: "0 7 * * 1" };
  ok(dueWorkflows([weekly], { lastRun: {} }, at("2026-08-01T09:30:00")).length === 0, "5-day-old weekly slot abandoned (>24h)");
  // Fires the moment its slot passes.
  const fresh = { ...wf, schedule: "*/5 * * * *" };
  const d = dueWorkflows([fresh], { lastRun: {} }, at("2026-08-01T09:30:20"));
  ok(d.length === 1 && !d[0].catchUp, "slot 20s old fires as a normal run");
  // A slot older than the workflow never happened: saving "0 7 * * *" at noon
  // must not fire it instantly for this morning.
  const justSaved = { ...wf, createdAt: at("2026-08-01T09:00:00").toISOString() };
  ok(dueWorkflows([justSaved], { lastRun: {} }, now).length === 0, "slot predating createdAt is not a miss");
  ok(dueWorkflows([justSaved], { lastRun: {} }, at("2026-08-02T07:30:00")).length === 1, "the first real slot after createdAt does fire");
  ok(dueWorkflows([{ ...wf, schedule: "not a cron" }], { lastRun: {} }, now).length === 0, "broken expression skipped, not thrown");
  ok(dueWorkflows([{ ...wf, schedule: undefined }], { lastRun: {} }, now).length === 0, "unscheduled workflow never due");
}

console.log(failures ? `\nFAIL: ${failures} check(s)` : "\nAll cron checks passed");
process.exit(failures ? 1 : 0);
