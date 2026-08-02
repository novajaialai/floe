import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The fixed category set. The site and the gallery both filter on it. */
export const CATEGORIES = [
  "sales",
  "recruiting",
  "marketing",
  "data",
  "research",
  "ops",
  "engineering",
  "docs",
  "personal",
  "monitoring",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface Template {
  /** Slug = filename without extension; the handle used by CLI/UI/site. */
  id: string;
  name: string;
  category?: string;
  /** One-liner shown on cards and in listings. */
  description?: string;
  prompt: string;
  schedule?: string;
  inputs: string[];
  integrations: string[];
  /** Domains the run needs an already-logged-in profile for. */
  requiresLogin: string[];
  /** Absolute path it was loaded from, when loaded from disk. */
  file?: string;
}

/**
 * Deliberately tiny YAML reader for templates/*.yaml — flat scalars, inline
 * `[a, b]` lists, `- item` lists and one `key: |` block scalar. A whole YAML
 * dependency would be a poor trade for a file format we also author.
 */
export function parseTemplate(text: string, id = "untitled"): Template {
  const lines = text.split("\n");
  const flat: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i++;
    if (!line.trim() || line.trimStart().startsWith("#") || /^\s/.test(line)) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rest] = m;
    if (rest === "|" || rest === "|-" || rest === ">") {
      const block: string[] = [];
      while (i < lines.length && (lines[i].trim() === "" || /^\s+/.test(lines[i]))) {
        block.push(lines[i].replace(/^ {1,2}/, ""));
        i++;
      }
      flat[key] = block.join("\n").trim();
    } else if (rest.startsWith("[")) {
      lists[key] = rest.replace(/^\[|\]$/g, "").split(",").map((s) => unquote(s.trim())).filter(Boolean);
    } else if (rest === "") {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(unquote(lines[i].replace(/^\s*-\s+/, "").trim()));
        i++;
      }
      lists[key] = items;
    } else {
      flat[key] = unquote(rest.trim());
    }
  }
  if (!flat.prompt) throw new Error("template has no prompt");
  return {
    id,
    name: flat.name ?? "untitled",
    category: flat.category,
    description: flat.description,
    prompt: flat.prompt,
    // `schedule: null` is YAML for "no schedule" — it must not reach the cron parser.
    schedule: nullable(flat.schedule),
    inputs: lists.inputs ?? [],
    integrations: lists.integrations ?? [],
    requiresLogin: lists.requires_login ?? [],
  };
}

export function loadTemplate(file: string): Template {
  const tpl = parseTemplate(readFileSync(file, "utf8"), basename(file).replace(/\.ya?ml$/, ""));
  tpl.file = resolve(file);
  return tpl;
}

/**
 * Where the shipped templates live. Env override first (packaged installs),
 * then the repo checkout relative to this module, then ./templates in cwd.
 */
export function templatesDir(): string {
  const candidates = [
    process.env.FLOE_TEMPLATES,
    // packages/engine/dist → repo root
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../templates"),
    resolve(process.cwd(), "templates"),
  ].filter((c): c is string => !!c);
  return candidates.find((c) => existsSync(c)) ?? candidates[candidates.length - 1];
}

/** Every shipped template, sorted by category then name. */
export function listTemplates(dir: string = templatesDir()): Template[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => loadTemplate(join(dir, f)))
    .sort((a, b) =>
      (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name),
    );
}

/** Resolve a template by id, filename or path — how the CLI takes --template. */
export function findTemplate(ref: string, dir: string = templatesDir()): Template {
  if (existsSync(ref) && /\.ya?ml$/.test(ref)) return loadTemplate(ref);
  const id = basename(ref).replace(/\.ya?ml$/, "");
  const direct = join(dir, `${id}.yaml`);
  if (existsSync(direct)) return loadTemplate(direct);
  const hit = listTemplates(dir).find((t) => t.id === id || t.name.toLowerCase() === ref.toLowerCase());
  if (!hit) throw new Error(`no template "${ref}" (floe templates list)`);
  return hit;
}

/** Substitute {placeholders}; every declared input must be supplied. */
export function renderTemplate(tpl: Template, inputs: Record<string, string>): string {
  const missing = tpl.inputs.filter((k) => inputs[k] === undefined || inputs[k] === "");
  if (missing.length) throw new Error(`template needs --input for: ${missing.join(", ")}`);
  return tpl.prompt.replace(/\{([A-Za-z0-9_-]+)\}/g, (whole, key) => inputs[key] ?? whole);
}

/** Every {placeholder} that actually appears in the prompt text. */
export function promptPlaceholders(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/\{([A-Za-z0-9_-]+)\}/g)].map((m) => m[1]))];
}

function nullable(v: string | undefined): string | undefined {
  return v === undefined || v === "" || v === "null" || v === "~" ? undefined : v;
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}
