/**
 * Google Sheets writer — pure helpers + in-page scripts (session 11).
 *
 * The tool (`sheets_write`) drives a real Google Sheets tab through the same
 * paths a user uses: the name box for cell jumps, clipboard TSV paste into
 * the grid, Ctrl+Home/End for navigation — no coordinate clicking. Every
 * receipt claim is re-read from the sheet after the write.
 *
 * Everything here is model-free: the cell math and TSV building are pure
 * functions, and the scripts are strings evaluated in the page (same pattern
 * as extract.ts). The smoke suite tests the pure half; the live behavior is
 * verified against a real sheet when the profile is logged in.
 */

export type SheetCell = string | number | boolean | null | undefined;

export interface CellRef {
  /** 1-based row. */
  row: number;
  /** 1-based column. */
  col: number;
}

/** "B3" -> {row:3, col:2}. 1-based both ways; throws on garbage. */
export function parseCellRef(ref: string): CellRef {
  const m = /^\s*([A-Za-z]+)(\d+)\s*$/.exec(ref);
  if (!m) throw new Error(`Bad cell reference "${ref}" — expected something like A1 or B3.`);
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = parseInt(m[2], 10);
  if (row < 1 || col < 1) throw new Error(`Bad cell reference "${ref}" — rows and columns are 1-based.`);
  return { row, col };
}

/** {row:3, col:2} -> "B3"; handles AA+ columns. */
export function cellRefToString(r: CellRef): string {
  let letters = "";
  let col = r.col;
  while (col > 0) {
    const rem = (col - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    col = Math.floor((col - 1) / 26);
  }
  return `${letters}${r.row}`;
}

/**
 * TSV with RFC-style quoting: a cell containing tab/newline/quote is wrapped
 * in quotes with inner quotes doubled. This is what Sheets expects on paste —
 * unquoted cells pass through verbatim, quoted ones survive as one cell.
 */
export function rowsToTsv(rows: SheetCell[][]): string {
  return rows
    .map((row) =>
      row
        .map((c) => {
          const s = c === null || c === undefined ? "" : String(c);
          return /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join("\t"),
    )
    .join("\n");
}

/** Bottom-right cell of a write starting at `start` covering rows x cols. */
export function expectedLastCell(start: CellRef, numRows: number, numCols: number): CellRef {
  return { row: start.row + numRows - 1, col: start.col + numCols - 1 };
}

/** Max column count across all rows (ragged input pads like Sheets does). */
export function maxRowWidth(rows: SheetCell[][]): number {
  return rows.reduce((w, r) => Math.max(w, r.length), 0);
}

/**
 * Validate user-supplied rows before they touch a real sheet. Returns an
 * error string or null. Cells must be scalar, and a cell may not contain a
 * tab or newline: pasted TSV would split it into extra rows/columns, i.e.
 * the sheet would silently disagree with the receipt.
 */
export function validateSheetRows(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length === 0) return "rows must be a non-empty array of arrays.";
  for (const [i, row] of rows.entries()) {
    if (!Array.isArray(row)) return `row ${i + 1} is not an array.`;
    for (const [j, cell] of row.entries()) {
      if (cell !== null && cell !== undefined && !["string", "number", "boolean"].includes(typeof cell))
        return `row ${i + 1} cell ${j + 1} is not a scalar (string/number/boolean).`;
      if (typeof cell === "string" && /[\t\n]/.test(cell))
        return `row ${i + 1} cell ${j + 1} contains a tab or newline — it would split into extra cells on paste. Replace or remove it first.`;
    }
  }
  return null;
}

/**
 * Page state probe: are we on a Sheets grid, and is the profile logged in?
 * The login wall is detected by URL (Google's accounts host) OR by a page
 * that has no grid and no name box but sign-in prose — the two shapes the
 * wall takes depending on how far the redirect got.
 */
export const SHEETS_STATE_SCRIPT = `(() => {
  const url = location.href;
  const grid = document.querySelector('.grid-container, [role="grid"], #t-sheet-container');
  const nameBox = document.querySelector('#nameBox, input[aria-label="Name box"], input[aria-label*="name box"]');
  const isSheet = /docs\\.google\\.com\\/spreadsheets/.test(url) || /sheets\\.new/.test(url);
  const loginWall = /accounts\\.google\\.com/.test(url) || (!grid && !nameBox && /sign\\s*in|not\\s*signed|choose an account/i.test((document.body && document.body.innerText || "").slice(0, 2000)));
  return { url, isSheet, gridReady: !!grid, loginWall };
})()`;

/** Read the value of a specific grid cell (row/col 1-based), or null if not rendered. */
export const SHEETS_READ_CELL_SCRIPT = `(row, col) => {
  const el = document.querySelector('.grid-container [data-row="' + row + '"][data-col="' + col + '"] .cell-content');
  if (!el) return null;
  return (el.innerText || el.textContent || "").trim();
}`;

/** Read the value of the currently active cell (after a name-box jump). */
export const SHEETS_READ_ACTIVE_SCRIPT = `() => {
  const el = document.querySelector('.grid-container .cell.is-active .cell-content');
  if (!el) return null;
  return (el.innerText || el.textContent || "").trim();
}`;

/** The name box's current text (the active cell reference, e.g. "B3"). */
export const SHEETS_NAMEBOX_SCRIPT = `() => {
  const el = document.querySelector('#nameBox, input[aria-label="Name box"], input[aria-label*="name box"]');
  return el ? (el.value || "").trim() : null;
}`;

/** Selector candidates for the name box, most specific first. */
export const NAMEBOX_SELECTOR = '#nameBox, input[aria-label="Name box"], input[aria-label*="name box"]';
