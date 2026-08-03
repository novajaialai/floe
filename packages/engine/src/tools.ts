import type { BrowserSession } from "./browser.js";
import type { Workspace } from "./workspace.js";
import type { ToolDef } from "./types.js";
import type { ExtractedRow, ExtractedTable } from "./extract.js";

/** Launch N executor subagents and block until they all finish. */
export type SpawnFn = (specs: SpawnSpec[]) => Promise<string>;

export interface SpawnSpec {
  name?: string;
  task: string;
  model?: string;
  max_steps?: number;
}

/**
 * What one agent can touch: its OWN browser session, the shared task
 * workspace, and — only if it is the orchestrator — the ability to spawn
 * executors.
 */
export interface ToolRuntime {
  session: BrowserSession;
  workspace: Workspace;
  spawn?: SpawnFn;
  /** Agent label stamped on write receipts ("main", or the executor name). */
  label?: string;
}

type Handler = (rt: ToolRuntime, input: any) => Promise<string>;

interface RegisteredTool {
  def: ToolDef;
  handler: Handler;
  /** Only offered to an agent that can spawn (the orchestrator). */
  orchestratorOnly?: boolean;
}

function obj(props: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties: props, required };
}

/** Dense pages can list hundreds of in-viewport elements — cap what one snapshot renders. */
const MAX_LISTED_ELEMENTS = 120;
/** Above this DOM size the auto structure-hint extraction pass is skipped (cost). */
const HINT_NODE_BUDGET = 8_000;

