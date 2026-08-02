import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCron, prevRun, nextRun } from "./cron.js";
import { floeHome, readState, writeState, type ScheduleState, type Workflow } from "./workflows.js";

export const CATCH_UP_MS = 24 * 60 * 60 * 1000;

export interface DueRun {
  workflow: Workflow;
  /** The scheduled slot being served (may be in the past = catch-up). */
  slot: Date;
  catchUp: boolean;
}

/**
 * A workflow is due when its most recent scheduled slot has not been served
 * yet. That single rule covers both cases we care about:
 *  - normal firing: the slot passed a moment ago, lastRun is older → run.
 *  - catch-up after sleep/reboot: the slot passed hours ago, lastRun is older
 *    → run once (and only once, because lastRun then moves past the slot).
 * Slots older than `catchUpMs` are abandoned rather than run stale.
 */
export function dueWorkflows(
  workflows: Workflow[],
  state: ScheduleState,
  now: Date = new Date(),
  catchUpMs: number = CATCH_UP_MS,
): DueRun[] {
  const due: DueRun[] = [];
  for (const wf of workflows) {
    if (!wf.schedule) continue;
    let slot: Date | undefined;
    try {
      slot = prevRun(parseCron(wf.schedule), now);
    } catch {
      continue; // a broken expression must not take the scheduler down
    }
    if (!slot) continue;
    const age = now.getTime() - slot.getTime();
    if (age > catchUpMs) continue;
    // A slot older than the workflow itself was never missed — it never
    // existed. Without this, saving a "0 7 * * *" workflow at noon fires it
    // instantly for this morning's slot.
    const created = wf.createdAt ? new Date(wf.createdAt).getTime() : 0;
    if (created && slot.getTime() < created) continue;
    const last = state.lastRun[wf.name];
    if (last && new Date(last).getTime() >= slot.getTime()) continue;
    due.push({ workflow: wf, slot, catchUp: age > 90_000 });
  }
  return due.sort((a, b) => a.slot.getTime() - b.slot.getTime());
}

export function upcoming(wf: Workflow, from: Date = new Date()): Date | undefined {
  if (!wf.schedule) return undefined;
  try {
    return nextRun(parseCron(wf.schedule), from);
  } catch {
    return undefined;
  }
}

function lockPath(home: string): string {
  return join(home, "scheduler.lock");
}

export function lockOwner(home: string = floeHome()): number | undefined {
  try {
    const pid = Number(readFileSync(lockPath(home), "utf8").trim());
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Take the tick lock unless a *live* process already holds it (stale locks are reclaimed). */
export function acquireLock(home: string = floeHome()): boolean {
  mkdirSync(home, { recursive: true });
  const p = lockPath(home);
  if (existsSync(p)) {
    const pid = lockOwner(home);
    if (pid && pid !== process.pid && alive(pid)) return false;
  }
  writeFileSync(p, String(process.pid));
  return true;
}

export function releaseLock(home: string = floeHome()): void {
  if (lockOwner(home) === process.pid) rmSync(lockPath(home), { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type RunFn = (wf: Workflow, trigger: string) => Promise<void>;

export interface SchedulerOptions {
  listWorkflows: () => Workflow[];
  run: RunFn;
  home?: string;
  log?: (msg: string) => void;
  catchUpMs?: number;
}

/**
 * Sequential scheduler: one Chrome profile means never two runs at once, so
 * due workflows are executed one after another and the tick simply takes as
 * long as it takes.
 */
export class Scheduler {
  private readonly home: string;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: SchedulerOptions) {
    this.home = opts.home ?? floeHome();
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /**
   * One pass: run everything currently due, sequentially. Returns run names.
   * Guarded by a pid lock, because a foreground `floe schedule` and the
   * launchd `--once` job can otherwise tick at the same moment — and they
   * share one Chrome profile.
   */
  async tick(now: Date = new Date()): Promise<string[]> {
    if (!acquireLock(this.home)) {
      this.log(`· another scheduler holds the lock (pid ${lockOwner(this.home)}) — skipping this tick`);
      return [];
    }
    try {
      return await this.runDue(now);
    } finally {
      releaseLock(this.home);
    }
  }

  private async runDue(now: Date): Promise<string[]> {
    const state = readState(this.home);
    const due = dueWorkflows(this.opts.listWorkflows(), state, now, this.opts.catchUpMs);
    const ran: string[] = [];
    for (const d of due) {
      // Claim the slot BEFORE running: a crash mid-run must not turn into a
      // run loop, and the history line records what actually happened.
      state.lastRun[d.workflow.name] = new Date().toISOString();
      writeState(state, this.home);
      this.log(
        `▶ ${d.workflow.name} — slot ${d.slot.toLocaleString()}${d.catchUp ? " (catch-up)" : ""}`,
      );
      try {
        await this.opts.run(d.workflow, d.catchUp ? "catch-up" : "scheduled");
      } catch (err: any) {
        this.log(`✖ ${d.workflow.name} failed: ${err?.message ?? err}`);
      }
      ran.push(d.workflow.name);
    }
    return ran;
  }

  /** Poll forever. Ticks are sequential, so a long run just delays the next check. */
  async loop(intervalMs = 30_000): Promise<never> {
    for (;;) {
      await this.tick();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
