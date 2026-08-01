import type { FloeBrowser } from "./browser.js";
import type { Workspace } from "./workspace.js";
import type { ToolDef } from "./types.js";

export interface ToolRuntime {
  browser: FloeBrowser;
  workspace: Workspace;
}

type Handler = (rt: ToolRuntime, input: any) => Promise<string>;

interface RegisteredTool {
  def: ToolDef;
  handler: Handler;
}

function obj(props: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties: props, required };
}

async function describePage(rt: ToolRuntime): Promise<string> {
  const s = await rt.browser.snapshot();
  const els = s.elements
    .filter((e) => e.inViewport)
    .map((e) => `[${e.id}] <${e.tag}${e.type ? ` type=${e.type}` : ""}${e.role ? ` role=${e.role}` : ""}> ${e.label}${e.href ? ` -> ${e.href}` : ""}`)
    .join("\n");
  const offscreen = s.elements.filter((e) => !e.inViewport).length;
  return [
    `URL: ${s.url}`,
    `Title: ${s.title}`,
    `Scroll: ${s.scroll.y}/${s.scroll.maxY}px`,
    `\n--- INTERACTIVE ELEMENTS (in viewport; ${offscreen} more offscreen — scroll to reveal) ---`,
    els || "(none in viewport)",
    `\n--- PAGE TEXT (truncated) ---`,
    s.text,
  ].join("\n");
}

export const TOOLS: RegisteredTool[] = [
  {
    def: {
      name: "navigate",
      description: "Navigate the active tab to a URL, then return a snapshot of the resulting page.",
      parameters: obj({ url: { type: "string" } }, ["url"]),
    },
    handler: async (rt, i) => {
      await rt.browser.navigate(i.url);
      return describePage(rt);
    },
  },
  {
    def: {
      name: "read_page",
      description:
        "Return a fresh snapshot of the active tab: URL, title, interactive elements with numeric ids, and page text. Use after any action that changes the page.",
      parameters: obj({}, []),
    },
    handler: async (rt) => describePage(rt),
  },
  {
    def: {
      name: "click",
      description: "Click an interactive element by the numeric id shown in the latest snapshot, then return a fresh snapshot.",
      parameters: obj({ element_id: { type: "number" } }, ["element_id"]),
    },
    handler: async (rt, i) => {
      await rt.browser.click(i.element_id);
      return describePage(rt);
    },
  },
  {
    def: {
      name: "type_text",
      description:
        "Click an input/textarea element by id, clear it, and type text. Set submit=true to press Enter afterwards.",
      parameters: obj(
        { element_id: { type: "number" }, text: { type: "string" }, submit: { type: "boolean" } },
        ["element_id", "text"],
      ),
    },
    handler: async (rt, i) => {
      await rt.browser.type(i.element_id, i.text, i.submit ?? false);
      return describePage(rt);
    },
  },
  {
    def: {
      name: "press_key",
      description: "Press a keyboard key in the active tab (e.g. Enter, Escape, PageDown, Tab).",
      parameters: obj({ key: { type: "string" } }, ["key"]),
    },
    handler: async (rt, i) => {
      await rt.browser.press(i.key);
      return describePage(rt);
    },
  },
  {
    def: {
      name: "scroll",
      description: "Scroll the active tab up or down by ~80% of the viewport, then return a fresh snapshot.",
      parameters: obj({ direction: { type: "string", enum: ["down", "up"] } }, ["direction"]),
    },
    handler: async (rt, i) => {
      await rt.browser.scroll(i.direction);
      return describePage(rt);
    },
  },
  {
    def: {
      name: "tabs",
      description:
        "Manage tabs. action=list lists tabs; action=new opens a tab (optional url); action=switch activates tab by index.",
      parameters: obj(
        { action: { type: "string", enum: ["list", "new", "switch"] }, url: { type: "string" }, index: { type: "number" } },
        ["action"],
      ),
    },
    handler: async (rt, i) => {
      if (i.action === "new") {
        const idx = await rt.browser.newTab(i.url);
        return `Opened tab ${idx}.\n` + (i.url ? await describePage(rt) : "");
      }
      if (i.action === "switch") {
        await rt.browser.switchTab(i.index);
        return describePage(rt);
      }
      const tabs = await rt.browser.listTabs();
      return tabs.map((t) => `${t.active ? "*" : " "} [${t.index}] ${t.title} — ${t.url}`).join("\n");
    },
  },
  {
    def: {
      name: "workspace_write",
      description:
        "Write (mode=overwrite) or append (mode=append) text to a file in the task workspace. Use for notes, progress tracking, and results (e.g. results.csv, notes.md).",
      parameters: obj(
        { name: { type: "string" }, content: { type: "string" }, mode: { type: "string", enum: ["overwrite", "append"] } },
        ["name", "content"],
      ),
    },
    handler: async (rt, i) => {
      if ((i.mode ?? "overwrite") === "append") rt.workspace.append(i.name, i.content);
      else rt.workspace.write(i.name, i.content);
      return `Wrote ${i.name} (${i.content.length} chars). Files: ${rt.workspace.list().join(", ")}`;
    },
  },
  {
    def: {
      name: "workspace_read",
      description: "Read a file from the task workspace.",
      parameters: obj({ name: { type: "string" } }, ["name"]),
    },
    handler: async (rt, i) => rt.workspace.read(i.name).slice(0, 20_000),
  },
  {
    def: {
      name: "done",
      description:
        "Finish the task. Provide a summary of what was accomplished and name any workspace files containing results.",
      parameters: obj({ summary: { type: "string" }, success: { type: "boolean" } }, ["summary", "success"]),
    },
    handler: async (_rt, i) => i.summary,
  },
];

export function toolDefs(): ToolDef[] {
  return TOOLS.map((t) => t.def);
}

export async function executeTool(rt: ToolRuntime, name: string, input: any): Promise<string> {
  const tool = TOOLS.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler(rt, input);
}
