import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATEGORIES,
  WorkflowStore,
  findTemplate,
  listTemplates,
  readConfig,
  readHistory,
  redactConfig,
  renderTemplate,
  upcoming,
  writeConfig,
  type FloeConfig,
  type Workflow,
} from "@floe/engine";

/**
 * `floe ui` — the desktop control surface, served on localhost.
 *
 * It deliberately owns no agent logic: it spawns `floe events-run` as a child
 * and relays that JSONL protocol to the browser over SSE, exactly as the Tauri
 * shell does. One seam, two shells.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(HERE, "main.js");
/** packages/cli/dist → packages/app/dist */
const UI_DIST = resolve(HERE, "../../app/dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

interface RunEvent {
  seq: number;
  [k: string]: unknown;
}

/** One agent run in flight, plus its event tape so a late tab sees the whole run. */
class Run {
  readonly id = new Date().toISOString().replace(/[:.]/g, "-");
  readonly events: RunEvent[] = [];
  state: "running" | "paused" | "stopping" | "finished" = "running";
  workspace?: string;
  startedAt = Date.now();
  private seq = 0;

  constructor(
    readonly label: string,
    readonly child: ChildProcessWithoutNullStreams,
    private readonly broadcast: (e: RunEvent) => void,
  ) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        this.push({ ev: "log", msg: line });
      }
    });
    // The child's stderr is not protocol — surface it as log lines, never parse.
    createInterface({ input: child.stderr }).on("line", (msg) => this.push({ ev: "log", msg, stderr: true }));
    child.on("exit", (code) => {
      this.state = "finished";
      this.push({ ev: "exit", code });
    });
  }

  private push(obj: Record<string, unknown>): void {
    // ts comes from the child for protocol events; locally-minted ones need their own.
    const e: RunEvent = { ts: Date.now(), ...obj, seq: ++this.seq };
    if (obj.ev === "workspace") this.workspace = obj.dir as string;
    if (obj.ev === "control") this.state = obj.state as Run["state"];
    if (obj.ev === "end" || obj.ev === "fatal") this.state = "finished";
    this.events.push(e);
    this.broadcast(e);
  }

  send(cmd: string): void {
    if (this.state === "finished") return;
    this.child.stdin.write(JSON.stringify({ cmd }) + "\n");
  }
}

