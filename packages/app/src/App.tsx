import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  control,
  getState,
  reveal,
  runWorkflow,
  saveConfig,
  startRun,
  subscribe,
  type AppState,
  type Config,
  type RunEvent,
  type RunState,
} from "./api";
import { Timeline } from "./Timeline";
import { TemplatesView } from "./Templates";

type Tab = "run" | "templates" | "workflows" | "settings";

export function App() {
  const [tab, setTab] = useState<Tab>("run");
  const [state, setState] = useState<AppState | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [run, setRun] = useState<RunState | null>(null);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const s = await getState();
    setState(s);
    if (s.run) {
      setRun(s.run);
      // The server keeps the whole tape, so a reopened window sees the full run.
      setEvents((prev) => (prev.length ? prev : s.run!.events));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return subscribe((e) => {
      setEvents((prev) => (prev.some((p) => p.seq === e.seq) ? prev : [...prev, e]));
      if (e.ev === "control") setRun((r) => (r ? { ...r, state: e.state as RunState["state"] } : r));
      if (e.ev === "workspace") setRun((r) => (r ? { ...r, workspace: e.dir } : r));
      if (e.ev === "end" || e.ev === "fatal") {
        setRun((r) => (r ? { ...r, state: "finished" } : r));
        void refresh();
      }
    });
  }, [refresh]);

  const launch = async (fn: () => Promise<{ id: string }>) => {
    setError(undefined);
    try {
      setEvents([]);
      await fn();
      const s = await getState();
      setState(s);
      setRun(s.run);
      setTab("run");
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  };

  const send = async (cmd: "pause" | "resume" | "stop" | "kill") => {
    try {
      await control(cmd);
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  };

  return (
    <div className="shell">
      <nav className="rail">
        <div className="mark" title="Floe">
          <svg viewBox="0 0 40 40" width="26" height="26" aria-hidden>
            <path d="M20 3 L35 12 L35 28 L20 37 L5 28 L5 12 Z" fill="none" stroke="currentColor" strokeWidth="2.2" />
            <path d="M20 12 L28 17 L28 25 L20 30 L12 25 L12 17 Z" fill="currentColor" opacity=".55" />
          </svg>
          <span>floe</span>
        </div>
        {(["run", "templates", "workflows", "settings"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        <div className="rail-foot">
          <StatusDot run={run} />
        </div>
      </nav>

      <main className="main">
        {error && (
          <div className="banner err" onClick={() => setError(undefined)}>
            {error}
          </div>
        )}
        {tab === "run" && (
          <RunView
            run={run}
            events={events}
            onRun={(opts) => launch(() => startRun(opts))}
            onControl={send}
          />
        )}
        {tab === "templates" && (
          <TemplatesView
            busy={!!run && run.state !== "finished"}
            onLaunched={() => {
              setEvents([]);
              setTab("run");
              void refresh();
            }}
          />
        )}
        {tab === "workflows" && (
          <WorkflowsView
            state={state}
            onRun={(name, headed) => launch(() => runWorkflow(name, headed))}
            busy={!!run && run.state !== "finished"}
          />
        )}
        {tab === "settings" && <SettingsView config={state?.config} onSaved={refresh} />}
      </main>
    </div>
  );
}

function StatusDot({ run }: { run: RunState | null }) {
  const state = run?.state ?? "idle";
  return (
    <div className={`dot-wrap ${state}`}>
      <span className="dot" />
      <span>{state}</span>
    </div>
  );
}

function RunView({
  run,
  events,
  onRun,
  onControl,
}: {
  run: RunState | null;
  events: RunEvent[];
  onRun: (opts: Record<string, unknown>) => void;
  onControl: (cmd: "pause" | "resume" | "stop" | "kill") => void;
}) {
  const [task, setTask] = useState("");
  const [maxSteps, setMaxSteps] = useState(20);
  const [parallel, setParallel] = useState(3);
  const [headless, setHeadless] = useState(false);
  const live = !!run && run.state !== "finished";
  const elapsed = useElapsed(run?.startedAt, live);

  const steps = useMemo(
    () => events.reduce((max, e) => (e.step && e.agent === "main" ? Math.max(max, e.step) : max), 0),
    [events],
  );
  const end = events.find((e) => e.ev === "end");

  return (
    <>
      <section className="bar">
        <textarea
          className="cmd"
          placeholder="What should Floe do?  e.g. open news.ycombinator.com and save the top 10 stories to a CSV"
          value={task}
          rows={2}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && task.trim() && !live)
              onRun({ task, maxSteps, parallel, headless });
          }}
        />
        <div className="bar-side">
          <button className="go" disabled={!task.trim() || live} onClick={() => onRun({ task, maxSteps, parallel, headless })}>
            Run <kbd>⌘⏎</kbd>
          </button>
          <div className="opts">
            <label>
              steps
              <input type="number" min={1} max={200} value={maxSteps} onChange={(e) => setMaxSteps(+e.target.value)} />
            </label>
            <label>
              parallel
              <input type="number" min={1} max={4} value={parallel} onChange={(e) => setParallel(+e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} />
              headless
            </label>
          </div>
        </div>
      </section>

      <section className="strip">
        <div className="meta">
          <span className={`pill ${run?.state ?? "idle"}`}>{run?.state ?? "idle"}</span>
          <span className="label" title={run?.label}>{run?.label ?? "no run yet"}</span>
        </div>
        <div className="stats">
          <span>{elapsed}</span>
          <span>{steps} steps</span>
          <span>{events.length} events</span>
          {run?.workspace && (
            <button className="link" onClick={() => reveal(run.workspace!)} title={run.workspace}>
              workspace ↗
            </button>
          )}
        </div>
        <div className="controls">
          <button disabled={!live || run?.state === "paused"} onClick={() => onControl("pause")}>Pause</button>
          <button disabled={run?.state !== "paused"} onClick={() => onControl("resume")}>Resume</button>
          <button disabled={!live} onClick={() => onControl("stop")}>Stop</button>
          <button className="danger" disabled={!live} onClick={() => onControl("kill")}>Kill</button>
        </div>
      </section>

      <Timeline events={events} />

      {end && (
        <section className={`verdict ${end.success ? "ok" : "bad"}`}>
          <strong>{end.success ? "SUCCESS" : "INCOMPLETE"}</strong> · {end.steps} steps
          <p>{end.summary}</p>
        </section>
      )}
    </>
  );
}

function WorkflowsView({
  state,
  onRun,
  busy,
}: {
  state: AppState | null;
  onRun: (name: string, headed: boolean) => void;
  busy: boolean;
}) {
  if (!state) return <div className="empty">loading…</div>;
  return (
    <div className="scroll">
      <h2>Workflows</h2>
      {!state.workflows.length && <div className="empty">no saved workflows — floe workflow save &lt;name&gt; --task "…"</div>}
      <div className="cards">
        {state.workflows.map((wf) => (
          <div className="card" key={wf.name}>
            <div className="card-head">
              <h3>{wf.name}</h3>
              <button disabled={busy} onClick={() => onRun(wf.name, true)}>Run now</button>
            </div>
            <div className="chips">
              <span className="chip">{wf.schedule ?? "manual"}</span>
              <span className="chip dim">{wf.next ? `next ${new Date(wf.next).toLocaleString()}` : "not scheduled"}</span>
              <span className="chip dim">{wf.maxSteps} steps · {wf.parallel}× parallel</span>
              {wf.template && <span className="chip dim">{wf.template}</span>}
            </div>
            <p className="task">{wf.task}</p>
          </div>
        ))}
      </div>

      <h2>Run history</h2>
      {!state.history.length && <div className="empty">no runs recorded yet</div>}
      <table className="hist">
        <tbody>
          {state.history.map((h, i) => (
            <tr key={i}>
              <td className={h.success ? "ok" : "bad"}>{h.success ? "OK" : "FAIL"}</td>
              <td className="mono">{new Date(h.start).toLocaleString()}</td>
              <td>{h.name}</td>
              <td className="dim">{h.steps} steps</td>
              <td className="dim">{((+new Date(h.end) - +new Date(h.start)) / 60000).toFixed(1)} min</td>
              <td className="dim">{h.trigger}</td>
              <td className="summary">{h.summary}</td>
              <td>
                <button className="link" onClick={() => reveal(h.workspace)} title={h.workspace}>open ↗</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const FIELDS: Array<[keyof Config | "apiKey" | "anthropicApiKey", string, string]> = [
  ["provider", "Provider", "anthropic | openai"],
  ["model", "Planner model", "e.g. sonnet"],
  ["executorModel", "Executor model", "cheap lane, e.g. haiku"],
  ["toolMode", "Tool mode", "prompt = tool calls over plain text"],
  ["baseUrl", "Base URL", "http://127.0.0.1:8088"],
  ["apiKey", "API key", "OpenAI-compatible endpoint key"],
  ["anthropicApiKey", "Anthropic key", "ANTHROPIC_API_KEY"],
];

function SettingsView({ config, onSaved }: { config?: Config; onSaved: () => void }) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (config) setForm({ ...(config as unknown as Record<string, string>), apiKey: "", anthropicApiKey: "" });
  }, [config]);

  return (
    <div className="scroll">
      <h2>Settings</h2>
      <p className="note">
        Saved to <code>~/.floe/config.json</code> (mode 600), which the CLI reads too — so scheduled runs and the
        terminal use the same setup. Environment variables always win over this file.
      </p>
      <div className="form">
        {FIELDS.map(([key, label, hint]) => {
          const secret = key === "apiKey" || key === "anthropicApiKey";
          const present = key === "apiKey" ? config?.hasApiKey : key === "anthropicApiKey" ? config?.hasAnthropicKey : false;
          return (
            <label key={key} className="field">
              <span>{label}</span>
              <input
                type={secret ? "password" : "text"}
                placeholder={secret && present ? "•••••••• (saved — leave blank to keep)" : hint}
                value={form[key as string] ?? ""}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            </label>
          );
        })}
      </div>
      <button
        className="go"
        onClick={async () => {
          const body: Record<string, string> = {};
          for (const [k, v] of Object.entries(form)) if (v) body[k] = v;
          await saveConfig(body);
          setSaved(true);
          onSaved();
          setTimeout(() => setSaved(false), 2000);
        }}
      >
        {saved ? "Saved ✓" : "Save settings"}
      </button>
    </div>
  );
}

function useElapsed(startedAt: number | undefined, live: boolean): string {
  const [, tick] = useState(0);
  const timer = useRef<number>();
  useEffect(() => {
    if (!live) return;
    timer.current = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer.current);
  }, [live]);
  if (!startedAt) return "—";
  const s = Math.floor((Date.now() - startedAt) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
