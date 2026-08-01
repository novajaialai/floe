import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Per-task virtual filesystem: notes, partial results, CSVs. This is what
 * lets long tasks survive context limits and crashes — durable state lives
 * here, not in the model's context.
 */
export class Workspace {
  readonly dir: string;

  constructor(rootDir: string, taskId: string) {
    this.dir = join(rootDir, taskId);
    mkdirSync(this.dir, { recursive: true });
  }

  private safe(name: string): string {
    const p = resolve(this.dir, name);
    if (!p.startsWith(resolve(this.dir))) throw new Error("Path escapes workspace");
    return p;
  }

  write(name: string, content: string): string {
    writeFileSync(this.safe(name), content);
    return name;
  }

  append(name: string, content: string): string {
    appendFileSync(this.safe(name), content);
    return name;
  }

  read(name: string): string {
    return readFileSync(this.safe(name), "utf8");
  }

  list(): string[] {
    return readdirSync(this.dir);
  }

  appendCsvRow(name: string, row: string[]): void {
    appendFileSync(this.safe(name), csvLine(row));
  }

  exists(name: string): boolean {
    return existsSync(this.safe(name));
  }

  /** Parse a CSV written by this class (RFC4180-ish: quoted fields, doubled quotes). */
  readCsv(name: string): string[][] {
    if (!this.exists(name)) return [];
    const src = readFileSync(this.safe(name), "utf8");
    const rows: string[][] = [];
    let row: string[] = [], cell = "", quoted = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c !== "\r") cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /**
   * Append rows to a CSV, code-side deduped against everything already in the
   * file (keyed on one column). Writes the header on first use. This is what
   * makes multi-page scraping idempotent and resumable.
   */
  appendCsvDeduped(
    name: string,
    columns: string[],
    rows: string[][],
    keyColumn: string,
  ): { added: number; skipped: number; total: number } {
    const keyIdx = Math.max(0, columns.indexOf(keyColumn));
    const existing = this.readCsv(name);
    const isNew = existing.length === 0;
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const seen = new Set(existing.slice(1).map((r) => norm(r[keyIdx] ?? "")));
    let out = isNew ? csvLine(columns) : "";
    let added = 0, skipped = 0;
    for (const r of rows) {
      const k = norm(r[keyIdx] ?? "");
      if (!k || seen.has(k)) { skipped++; continue; }
      seen.add(k);
      out += csvLine(r);
      added++;
    }
    if (out) appendFileSync(this.safe(name), out);
    return { added, skipped, total: Math.max(0, existing.length - 1) + added };
  }
}

function csvLine(row: string[]): string {
  return row.map((c) => `"${String(c ?? "").replaceAll('"', '""')}"`).join(",") + "\n";
}
