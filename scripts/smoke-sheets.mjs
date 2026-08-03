#!/usr/bin/env node
/**
 * Model-free smoke for the session-11 Sheets writer: cell-reference math,
 * TSV building, range computation, and row validation. These are the pure
 * halves of sheets_write — no browser, no LLM, no Google account.
 * Run: node scripts/smoke-sheets.mjs
 */
import {
  cellRefToString,
  expectedLastCell,
  maxRowWidth,
  parseCellRef,
  rowsToTsv,
  validateSheetRows,
} from "../packages/engine/dist/sheets.js";

let failures = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "ok " : "FAIL"} ${name}${cond ? "" : " — " + extra}`);
  if (!cond) failures++;
};

// --- cell reference math --------------------------------------------------
t('parseCellRef("A1")', JSON.stringify(parseCellRef("A1")) === '{"row":1,"col":1}');
t('parseCellRef("B3")', JSON.stringify(parseCellRef("B3")) === '{"row":3,"col":2}');
t('parseCellRef("AA10")', JSON.stringify(parseCellRef("AA10")) === '{"row":10,"col":27}');
t('parseCellRef lowercase "b3"', JSON.stringify(parseCellRef("b3")) === '{"row":3,"col":2}');
t("parseCellRef throws on garbage", (() => { try { parseCellRef("1A"); return false; } catch { return true; } })());
t("parseCellRef throws on empty", (() => { try { parseCellRef(""); return false; } catch { return true; } })());

t("cellRefToString A1", cellRefToString({ row: 1, col: 1 }) === "A1");
t("cellRefToString B3", cellRefToString({ row: 3, col: 2 }) === "B3");
t("cellRefToString AA10", cellRefToString({ row: 10, col: 27 }) === "AA10");
t("cellRefToString wraps past Z", cellRefToString({ row: 1, col: 28 }) === "AB1");
t("round trip 50 random refs", (() => {
  for (let i = 0; i < 50; i++) {
    const row = 1 + Math.floor(Math.random() * 9000);
    const col = 1 + Math.floor(Math.random() * 702); // A..ZZ
    if (cellRefToString(parseCellRef(cellRefToString({ row, col }))) !== cellRefToString({ row, col })) return false;
  }
  return true;
})());

// --- TSV building ---------------------------------------------------------
t("plain rows to TSV", rowsToTsv([["a", "b"], ["c", "d"]]) === "a\tb\nc\td");
t("numbers stringified", rowsToTsv([[1, 2.5, true]]) === "1\t2.5\ttrue");
t("null/undefined become empty", rowsToTsv([[null, undefined, "x"]]) === "\t\tx");
t("cell with tab is quoted", rowsToTsv([["a\tb"]]) === '"a\tb"');
t("cell with newline is quoted", rowsToTsv([["a\nb"]]) === '"a\nb"');
t("quote doubled inside quoted cell", rowsToTsv([['say "hi"']]) === '"say ""hi"""');
t("quoted and plain mix", rowsToTsv([["plain", 'q"q', "ta\tb"]]) === 'plain\t"q""q"\t"ta\tb"');

// --- range math -----------------------------------------------------------
t("expectedLastCell from A1", JSON.stringify(expectedLastCell({ row: 1, col: 1 }, 3, 2)) === '{"row":3,"col":2}');
t("expectedLastCell offset start", JSON.stringify(expectedLastCell({ row: 5, col: 2 }, 2, 3)) === '{"row":6,"col":4}');
t("maxRowWidth pads ragged", maxRowWidth([["a"], ["b", "c", "d"]]) === 3);
t("maxRowWidth single", maxRowWidth([["x"]]) === 1);

// --- validation -----------------------------------------------------------
t("valid rows pass", validateSheetRows([["a", 1], ["b", 2]]) === null);
t("empty array rejected", validateSheetRows([]) !== null);
t("non-array rejected", validateSheetRows("nope") !== null);
t("non-array row rejected", validateSheetRows([["a"], "b"]) !== null);
t("object cell rejected", validateSheetRows([[{ x: 1 }]]) !== null);
t("tab in cell rejected", validateSheetRows([["a\tb"]]) !== null);
t("newline in cell rejected", validateSheetRows([["a\nb"]]) !== null);
t("boolean/null cells allowed", validateSheetRows([[true, null, "x"]]) === null);

console.log(failures ? `\n${failures} FAILURES` : "\nall sheets smokes passed");
process.exit(failures ? 1 : 0);
