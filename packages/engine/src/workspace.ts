import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * Reserved accounting file inside every workspace: one JSONL record per tool
 * write. It is the receipts ledger — the disk may contain only what the tools
 * receipted, so a file that "appeared" without a record here was written by
 * something other than Floe (a foreign/backend write) and gets no credit.
 */
const MANIFEST = ".floe-manifest.jsonl";

/** Who performed a write: which tool, on behalf of which agent. */
export interface WriteMeta {
  tool?: string;
  agent?: string;
}

export interface WriteRecord extends WriteMeta {
  ts: number;
  file: string;
  /** Bytes this write appended/wrote. */
  bytes: number;
  /** File size on disk immediately after the write. */
  sizeAfter: number;
}

/**
 * Per-task virtual filesystem: notes, partial results, CSVs. This is what
 * lets long tasks survive context limits and crashes — durable state lives
 * here, not in the model's context.
 */
export class Workspace {
  readonly dir: string;
  /** Fired on every receipted write — the engine's write-accounting seam. */
  onWrite?: (rec: WriteRecord) => void;

  constructor(rootDir: string, taskId: string) {
    this.dir = join(rootDir, taskId);
    mkdirSync(this.dir, { recursive: true });
  }

  private safe(name: string): string {
    const p = resolve(this.dir, name);
    if (!p.startsWith(resolve(this.dir))) throw new Error("Path escapes workspace");
    if (basename(p).toLowerCase() === MANIFEST) throw new Error("That file name is reserved");
    return p;
  }

  /** Append the write receipt (code-measured, never model-claimed). */
  private record(name: string, bytes: number, meta?: WriteMeta): void {
    let sizeAfter = -1;
    try {
      sizeAfter = statSync(this.safe(name)).size;
    } catch {
      /* file vanished between write and stat — record it anyway */
    }
    const rec: WriteRecord = { ts: Date.now(), file: name, bytes, sizeAfter, ...meta };
    try {
      appendFileSync(join(this.dir, MANIFEST), JSON.stringify(rec) + "\n");
    } catch {
      /* the receipt must never break the write itself */
    }
    this.onWrite?.(rec);
  }

  write(name: string, content: string, meta?: WriteMeta): string {
    writeFileSync(this.safe(name), content);
    this.record(name, Buffer.byteLength(content), meta);
    return name;
  }

  append(name: string, content: string, meta?: WriteMeta): string {
    appendFileSync(this.safe(name), content);
    this.record(name, Buffer.byteLength(content), meta);
    return name;
  }

  read(name: string): string {
    return readFileSync(this.safe(name), "utf8");
  }

  list(): string[] {
    return readdirSync(this.dir).filter((f) => f.toLowerCase() !== MANIFEST);
  }

  appendCsvRow(name: string, row: string[], meta?: WriteMeta): void {
    const line = csvLine(row);
    appendFileSync(this.safe(name), line);
    this.record(name, Buffer.byteLength(line), meta);
  }

  exists(name: string): boolean {
    return existsSync(this.safe(name));
  }

  /** Every receipted write in this workspace, oldest first. */
  readManifest(): WriteRecord[] {
    const p = join(this.dir, MANIFEST);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as WriteRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is WriteRecord => r !== null);
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
        else if (c !== "\r") cell += c;
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
   *
   * Empty-key skips are counted separately from duplicate skips: a run of
   * empty keys means the key column's mapping is extracting NOTHING — a much
   * harder failure than re-seeing known rows, and it must not be softened
   * into "skipped as duplicate".
   */
  appendCsvDeduped(
    name: string,
    columns: string[],
    rows: string[][],
    keyColumn: string,
    meta?: WriteMeta,
  ): { added: number; dupSkipped: number; emptyKeySkipped: number; total: number } {
    const keyIdx = Math.max(0, columns.indexOf(keyColumn));
    const existing = this.readCsv(name);
    const isNew = existing.length === 0;
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const seen = new Set(existing.slice(1).map((r) => norm(r[keyIdx] ?? "")));
    let out = isNew ? csvLine(columns) : "";
    let added = 0, dupSkipped = 0, emptyKeySkipped = 0;
    for (const r of rows) {
      const k = norm(r[keyIdx] ?? "");
      if (!k) { emptyKeySkipped++; continue; }
      if (seen.has(k)) { dupSkipped++; continue; }
      seen.add(k);
      out += csvLine(r);
      added++;
    }
    if (out) {
      appendFileSync(this.safe(name), out);
      this.record(name, Buffer.byteLength(out), meta);
    }
    return { added, dupSkipped, emptyKeySkipped, total: Math.max(0, existing.length - 1) + added };
  }
}

function csvLine(row: string[]): string {
  return row.map((c) => `"${String(c ?? "").replaceAll('"', '""')}"`).join(",") + "\n";
}
