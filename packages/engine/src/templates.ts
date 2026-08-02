import { readFileSync } from "node:fs";

export interface Template {
  name: string;
  category?: string;
  prompt: string;
  schedule?: string;
  inputs: string[];
  integrations: string[];
}

/**
 * Deliberately tiny YAML reader for templates/*.yaml — flat scalars, inline
 * `[a, b]` lists, `- item` lists and one `key: |` block scalar. A whole YAML
 * dependency would be a poor trade for a file format we also author.
 */
export function parseTemplate(text: string): Template {
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
    name: flat.name ?? "untitled",
    category: flat.category,
    prompt: flat.prompt,
    schedule: flat.schedule,
    inputs: lists.inputs ?? [],
    integrations: lists.integrations ?? [],
  };
}

export function loadTemplate(file: string): Template {
  return parseTemplate(readFileSync(file, "utf8"));
}

/** Substitute {placeholders}; every declared input must be supplied. */
export function renderTemplate(tpl: Template, inputs: Record<string, string>): string {
  const missing = tpl.inputs.filter((k) => inputs[k] === undefined);
  if (missing.length) throw new Error(`template needs --input for: ${missing.join(", ")}`);
  return tpl.prompt.replace(/\{([A-Za-z0-9_-]+)\}/g, (whole, key) => inputs[key] ?? whole);
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}
