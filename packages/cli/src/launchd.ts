import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { floeHome } from "@floe/engine";

export const LABEL = "com.floe.scheduler";

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Env the scheduler needs and launchd will not have: launchd starts jobs with a
 * bare PATH and none of the shell's exports, so provider config is baked into
 * the plist at install time (file is chmod 600 — it can hold an API key).
 */
function capturedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v && (k.startsWith("FLOE_") || k === "ANTHROPIC_API_KEY")) out[k] = v;
  }
  return out;
}

export function installAgent(intervalSeconds = 300): string {
  // Absolute node + absolute script: launchd has no nvm/homebrew PATH.
  const node = process.execPath;
  const cli = resolve(fileURLToPath(new URL(".", import.meta.url)), "main.js");
  const logDir = join(floeHome(), "logs");
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, "scheduler.log");
  const env = capturedEnv();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(cli)}</string>
    <string>schedule</string>
    <string>--once</string>
  </array>
  <key>StartInterval</key><integer>${intervalSeconds}</integer>
  <!-- RunAtLoad + the scheduler's own 24h catch-up = sleep/reboot resilience:
       a slot missed while the Mac was asleep is served on the next load. -->
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`)
  .join("\n")}
  </dict>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
  <key>WorkingDirectory</key><string>${esc(homedir())}</string>
</dict>
</plist>
`;
  const p = plistPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, plist);
  chmodSync(p, 0o600);
  bootout();
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, p], { stdio: "inherit" });
  return p;
}

export function uninstallAgent(): boolean {
  const p = plistPath();
  bootout();
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

export function agentStatus(): string {
  try {
    const out = execFileSync("launchctl", ["list"], { encoding: "utf8" });
    const line = out.split("\n").find((l) => l.includes(LABEL));
    return line ? `loaded: ${line.trim()}` : "not loaded";
  } catch {
    return "unknown (launchctl unavailable)";
  }
}

export function schedulerLogPath(): string {
  return join(floeHome(), "logs", "scheduler.log");
}

function bootout(): void {
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`], { stdio: "ignore" });
  } catch {
    /* not loaded */
  }
}
