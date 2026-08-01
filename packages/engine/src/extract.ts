/**
 * Code-side structured extraction. Detects the dominant repeated structure on a
 * page (a regular <table>, or a repeated block of sibling elements — listing
 * cards, feed items, search results) and returns it as rows, with no model call.
 *
 * The key heuristic is *record segmentation by marker*: a repeated element
 * (same tag+class, same parent, >=3 occurrences) marks the start of a record,
 * and the record runs until the next marker. That captures multi-element rows
 * like Hacker News (title <tr> + subtext <tr>) which naive per-element
 * extraction splits in half.
 */

export interface ExtractedRow {
  cells: string[];
  links: { text: string; href: string }[];
  text: string;
}

export interface ExtractedTable {
  kind: "table" | "repeated" | "none";
  source: string;
  columns?: string[];
  rows: ExtractedRow[];
}

export const EXTRACT_SCRIPT = `(() => {
  const MAX_ROWS = 300, MAX_CELLS = 14, CELL_CHARS = 220;
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const lines = (el) => (el.innerText || '').split('\\n').map(clean).filter(Boolean);
  const abs = (h) => { try { return new URL(h, location.href).href; } catch { return h; } };
  const linksOf = (els) => {
    const out = [];
    for (const el of els) for (const a of el.querySelectorAll('a[href]')) {
      const t = clean(a.innerText);
      if (t) out.push({ text: t.slice(0, 160), href: abs(a.getAttribute('href')).slice(0, 400) });
      if (out.length >= 8) return out;
    }
    return out;
  };
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

  // ---- 1. regular tables -------------------------------------------------
  let best = null;
  for (const t of document.querySelectorAll('table')) {
    const rows = Array.from(t.rows);
    if (rows.length < 3) continue;
    const counts = rows.map((r) => r.cells.length);
    const mode = counts.sort((a, b) => counts.filter(c => c === b).length - counts.filter(c => c === a).length)[0];
    if (mode < 2) continue;
    const regular = rows.filter((r) => r.cells.length === mode).length / rows.length;
    if (regular < 0.6) continue; // layout table / irregular list — use the repeated-block path
    const body = rows.filter((r) => r.cells.length === mode);
    const headerRow = body[0].querySelectorAll('th').length >= mode - 1 ? body[0] : null;
    const data = headerRow ? body.slice(1) : body;
    if (!data.length) continue;
    const score = data.length * mode;
    if (!best || score > best.score) best = {
      score, kind: 'table',
      source: 'table' + (t.className ? '.' + t.className.split(/\\s+/).join('.') : ''),
      columns: headerRow ? Array.from(headerRow.cells).map((c) => clean(c.innerText).slice(0, 60)) : undefined,
      rows: data.slice(0, MAX_ROWS).map((r) => ({
        cells: Array.from(r.cells).slice(0, MAX_CELLS).map((c) => clean(c.innerText).slice(0, CELL_CHARS)),
        links: linksOf([r]),
        text: clean(r.innerText).slice(0, 1200),
      })),
    };
  }

  // ---- 2. repeated sibling blocks ---------------------------------------
  const SKIP = new Set(['HTML','BODY','HEAD','SCRIPT','STYLE','BR','OPTION','PATH','SVG','META','LINK','NOSCRIPT']);
  const groups = new Map();
  let order = 0;
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (SKIP.has(el.tagName) || !el.parentElement) continue;
    const cls = (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean).sort().slice(0, 4).join('.');
    const key = el.tagName + '|' + cls;
    let byParent = groups.get(key);
    if (!byParent) groups.set(key, (byParent = new Map()));
    let g = byParent.get(el.parentElement);
    if (!g) byParent.set(el.parentElement, (g = { els: [], first: order }));
    g.els.push(el);
    order++;
  }

  let bestRep = null;
  for (const [key, byParent] of groups) for (const [parent, g] of byParent) {
    if (g.els.length < 3) continue;
    const kids = Array.from(parent.children);
    const idx = g.els.map((e) => kids.indexOf(e));
    const spans = [];
    for (let i = 1; i < idx.length; i++) spans.push(idx[i] - idx[i - 1]);
    const span = median(spans) || 1;
    const recs = idx.map((start, i) => kids.slice(start, i + 1 < idx.length ? idx[i + 1] : Math.min(kids.length, start + span)));
    const texts = recs.map((r) => r.map((e) => clean(e.innerText)).join(' ').trim());
    const med = median(texts.map((t) => t.length));
    if (med < 20) continue;
    const score = texts.length * Math.min(med, 200);
    // tie-break within 20%: prefer the group that appears earliest in the document
    if (!bestRep || score > bestRep.score * 1.2 || (score > bestRep.score * 0.8 && g.first < bestRep.first)) {
      bestRep = {
        score, first: g.first, kind: 'repeated', source: key.replace('|', '.').replace(/\\.$/, ''),
        rows: recs.slice(0, MAX_ROWS).map((r) => ({
          cells: r.flatMap((e) => lines(e)).slice(0, MAX_CELLS).map((c) => c.slice(0, CELL_CHARS)),
          links: linksOf(r),
          text: r.map((e) => clean(e.innerText)).join(' ').slice(0, 1200),
        })),
      };
    }
  }

  // A regular table is a stronger signal than any card heuristic, so it wins
  // unless the repeated block covers substantially more records (i.e. the table
  // was some small sidebar and the real content is a card list).
  if (bestRep && (!best || bestRep.rows.length > best.rows.length * 2)) best = bestRep;
  if (!best) return { kind: 'none', source: '', rows: [] };
  return { kind: best.kind, source: best.source, columns: best.columns, rows: best.rows };
})()`;

/** Finds and marks the pagination control, so the caller can click it via CDP. */
export const FIND_NEXT_SCRIPT = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const RE = /^(more|next|next page|next \\u203a|older|load more|show more|view more|\\u00bb|\\u203a|>|>>|\\u2192)$/i;
  document.querySelectorAll('[data-floe-next]').forEach((e) => e.removeAttribute('data-floe-next'));
  const cands = Array.from(document.querySelectorAll('a[rel="next"], a[href], button, [role="button"]'));
  const visible = cands.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });
  const scored = [];
  for (const el of visible) {
    const t = clean(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title'));
    let s = 0;
    if (el.getAttribute('rel') === 'next') s = 3;
    else if (RE.test(t)) s = 2;
    else if (/^(next|more|load more|show more)\\b/i.test(t) && t.length < 24) s = 1;
    if (s) scored.push({ el, s });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.s - a.s);
  const el = scored[0].el;
  if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return null;
  el.setAttribute('data-floe-next', '1');
  return { text: clean(el.innerText).slice(0, 60), href: el.getAttribute('href') || '' };
})()`;