async function describePage(rt: ToolRuntime): Promise<string> {
  const s = await rt.session.snapshot();
  // The hint costs a full in-page extraction pass — skip it on very dense
  // pages; the model can still call extract_table explicitly.
  const t = (s.nodeCount ?? 0) > HINT_NODE_BUDGET ? null : await rt.session.extractTable().catch(() => null);
  const hint =
    t && t.rows.length >= 5
      ? `\n[!] ${t.rows.length} repeated records detected on this page (${t.source}). Use extract_table / paginate_extract for them — the page text below is truncated and must not be used to transcribe rows.`
      : "";
  const warnings: string[] = [];
  const nav = rt.session.lastNav;
  const bare = (u: string) => u.replace(/^[a-z]+:\/\//i, "").replace(/^www\./, "").replace(/\/$/, "");
  if (nav && nav.finalUrl === s.url) {
    if (nav.status >= 400)
      warnings.push(
        `[!] HTTP ${nav.status} — this is an ERROR page, not real content. Do not extract results from it; check the URL or try another source.`,
      );
    if (bare(nav.requested) !== bare(s.url)) warnings.push(`[!] Redirected: requested ${nav.requested} but landed on ${s.url}.`);
  }
  if (s.blocker)
    warnings.push(
      `[!] A dialog/overlay is open: "${s.blocker}". It may block every other click — dismiss it first (its Accept/Close button, or press_key Escape).`,
    );
  for (const f of s.iframes ?? []) warnings.push(`[!] ${f}`);
  const inView = s.elements.filter((e) => e.inViewport);
  const shown = inView.slice(0, MAX_LISTED_ELEMENTS);
  const els = shown
    .map((e) => `[${e.id}] <${e.tag}${e.type ? ` type=${e.type}` : ""}${e.role ? ` role=${e.role}` : ""}> ${e.label}${e.href ? ` -> ${e.href}` : ""}`)
    .join("\n");
  const offscreen = s.elements.length - inView.length;
  const unlisted = inView.length - shown.length;
  return [
    `URL: ${s.url}`,
    `Title: ${s.title}`,
    `Scroll: ${s.scroll.y}/${s.scroll.maxY}px${hint}`,
    ...warnings,
    `\n--- INTERACTIVE ELEMENTS (in viewport; ${offscreen} more offscreen — scroll to reveal) ---`,
    els || "(none in viewport)",
    unlisted > 0 ? `(+${unlisted} more interactive elements in viewport not listed — dense page; use what is shown, or extract_table for lists)` : "",
    `\n--- PAGE TEXT (truncated) ---`,
    s.text,
  ]
    .filter(Boolean)
    .join("\n");
}

interface ColumnSpec {
  name: string;
  cell?: number;
  pattern?: string;
  link?: "href" | "text";
  /** Which of the row's links to use (default 0 — the first). */
  link_index?: number;
  /** Regex over link text; the first matching link wins (beats link_index). */
  link_match?: string;
}

/** Pull one column's value out of an extracted row, code-side. */
function columnValue(row: ExtractedRow, spec: ColumnSpec): string {
  if (spec.link) {
    let l = row.links[spec.link_index ?? 0];
    if (spec.link_match) {
      const re = new RegExp(spec.link_match, "i");
      l = row.links.find((x) => re.test(x.text)) ?? l;
    }
    return l ? (spec.link === "href" ? l.href : l.text) : "";
  }
  if (spec.pattern) {
    const m = row.text.match(new RegExp(spec.pattern, "i"));
    return m ? (m[1] ?? m[0]).trim() : "";
  }
  if (typeof spec.cell === "number") return row.cells[spec.cell] ?? "";
  return "";
}

/**
 * Every column must be extracted FROM the page — exactly one of cell/pattern/
 * link. Anything else (e.g. a constant "value") would let fabricated columns
 * flow through a legitimate tool with perfect receipts.
 */
function validateColumns(specs: ColumnSpec[]): string | null {
  for (const c of specs) {
    const modes = ["cell", "pattern", "link"].filter((k) => (c as any)[k] !== undefined);
    if (modes.length !== 1)
      return `ERROR: column "${c.name}" must define exactly one of "cell", "pattern" or "link" (got: ${modes.join(", ") || "none"}). Constant or invented values are not allowed — every column must be extracted from the page.`;
  }
  return null;
}

/**
 * Does this workspace_write look like hand-transcribed table rows? A .csv (or
 * comma/tab-separated body) with 3+ data lines of consistent width is the
 * signature; a header-only reset, a note, or a prose file is not.
 */
export function handTypedRows(name: string, content: string): boolean {
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length < 4) return false; // header + 3 rows minimum
  const sep = /\t/.test(lines[0]) ? "\t" : ",";
  const widths = lines.map((l) => l.split(sep).length);
  if (widths[0] < 2) return false;
  const consistent = widths.filter((w) => w === widths[0]).length >= lines.length * 0.8;
  if (!consistent) return false;
  // Either the file is named as a table, or its first line is a bare header
  // row (short field names, no prose punctuation) — prose that happens to
  // contain commas must not be mistaken for transcription.
  const headerish = lines[0]
    .split(sep)
    .every((f) => f.replace(/^"|"$/g, "").trim().length <= 24 && !/[.:;!?]/.test(f));
  return /\.(csv|tsv)$/i.test(name) || headerish;
}

/** "rows have 4-7 cells" — the tell that cell indices shift on some rows. */
function cellSpread(rows: ExtractedRow[]): { min: number; max: number } {
  let min = Infinity, max = 0;
  for (const r of rows) {
    if (r.cells.length < min) min = r.cells.length;
    if (r.cells.length > max) max = r.cells.length;
  }
  return { min: rows.length ? min : 0, max };
}

/**
 * Exhaustive-pagination steering (session 10): decide, after a
 * paginate_extract call's page budget is spent, whether pagination is truly
 * exhausted. The model's failure mode was calling done right after the first
 * page (30/30 rows receipted but the "More" link never followed) — a partial
 * scrape reported as complete because nothing in the tool result said more
 * pages existed.
 *
 * Pure + exported so smoke-steering.mjs can assert the decision matrix
 * model-free; the tool handler applies it to the session flag + banner.
 *
 * @param mode      how this call advanced ("none" = agent explicitly said one page)
 * @param exhausted true when the last advancePage call failed (no control / HTTP error / no scroll growth)
 * @param nextFound label of a still-present next/more control, or null
 * @param pages     the page budget this call was given
 */