export async function serveUi(opts: { port: number; open: boolean }): Promise<void> {
  const store = new WorkflowStore();
  const clients = new Set<ServerResponse>();
  let run: Run | undefined;

  const broadcast = (e: RunEvent) => {
    const payload = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(payload);
  };

  const start = (label: string, args: string[]): Run => {
    if (run && run.state !== "finished") throw new Error("a run is already in flight — stop it first");
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;
    run = new Run(label, child, broadcast);
    return run;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${opts.port}`);
    try {
      if (url.pathname.startsWith("/api/")) return await api(url, req, res);
      return staticFile(url.pathname, res);
    } catch (err: any) {
      json(res, 400, { error: err?.message ?? String(err) });
    }
  });

  async function api(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    switch (url.pathname) {
      case "/api/state": {
        const workflows = store.list().map((wf) => {
          const next = upcoming(wf);
          return { ...wf, next: next ? next.toISOString() : null };
        });
        return json(res, 200, {
          workflows,
          history: readHistory(undefined, 50).reverse(),
          config: redactConfig(readConfig()),
          run: run
            ? {
                id: run.id,
                label: run.label,
                state: run.state,
                workspace: run.workspace,
                startedAt: run.startedAt,
                events: run.events,
              }
            : null,
        });
      }
      case "/api/stream": {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      case "/api/run": {
        const b = await body(req);
        if (!b.task) throw new Error("task is required");
        const args = ["events-run", String(b.task)];
        if (b.maxSteps) args.push("--max-steps", String(b.maxSteps));
        if (b.maxMinutes) args.push("--max-minutes", String(b.maxMinutes));
        if (b.parallel) args.push("--parallel", String(b.parallel));
        if (b.headless) args.push("--headless");
        const r = start(String(b.task), args);
        return json(res, 200, { id: r.id });
      }
      case "/api/templates":
        // The gallery is a view of templates/*.yaml — same source as the CLI
        // and the generated site, so the three can never drift.
        return json(res, 200, { categories: CATEGORIES, templates: listTemplates() });
      case "/api/template/run": {
        const b = await body(req);
        const tpl = findTemplate(String(b.id));
        const task = renderTemplate(tpl, (b.inputs ?? {}) as Record<string, string>);
        const args = ["events-run", task];
        if (b.maxSteps) args.push("--max-steps", String(b.maxSteps));
        if (b.parallel) args.push("--parallel", String(b.parallel));
        if (b.headless) args.push("--headless");
        const r = start(`template: ${tpl.name}`, args);
        return json(res, 200, { id: r.id });
      }
      case "/api/template/save": {
        const b = await body(req);
        const tpl = findTemplate(String(b.id));
        const inputs = (b.inputs ?? {}) as Record<string, string>;
        const task = renderTemplate(tpl, inputs);
        const name = String(b.name ?? tpl.id);
        const existing = store.get(name);
        const wf: Workflow = {
          name,
          task,
          schedule: b.schedule ? String(b.schedule) : undefined,
          maxSteps: Number(b.maxSteps ?? existing?.maxSteps ?? 60),
          maxMinutes: existing?.maxMinutes,
          parallel: Number(b.parallel ?? existing?.parallel ?? 3),
          headless: b.headless === undefined ? (existing?.headless ?? true) : !!b.headless,
          template: tpl.id,
          inputs,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        };
        store.save(wf); // throws on a bad cron before anything is written
        return json(res, 200, { workflow: wf });
      }
      case "/api/workflow/run": {
        const b = await body(req);
        const wf = store.require(String(b.name));
        const args = ["events-workflow", wf.name];
        if (b.headed) args.push("--headed");
        const r = start(`workflow: ${wf.name}`, args);
        return json(res, 200, { id: r.id });
      }
      case "/api/control": {
        const b = await body(req);
        const cmd = String(b.cmd);
        if (!["pause", "resume", "stop", "kill"].includes(cmd)) throw new Error(`bad command: ${cmd}`);
        if (!run || run.state === "finished") throw new Error("no run in flight");
        run.send(cmd);
        return json(res, 200, { ok: true, state: run.state });
      }
      case "/api/config": {
        const b = (await body(req)) as FloeConfig & { apiKey?: string };
        const current = readConfig();
        // A blank secret means "leave it alone", not "erase it".
        const next: FloeConfig = { ...current, ...b };
        if (!b.apiKey) next.apiKey = current.apiKey;
        if (!b.anthropicApiKey) next.anthropicApiKey = current.anthropicApiKey;
        writeConfig(next);
        return json(res, 200, { config: redactConfig(next) });
      }
      case "/api/reveal": {
        const b = await body(req);
        const path = String(b.path ?? "");
        if (!path) throw new Error("path is required");
        spawn("open", [path], { detached: true, stdio: "ignore" }).unref();
        return json(res, 200, { ok: true });
      }
      default:
        return json(res, 404, { error: "no such endpoint" });
    }
  }

  server.listen(opts.port, "127.0.0.1", () => {
    const at = `http://127.0.0.1:${opts.port}`;
    console.log(`floe ui → ${at}`);
    if (!existsSync(join(UI_DIST, "index.html")))
      console.log(`! UI bundle missing at ${UI_DIST} — run: npm run build:app`);
    if (opts.open) spawn("open", [at], { detached: true, stdio: "ignore" }).unref();
  });

  await new Promise<void>((resolve) => server.on("close", () => resolve()));
}

function staticFile(pathname: string, res: ServerResponse): void {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(UI_DIST, rel);
  if (!file.startsWith(UI_DIST) || !existsSync(file)) {
    // SPA fallback keeps deep links working.
    const index = join(UI_DIST, "index.html");
    if (!existsSync(index)) return void json(res, 404, { error: `UI bundle not built (${UI_DIST})` });
    res.writeHead(200, { "content-type": MIME[".html"] });
    return void res.end(readFileSync(index));
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
