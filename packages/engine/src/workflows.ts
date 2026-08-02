import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseCron } from "./cron.js";

export interface Workflow {
  name: string;
  task: string;
  /** 5-field cron expression; absent = manual runs only. */
  schedule?: string;
  maxSteps: number;
  maxMinutes?: number;
  parallel: number;
  /** Scheduled runs default to headless — nobody is watching at 7am. */
  headless: boolean;
  /** Provenance when created from templates/*.yaml. */
  template?: string;
  inputs?: Record<string, string>;
  createdAt: string;
}

export interface HistoryEntry {
  name: string;
  start: string;
  end: string;
  success: boolean;
  steps: number;
  workspace: string;
  summary: string;
  /** "manual" | "scheduled" */
  trigger: string;
}

export interface ScheduleState {
  /** workflow name → ISO timestamp of the last run the scheduler started. */
  lastRun: Record<string, string>;
}

export function floeHome(): string {
  return process.env.FLOE_HOME ?? join(homedir(), ".floe");
}

const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** JSON-file-per-workflow store under ~/.floe/workflows. */
export class WorkflowStore {
  readonly dir: string;

  constructor(home: string = floeHome()) {
    this.dir = join(home, "workflows");
    mkdirSync(this.dir, { recursive: true });
  }

  private path(name: string): string {
    if (!WORKFLOW_NAME.test(name)) throw new Error(`invalid workflow name "${name}" (letters, digits, . _ -)`);
    return join(this.dir, `${name}.json`);
  }

  save(wf: Workflow): Workflow {
    if (wf.schedule) parseCron(wf.schedule); // fail loudly at save time, not at 7am
    writeFileSync(this.path(wf.name), JSON.stringify(wf, null, 2) + "\n");
    return wf;
  }

  get(name: string): Workflow | undefined {
    const p = this.path(name);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Workflow) : undefined;
  }

  require(name: string): Workflow {
    const wf = this.get(name);
    if (!wf) throw new Error(`no workflow named "${name}" (floe workflow list)`);
    return wf;
  }

  list(): Workflow[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Workflow)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  remove(name: string): boolean {
    const p = this.path(name);
    if (!existsSync(p)) return false;
    rmSync(p);
    return true;
  }
}

export function historyPath(home: string = floeHome()): string {
  return join(home, "history.jsonl");
}

export function appendHistory(entry: HistoryEntry, home: string = floeHome()): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(historyPath(home), JSON.stringify(entry) + "\n");
}

export function readHistory(name?: string, limit = 20, home: string = floeHome()): HistoryEntry[] {
  const p = historyPath(home);
  if (!existsSync(p)) return [];
  const all = readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as HistoryEntry;
      } catch {
        return undefined;
      }
    })
    .filter((e): e is HistoryEntry => !!e)
    .filter((e) => !name || e.name === name);
  return all.slice(-limit);
}

export function statePath(home: string = floeHome()): string {
  return join(home, "schedule-state.json");
}

export function readState(home: string = floeHome()): ScheduleState {
  const p = statePath(home);
  if (!existsSync(p)) return { lastRun: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as ScheduleState;
    return { lastRun: s.lastRun ?? {} };
  } catch {
    return { lastRun: {} };
  }
}

export function writeState(state: ScheduleState, home: string = floeHome()): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(statePath(home), JSON.stringify(state, null, 2) + "\n");
}

/** Run workspace: ~/.floe/workspaces/<name>/<timestamp>/ */
export function runWorkspaceRoot(name: string, home: string = floeHome()): string {
  return join(home, "workspaces", name);
}

export function runStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}
