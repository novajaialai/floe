import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
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
    const line = row.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(",") + "\n";
    appendFileSync(this.safe(name), line);
  }
}
