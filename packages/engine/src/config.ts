import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { floeHome } from "./workflows.js";

/**
 * Persisted provider settings (~/.floe/config.json), so the desktop app can
 * configure Floe once instead of every caller exporting FLOE_* by hand.
 *
 * Precedence is deliberate and one-directional: an env var ALWAYS wins over the
 * file. Scripts, LaunchAgents and CI keep working exactly as before; the file is
 * only a default for whatever the environment did not say.
 */
export interface FloeConfig {
  provider?: string;
  model?: string;
  executorModel?: string;
  toolMode?: string;
  baseUrl?: string;
  apiKey?: string;
  anthropicApiKey?: string;
}

/** config field → env var it fills in when the env is silent. */
const ENV_KEYS: Record<keyof FloeConfig, string> = {
  provider: "FLOE_PROVIDER",
  model: "FLOE_MODEL",
  executorModel: "FLOE_EXECUTOR_MODEL",
  toolMode: "FLOE_TOOL_MODE",
  baseUrl: "FLOE_BASE_URL",
  apiKey: "FLOE_API_KEY",
  anthropicApiKey: "ANTHROPIC_API_KEY",
};

export function configPath(home: string = floeHome()): string {
  return join(home, "config.json");
}

export function readConfig(home: string = floeHome()): FloeConfig {
  const p = configPath(home);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as FloeConfig;
  } catch {
    return {};
  }
}

export function writeConfig(cfg: FloeConfig, home: string = floeHome()): void {
  mkdirSync(home, { recursive: true });
  const p = configPath(home);
  // Holds API keys: never world-readable.
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
}

/** Fill in FLOE_* env vars from the config file. Env wins; empty values are ignored. */
export function applyConfig(home: string = floeHome()): FloeConfig {
  const cfg = readConfig(home);
  for (const [key, env] of Object.entries(ENV_KEYS) as Array<[keyof FloeConfig, string]>) {
    const v = cfg[key];
    if (v && !process.env[env]) process.env[env] = v;
  }
  return cfg;
}

/** Config as it should be shown to a UI — secrets replaced by a presence flag. */
export function redactConfig(cfg: FloeConfig): FloeConfig & { hasApiKey: boolean; hasAnthropicKey: boolean } {
  const { apiKey, anthropicApiKey, ...rest } = cfg;
  return { ...rest, hasApiKey: !!apiKey, hasAnthropicKey: !!anthropicApiKey };
}