export function paginationProbe(
  mode: "auto" | "scroll" | "none",
  exhausted: boolean,
  nextFound: string | null,
  pages: number,
): { pending: boolean; line: string } {
  if (mode === "none" || exhausted) return { pending: false, line: "" };
  if (mode === "scroll") {
    // Last advance grew content; the budget is the only thing that stopped us.
    // No control exists on an infinite feed, so the honest signal is the
    // advance itself — more content is likely still loadable.
    return {
      pending: true,
      line: `[!] PAGINATION NOT EXHAUSTED: the last scroll advanced the feed and the page budget (${pages}) is spent. Keep paginating (call paginate_extract again, or with a larger max_pages) until the advance reports no new content — do NOT call done while more may remain.`,
    };
  }
  if (nextFound)
    return {
      pending: true,
      line: `[!] PAGINATION NOT EXHAUSTED: a "${nextFound}" control is still present after ${pages} page(s). Keep paginating (call paginate_extract again, or with a larger max_pages) until the advance reports failure — do NOT call done while more pages remain.`,
    };
  return { pending: false, line: "" };
}

function renderTable(t: ExtractedTable, maxRows: number): string {
  if (t.kind === "none" || !t.rows.length) return "No repeated structure detected on this page.";
  const spread = cellSpread(t.rows);
  const head = [
    `Structure: ${t.kind} (${t.source}) — ${t.rows.length} rows detected`,
    t.columns ? `Header: ${t.columns.map((c, i) => `[${i}]${c}`).join(" | ")}` : `Cells are numbered [0..n] per row.`,
  ];
  if (spread.min !== spread.max)
    head.push(
      `[!] Rows have ${spread.min}-${spread.max} cells — optional fields shift the cell indices on some rows, so "cell" mappings are UNRELIABLE for anything after the shift; prefer "pattern" (regex) columns for fields that can be missing.`,
    );
  // Every link of the row is listed with its index: a row usually carries
  // several (title, author, comments, timestamp) and the model must be able to
  // pick the right one FIRST TRY — guessing costs a page load per attempt,
  // which is how a scrape thrashes into a rate limit and gets abandoned for
  // hand transcription.
  const body = t.rows.slice(0, maxRows).map((r, i) => {
    const cells = r.cells.map((c, j) => `[${j}]${c}`).join(" | ");
    const links = r.links
      .slice(0, 5)
      .map((l, j) => `\n    L${j} "${l.text.slice(0, 50)}" -> ${l.href}`)
      .join("");
    const more = r.links.length > 5 ? `\n    (+${r.links.length - 5} more links)` : "";
    return `#${i} ${cells.slice(0, 500)}${links}${more}`;
  });
  if (t.rows.length > maxRows) body.push(`… ${t.rows.length - maxRows} more rows (same shape)`);
  body.push(
    `\n→ Do NOT retype these rows by hand: rows written with workspace_write carry no extraction receipt and are discarded as unaccountable. Save them (and the following pages) to a CSV with paginate_extract, mapping the [n] cell numbers and the L<n> links above, e.g. columns=[{"name":"title","cell":1},{"name":"url","link":"href","link_index":0}]. link_index is the L number; link_match matches the quoted link text instead. If a mapping came out wrong, call paginate_extract again with reset=true — never "fix" the CSV by hand.`,
  );
  return [...head, ...body].join("\n");
}

