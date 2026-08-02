/**
 * Thin client over the `floe ui` HTTP API.
 *
 * There is deliberately no Tauri branch here: the desktop shell boots the very
 * same local server as a sidecar and points its webview at it, so the frontend
 * is identical in both shells and the runner protocol has exactly one consumer.
 */
export interface RunEvent {
  seq: number;
  ev: string;
  ts: number;
  agent?: string;
  step?: number;
  detail?: string;
  msg?: string;
  dir?: string;
  state?: string;
  summary?: string;
  success?: boolean;
  steps?: number;
  workspace?: string;
  error?: string;
  code?: number | null;
  task?: string;
}

export interface Workflow {
  name: string;
  task: string;
  schedule?: string;
  maxSteps: number;
  maxMinutes?: number;
  parallel: number;
  headless: boolean;
  template?: string;
  createdAt: string;
  next: string | null;
}

export interface HistoryEntry {
  name: string;
  start: string;
  end: string;
  success: boolean;
  steps: number;
  workspace: string;
  summary: string;
  trigger: string;
}

export interface Config {
  provider?: string;
  model?: string;
  executorModel?: string;
  toolMode?: string;
  baseUrl?: string;
  hasApiKey: boolean;
  hasAnthropicKey: boolean;
}

export interface RunState {
  id: string;
  label: string;
  state: "running" | "paused" | "stopping" | "finished";
  workspace?: string;
  startedAt: number;
  events: RunEvent[];
}

export interface AppState {
  workflows: Workflow[];
  history: HistoryEntry[];
  config: Config;
  run: RunState | null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const getState = async (): Promise<AppState> => (await fetch("/api/state")).json();
export const startRun = (opts: Record<string, unknown>) => post<{ id: string }>("/api/run", opts);
export const runWorkflow = (name: string, headed: boolean) =>
  post<{ id: string }>("/api/workflow/run", { name, headed });
export const control = (cmd: "pause" | "resume" | "stop" | "kill") => post("/api/control", { cmd });
export const saveConfig = (cfg: Record<string, unknown>) => post<{ config: Config }>("/api/config", cfg);
export const reveal = (path: string) => post("/api/reveal", { path });

/** Live event tape. Returns an unsubscribe. */
export function subscribe(onEvent: (e: RunEvent) => void): () => void {
  const src = new EventSource("/api/stream");
  src.onmessage = (m) => onEvent(JSON.parse(m.data) as RunEvent);
  return () => src.close();
}
