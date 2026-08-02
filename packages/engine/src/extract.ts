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

  // ---- shadow-piercing walk (open roots, depth-capped) -------------------
  // Web-component sites (Reddit, LWC apps, consent widgets) render inside
  // open shadow roots that a flat querySelectorAll never reaches.
  const allEls = [];
  const walkAll = (root, depth) => {
    for (const el of root.querySelectorAll('*')) {
      allEls.push(el);
      if (el.shadowRoot && depth < 5) walkAll(el.shadowRoot, depth + 1);
    }
  };
  if (document.body) walkAll(document.body, 0);

  // ---- 1. regular tables -------------------------------------------------
  let best = null;
  for (const t of allEls) {
    if (t.tagName !== 'TABLE') continue;
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
  for (const el of allEls) {
    // Shadow-root children have no parentElement; the ShadowRoot itself works
    // as the grouping parent (it has .children like any element).
    const parent = el.parentElement || el.parentNode;
    if (SKIP.has(el.tagName) || !parent || !parent.children) continue;
    const cls = (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean).sort().slice(0, 4).join('.');
    const add = (key) => {
      let byParent = groups.get(key);
      if (!byParent) groups.set(key, (byParent = new Map()));
      let g = byParent.get(parent);
      if (!g) byParent.set(parent, (g = { els: [], first: order }));
      g.els.push(el);
    };
    add(el.tagName + '|' + cls);
    // Tag-only candidate too: per-state class variants ('item read' vs 'item
    // unread', A/B classes) fragment the classed groups and undercount rows.
    // The scorer picks the winner, so precise classed groups still win ties.
    if (cls) add(el.tagName + '|');
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
    const recs0 = idx.map((start, i) => kids.slice(start, i + 1 < idx.length ? idx[i + 1] : Math.min(kids.length, start + span)));
    const texts0 = recs0.map((r) => r.map((e) => clean(e.innerText)).join(' ').trim());
    // Drop empty records (spacer/divider members): they are never data, and a
    // tag-only group padded with them must not outscore a real marker group.
    const recs = [], texts = [];
    for (let i = 0; i < recs0.length; i++) if (texts0[i].length >= 3) { recs.push(recs0[i]); texts.push(texts0[i]); }
    if (recs.length < 3) continue;
    const med = median(texts.map((t) => t.length));
    if (med < 20) continue;
    const score = texts.length * Math.min(med, 200);
    const tagOnly = key.endsWith('|');
    // tie-break within 20%: prefer the group that appears earliest in the
    // document; on the same first element, a classed (more specific) group
    // beats the synthetic tag-only merge — marker segmentation stays intact
    // (HN title+subtext) unless merging clearly adds coverage.
    if (!bestRep || score > bestRep.score * 1.2
      || (score > bestRep.score * 0.8 && g.first < bestRep.first)
      || (score > bestRep.score * 0.8 && g.first === bestRep.first && bestRep.tagOnly && !tagOnly)) {
      bestRep = {
        score, first: g.first, tagOnly, kind: 'repeated', source: key.replace('|', '.').replace(/\\.$/, ''),
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
  // Shadow-piercing walk, same reason as the extractor: pagination controls on
  // web-component sites live inside open shadow roots.
  const all = [];
  const walkAll = (root, depth) => {
    for (const el of root.querySelectorAll('*')) {
      all.push(el);
      if (el.shadowRoot && depth < 5) walkAll(el.shadowRoot, depth + 1);
    }
  };
  walkAll(document, 0);
  for (const e of all) if (e.hasAttribute('data-floe-next')) e.removeAttribute('data-floe-next');
  const cands = all.filter((el) => el.matches('a[rel="next"], a[href], button, [role="button"]'));
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
  // Numbered-only pagination ("1 2 3 4" with no Next link): the link labelled
  // current+1, where "current" is a numeric marker that is not itself a plain
  // link (or carries aria-current). Scores below rel=next and exact matches.
  const numOf = (el) => { const t = clean(el.innerText); return /^\\d{1,4}$/.test(t) ? parseInt(t, 10) : null; };
  const numLinks = visible.filter((el) => el.tagName === 'A' && numOf(el) !== null);
  if (numLinks.length >= 2) {
    const containers = new Set();
    for (const l of numLinks) {
      if (l.parentElement) containers.add(l.parentElement);
      if (l.parentElement && l.parentElement.parentElement) containers.add(l.parentElement.parentElement);
    }
    outer: for (const c of containers) {
      let cur = null;
      for (const el of c.querySelectorAll('*')) {
        if (el.childElementCount) continue;
        const n = numOf(el);
        if (n === null) continue;
        const a = el.closest('a');
        if (a && !a.getAttribute('aria-current')) continue; // a plain link is a destination, not the current page
        cur = n;
      }
      if (cur === null) continue;
      for (const l of numLinks) if (numOf(l) === cur + 1 && c.contains(l)) { scored.push({ el: l, s: 1.5 }); break outer; }
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.s - a.s);
  const el = scored[0].el;
  if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return null;
  el.setAttribute('data-floe-next', '1');
  return { text: clean(el.innerText).slice(0, 60), href: el.getAttribute('href') || '' };
})()`;