export const TOOLS: RegisteredTool[] = [
  {
    def: {
      name: "navigate",
      description: "Navigate the active tab to a URL, then return a snapshot of the resulting page.",
      parameters: obj({ url: { type: "string" } }, ["url"]),
    },
    handler: async (rt, i) => {
      await rt.session.navigate(i.url);
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
      await rt.session.click(i.element_id);
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
      await rt.session.type(i.element_id, i.text, i.submit ?? false);
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
      await rt.session.press(i.key);
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
      await rt.session.scroll(i.direction);
      return describePage(rt);
    },
  },
  {
    def: {
      name: "tabs",
      description:
        "Manage the tabs owned by YOUR browser session. action=list lists them; action=new opens another one (optional url); action=switch activates one by index. Other agents' tabs are invisible to you.",
      parameters: obj(
        { action: { type: "string", enum: ["list", "new", "switch"] }, url: { type: "string" }, index: { type: "number" } },
        ["action"],
      ),
    },
    handler: async (rt, i) => {
      if (i.action === "new") {
        const idx = await rt.session.newTab(i.url);
        return `Opened tab ${idx}.\n` + (i.url ? await describePage(rt) : "");
      }
      if (i.action === "switch") {
        await rt.session.switchTab(i.index);
        return describePage(rt);
      }
      const tabs = await rt.session.listTabs();
      return tabs.map((t) => `${t.active ? "*" : " "} [${t.index}] ${t.title} — ${t.url}`).join("\n");
    },
  },
  {
    def: {
      name: "extract_table",
      description:
        "Detect the dominant repeated structure on the current page (table rows, listing cards, feed items) and return it as structured rows with numbered cells. No page text truncation — use this instead of read_page whenever you need to extract a list, then map the cell numbers to your output columns.",
      parameters: obj({ max_rows: { type: "number", description: "Rows to show (default 20)" } }, []),
    },
    handler: async (rt, i) => renderTable(await rt.session.extractTable(), Math.min(i.max_rows ?? 20, 100)),
  },
  {
    def: {
      name: "paginate_extract",
      description:
        "Scrape a paginated list into a CSV, deduped. Per page it extracts the repeated structure (same detector as extract_table), maps it to your columns, appends only rows whose key column is new (dedupe is done in code against the whole CSV), then advances to the next page. Call extract_table first to see the cell numbering. Each column is defined by exactly one of: cell (cell index), pattern (regex over the row's full text; capture group 1 is used), or link ('href'/'text' of one of the row's links — add link_match (regex over link text) or link_index (nth link) when the first link is not the one you want, e.g. the title link rather than the author link).",
      parameters: obj(
        {
          csv: { type: "string", description: "Workspace CSV file name, e.g. results.csv" },
          columns: {
            type: "array",
            description: 'e.g. [{"name":"title","cell":1},{"name":"points","pattern":"(\\\\d+) points"},{"name":"url","link":"href"}]',
            items: obj(
              {
                name: { type: "string" },
                cell: { type: "number" },
                pattern: { type: "string" },
                link: { type: "string", enum: ["href", "text"] },
                link_index: { type: "number", description: "Use the nth link of the row (default 0)" },
                link_match: { type: "string", description: "Regex over link text; first matching link wins" },
              },
              ["name"],
            ),
          },
          key: { type: "string", description: "Column name used for dedupe (default: first column)" },
          max_pages: { type: "number", description: "Pages to process in this call (default 1, max 20)" },
          next: { type: "string", enum: ["auto", "scroll", "none"], description: "How to advance (default auto)" },
          require: { type: "string", description: "Optional regex; rows whose text does not match are dropped" },
          reset: {
            type: "boolean",
            description:
              "Empty the CSV before extracting, so a wrong column mapping can be redone from scratch. Always use this instead of rewriting the file with workspace_write — a hand-written CSV loses its extraction receipt.",
          },
        },
        ["csv", "columns"],
      ),
    },
    handler: async (rt, i) => {
      const specs: ColumnSpec[] = i.columns;
      const invalid = validateColumns(specs);
      if (invalid) return invalid;
      const names = specs.map((c) => c.name);
      const key = i.key && names.includes(i.key) ? i.key : names[0];
      const pages = Math.min(Math.max(1, i.max_pages ?? 1), 20);
      const mode = (i.next ?? "auto") as "auto" | "scroll" | "none";
      const filter = i.require ? new RegExp(i.require, "i") : null;
      const log: string[] = [];
      let totals = { added: 0, dup: 0, empty: 0, total: 0 };
      let sample = "";
      let advanceFailed = false;
      // Truncating through the extractor (not workspace_write) keeps the file's
      // provenance inside the receipted path after a bad column mapping.
      if (i.reset && rt.workspace.exists(i.csv)) {
        rt.workspace.write(i.csv, "", { tool: "paginate_extract", agent: rt.label });
        log.push(`reset: ${i.csv} emptied before extracting`);
      }

      for (let p = 1; p <= pages; p++) {
        const table = await rt.session.extractTable();
        const rows = table.rows
          .filter((r) => !filter || filter.test(r.text))
          .map((r) => specs.map((s) => columnValue(r, s)));
        const res = rt.workspace.appendCsvDeduped(i.csv, names, rows, key, { tool: "paginate_extract", agent: rt.label });
        totals = {
          added: totals.added + res.added,
          dup: totals.dup + res.dupSkipped,
          empty: totals.empty + res.emptyKeySkipped,
          total: res.total,
        };
        const spread = cellSpread(table.rows);
        const spreadNote = spread.min !== spread.max ? ` (cells ${spread.min}-${spread.max} — cell indices shift; prefer pattern columns)` : "";
        log.push(
          `page ${p} (${rt.session.page.url()}): detected ${table.rows.length} rows [${table.kind}: ${table.source}]${spreadNote} → +${res.added} new, ${res.dupSkipped} duplicate, ${res.emptyKeySkipped} empty-key`,
        );
        if (!sample && res.added) {
          const shown = rows.slice(0, 3).map((r) => r.map((c, j) => `${names[j]}=${c}`).join(" | "));
          sample = `Sample rows written:\n${shown.join("\n")}`;
        }
        if (p === pages || mode === "none") break;
        const adv = await rt.session.advancePage(mode);
        log.push(`  advance: ${adv.detail}`);
        if (!adv.ok) {
          advanceFailed = true;
          break;
        }
      }
      // Exhaustive-pagination steering: after the budget is spent, probe
      // whether more pages genuinely remain. If they do, the session flag is
      // set so done(success=true) is rejected (agent.ts) until the agent keeps
      // paginating; a real advance failure clears it. This closes the
      // "stopped after page 1, all rows receipted, called done" hole.
      const probe = advanceFailed ? null : await rt.session.nextControl().catch(() => null);
      const pp = paginationProbe(mode, advanceFailed, probe ? probe.text : null, pages);
      rt.session.paginationPending = pp.pending;
      if (pp.line) log.push(pp.line);
      return [
        `CSV ${i.csv}: +${totals.added} new rows this call, ${totals.dup + totals.empty} skipped (${totals.dup} duplicate / ${totals.empty} empty-key), ${totals.total} total rows in file.`,
        `Columns: ${names.join(", ")} (dedupe key: ${key})`,
        ...log,
        sample,
        totals.empty > 0 && totals.empty > totals.dup
          ? `WARNING: ${totals.empty} rows had an EMPTY "${key}" key — the key column mapping is extracting NOTHING for them. Fix the cell/pattern for "${key}" (check with extract_table); this is not normal dedupe.`
          : "",
        totals.added === 0
          ? "WARNING: nothing new was written. Check the column mapping with extract_table, or the pagination may be exhausted."
          : "",
      ]
        .filter(Boolean)
        .join("\n");
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
      const meta = { tool: "workspace_write", agent: rt.label };
      if ((i.mode ?? "overwrite") === "append") rt.workspace.append(i.name, i.content, meta);
      else rt.workspace.write(i.name, i.content, meta);
      const out = `Wrote ${i.name} (${i.content.length} chars). Files: ${rt.workspace.list().join(", ")}`;
      // Hand-typed rows are the shortcut this agent must not have: they carry no
      // extraction receipt, so nothing can distinguish them from remembered or
      // invented data. Say so at the moment it happens, not in a prompt rule.
      return handTypedRows(i.name, i.content)
        ? `${out}\nWARNING: ${i.name} looks like scraped rows typed by hand. Rows written this way have NO extraction receipt and are treated as unaccountable — they are discarded when the result is graded, even if they are correct. Re-do them with paginate_extract (add reset=true to start the file over); if the page has no structure paginate_extract can see, say so in your summary rather than transcribing it.`
        : out;
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
      name: "sheets_write",
      description:
        "Write a table of rows into a Google Sheet in the logged-in profile. url is the spreadsheet URL, or \"new\" to create a fresh spreadsheet. rows is an array of arrays (first row can be headers). mode=append (default) writes below the existing data; mode=overwrite writes starting at the start cell (default A1). Values are pasted as TSV through the sheet's own grid — the same path a human bulk-fill uses, no coordinate clicking. Every receipt claim is re-read from the sheet and verified; the tool fails loudly rather than report an unverified write.",
      parameters: obj(
        {
          url: { type: "string", description: "docs.google.com/spreadsheets URL, or \"new\" to create one" },
          rows: {
            type: "array",
            description: 'e.g. [["Name","Website"],["Acme","acme.com"],["Beta","beta.io"]]',
            items: { type: "array", items: { type: ["string", "number", "boolean"] } },
          },
          start: { type: "string", description: "Top-left cell to write from (default A1)" },
          mode: { type: "string", enum: ["append", "overwrite"], description: "append below existing data (default) or overwrite from start" },
        },
        ["url", "rows"],
      ),
    },
    handler: async (rt, i) => rt.session.sheetsWrite({ url: i.url, rows: i.rows, start: i.start, mode: i.mode }),
  },
  {
    orchestratorOnly: true,
    def: {
      name: "spawn_agents",
      description:
        "Delegate independent page-work to executor subagents that run IN PARALLEL, each in its own browser window with its own copy of these browser tools, sharing this task workspace. Give each one a complete, self-contained task (which site, what to collect, which workspace file to write). This call blocks until every executor finishes and returns their summaries. Use it whenever the task involves 2+ independent sites/queries/sections; do the synthesis yourself afterwards from the files they wrote.",
      parameters: obj(
        {
          agents: {
            type: "array",
            description:
              'One entry per parallel executor, e.g. [{"name":"cnn","task":"Go to lite.cnn.com and write the top 10 headlines to cnn-results.csv"}]',
            items: obj(
              {
                name: { type: "string", description: "Short slug used for the agent's window and its file prefix" },
                task: { type: "string", description: "Complete standalone instructions, including the workspace file to write" },
                model: { type: "string", description: "Optional model override; default is the cheap executor lane" },
                max_steps: { type: "number", description: "Step limit for this executor (default 25)" },
              },
              ["task"],
            ),
          },
        },
        ["agents"],
      ),
    },
    handler: async (rt, i) => {
      if (!rt.spawn) return "ERROR: this agent cannot spawn subagents.";
      const specs: SpawnSpec[] = Array.isArray(i.agents) ? i.agents : [];
      if (!specs.length) return "ERROR: agents must be a non-empty array.";
      return rt.spawn(specs);
    },
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

/** The tools this runtime is allowed to use (spawning is orchestrator-only). */
export function toolDefs(rt?: ToolRuntime): ToolDef[] {
  return TOOLS.filter((t) => !t.orchestratorOnly || rt?.spawn).map((t) => t.def);
}

export async function executeTool(rt: ToolRuntime, name: string, input: any): Promise<string> {
  const tool = TOOLS.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (tool.orchestratorOnly && !rt.spawn) throw new Error(`Tool ${name} is not available to this agent.`);
  return tool.handler(rt, input);
}
