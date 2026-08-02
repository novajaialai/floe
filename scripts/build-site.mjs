#!/usr/bin/env node
/**
 * Builds the Floe site into site/dist — zero dependencies, no CDN assets, no
 * framework. The template pages are rendered from templates/*.yaml (the same
 * source the CLI and the in-app gallery read) and the landing copy is lifted
 * out of README.md, so the site cannot drift from the product.
 *
 *   node scripts/build-site.mjs [--out <dir>]
 *
 * It finishes by walking every generated page and resolving every internal
 * href/src against the output tree — a broken link fails the build.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv.includes("--out")
  ? resolve(process.argv[process.argv.indexOf("--out") + 1])
  : join(ROOT, "site", "dist");
const ENGINE = join(ROOT, "packages/engine/dist/templates.js");
if (!existsSync(ENGINE)) {
  console.error(`engine not built (${ENGINE}) — run: npm run build`);
  process.exit(1);
}
const { listTemplates, CATEGORIES } = await import(ENGINE);

const templates = listTemplates(join(ROOT, "templates"));
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

/* ── README extraction ─────────────────────────────────────────────────── */

/** The text of a `## Heading` section, without the heading itself. */
function section(title) {
  const re = new RegExp(`^##+ ${title}\\s*$([\\s\\S]*?)(?=^## |\\Z)`, "m");
  return (re.exec(readme)?.[1] ?? "").trim();
}
/** The first fenced code block inside a chunk of markdown. */
function firstFence(md) {
  return /```[a-z]*\n([\s\S]*?)```/.exec(md)?.[1]?.trimEnd() ?? "";
}
const tagline = readme.split("\n").find((l) => l.startsWith("**An open-source"))?.replace(/\*\*/g, "") ?? "";
const pitch = (readme.split("\n").find((l) => l.startsWith("Floe is an open replication")) ?? "").trim();
const quickstart = firstFence(section("Quickstart"));
const version = /^## Status: (v[\d.]+)/m.exec(readme)?.[1] ?? "v0";
/** "Working today" bullets — the honest feature list, straight from the README. */
const features = readme
  .split("\n")
  .slice(readme.split("\n").findIndex((l) => l.startsWith("Working today:")) + 1)
  .filter((l) => l.startsWith("- "))
  .slice(0, 12)
  .map((l) => l.replace(/^- /, ""));

/* ── tiny helpers ──────────────────────────────────────────────────────── */

const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** Inline markdown → HTML: `code`, **bold**, [text](url). Nothing more. */
const inline = (s = "") =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

function page({ title, description, body, depth = 0, active = "" }) {
  const up = "../".repeat(depth) || "./";
  const nav = [
    ["", "Floe"],
    ["templates/", "Templates"],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="stylesheet" href="${up}style.css">
<link rel="icon" href="${up}favicon.svg" type="image/svg+xml">
</head>
<body>
<header class="top">
  <a class="brand" href="${up}">
    <svg viewBox="0 0 40 40" width="22" height="22" aria-hidden="true">
      <path d="M20 3 L35 12 L35 28 L20 37 L5 28 L5 12 Z" fill="none" stroke="currentColor" stroke-width="2.2"/>
      <path d="M20 12 L28 17 L28 25 L20 30 L12 25 L12 17 Z" fill="currentColor" opacity=".55"/>
    </svg>
    <span>floe</span>
  </a>
  <nav>
    ${nav.map(([href, label]) => `<a class="${active === href ? "on" : ""}" href="${up}${href}">${label}</a>`).join("\n    ")}
    <a href="https://github.com/novajaialai/floe">GitHub</a>
  </nav>
</header>
<main>
${body}
</main>
<footer>
  <span>Floe — MIT licensed. Runs on your machine, with your own model key.</span>
  <span><a href="https://github.com/novajaialai/floe">github.com/novajaialai/floe</a></span>
</footer>
</body>
</html>
`;
}

const write = (rel, html) => {
  const file = join(OUT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  return rel;
};

/* ── pages ─────────────────────────────────────────────────────────────── */

/** Screenshots used on the landing page (and the only ones copied into dist). */
const SHOTS = ["floe-app-running", "floe-app-templates", "floe-app-workflows"];

function landing() {
  const shots = SHOTS
    .filter((n) => existsSync(join(ROOT, "docs/screenshots", `${n}.jpg`)))
    .map((n) => `<figure><img src="img/${n}.jpg" alt="Floe ${n.replace("floe-app-", "")}" loading="lazy"></figure>`)
    .join("\n");
  const byCat = CATEGORIES.map(
    (c) =>
      `<a class="catcard" href="templates/#${c}"><span class="cat">${c}</span><span class="n">${
        templates.filter((t) => t.category === c).length
      }</span></a>`,
  ).join("\n");

  return page({
    title: "Floe — an open-source browser agent",
    description: tagline,
    active: "",
    body: `
<section class="hero">
  <p class="eyebrow">${esc(version)} · MIT</p>
  <h1>Tell a browser what to do.<br>Then go and do something else.</h1>
  <p class="lede">${inline(tagline)}</p>
  <p class="sub">${inline(pitch)}</p>
  <div class="cta">
    <a class="btn" href="templates/">Browse ${templates.length} templates</a>
    <a class="btn ghost" href="https://github.com/novajaialai/floe">Get the code</a>
  </div>
</section>

<section class="shots">
${shots}
</section>

<section class="split">
  <div>
    <h2>Quickstart</h2>
    <pre class="code"><code>${esc(quickstart)}</code></pre>
  </div>
  <div>
    <h2>Working today</h2>
    <ul class="feat">
      ${features.map((f) => `<li>${inline(f)}</li>`).join("\n      ")}
    </ul>
  </div>
</section>

<section>
  <h2>The template library</h2>
  <p class="lede small">Every template is a plain YAML file in <code>templates/</code>: a prompt, its inputs, and an optional schedule. The same file feeds the CLI, the in-app gallery and this site.</p>
  <div class="cats">
${byCat}
  </div>
</section>
`,
  });
}

function templatesIndex() {
  const cards = templates
    .map(
      (t) => `<a class="card" href="${t.id}.html" data-cat="${esc(t.category)}" data-text="${esc(
        (t.name + " " + (t.description ?? "") + " " + t.id).toLowerCase(),
      )}">
  <div class="cardtop"><span class="cat">${esc(t.category)}</span>${
        t.schedule ? `<span class="chip">${esc(t.schedule)}</span>` : ""
      }${t.requiresLogin.length ? '<span class="chip login">login</span>' : ""}</div>
  <h3>${esc(t.name)}</h3>
  <p>${esc(t.description ?? "")}</p>
  <div class="chips">${t.integrations
    .slice(0, 3)
    .map((i) => `<span class="chip dim">${esc(i)}</span>`)
    .join("")}</div>
</a>`,
    )
    .join("\n");

  const filters = ["all", ...CATEGORIES]
    .map(
      (c) =>
        `<button class="filter${c === "all" ? " on" : ""}" data-cat="${c}">${c} <span>${
          c === "all" ? templates.length : templates.filter((t) => t.category === c).length
        }</span></button>`,
    )
    .join("\n    ");

  return page({
    title: `Templates — Floe`,
    description: `${templates.length} ready-to-run browser-agent tasks across ${CATEGORIES.length} categories.`,
    depth: 1,
    active: "templates/",
    body: `
<section class="pagehead">
  <h1>Templates</h1>
  <p class="lede">${templates.length} ready-to-run tasks. Open one, fill in its inputs, and run it from the app or the CLI.</p>
  <input id="q" class="search" type="search" placeholder="search templates…" autocomplete="off">
  <div class="filters">
    ${filters}
  </div>
</section>
<div class="grid" id="grid">
${cards}
</div>
<p class="empty" id="empty" hidden>Nothing matches.</p>
<script>
(function () {
  var grid = document.getElementById("grid");
  var cards = [].slice.call(grid.children);
  var q = document.getElementById("q");
  var empty = document.getElementById("empty");
  var cat = "all";
  function apply() {
    var needle = q.value.trim().toLowerCase();
    var shown = 0;
    cards.forEach(function (c) {
      var ok = (cat === "all" || c.dataset.cat === cat) && (!needle || c.dataset.text.indexOf(needle) >= 0);
      c.hidden = !ok;
      if (ok) shown++;
    });
    empty.hidden = shown > 0;
  }
  document.querySelectorAll(".filter").forEach(function (b) {
    b.addEventListener("click", function () {
      cat = b.dataset.cat;
      document.querySelectorAll(".filter").forEach(function (x) { x.classList.toggle("on", x === b); });
      history.replaceState(null, "", cat === "all" ? location.pathname : "#" + cat);
      apply();
    });
  });
  q.addEventListener("input", apply);
  // Deep link: /templates/#sales lands pre-filtered.
  var hash = location.hash.replace("#", "");
  if (hash) {
    var b = document.querySelector('.filter[data-cat="' + hash + '"]');
    if (b) b.click();
  }
})();
</script>
`,
  });
}

function templatePage(t) {
  const cliInputs = t.inputs.map((i) => ` \\\n  --input ${i}="<${i}>"`).join("");
  const runCmd = `floe run --template ${t.id}${cliInputs}`;
  const saveCmd = `floe workflow save my-${t.id} --template ${t.id}${cliInputs}${
    t.schedule ? ` \\\n  --schedule "${t.schedule}"` : ""
  }`;
  const related = templates.filter((o) => o.category === t.category && o.id !== t.id).slice(0, 4);

  return page({
    title: `${t.name} — Floe template`,
    description: t.description ?? t.name,
    depth: 1,
    active: "templates/",
    body: `
<article class="tpl">
  <p class="crumb"><a href="./">← all templates</a></p>
  <div class="cardtop"><span class="cat">${esc(t.category)}</span>${
      t.schedule ? `<span class="chip">runs ${esc(t.schedule)}</span>` : ""
    }${
      t.requiresLogin.length
        ? `<span class="chip login">needs a logged-in profile: ${esc(t.requiresLogin.join(", "))}</span>`
        : ""
    }</div>
  <h1>${esc(t.name)}</h1>
  <p class="lede">${esc(t.description ?? "")}</p>
  <div class="chips">${t.integrations.map((i) => `<span class="chip dim">${esc(i)}</span>`).join("")}<span class="chip dim">${esc(
      t.id,
    )}</span></div>

  <h2>The prompt<button class="copy" data-copy="prompt">copy</button></h2>
  <pre class="code" id="prompt"><code>${esc(t.prompt)}</code></pre>

  ${
    t.inputs.length
      ? `<h2>Inputs</h2>
  <ul class="inputs">${t.inputs.map((i) => `<li><code>{${esc(i)}}</code></li>`).join("")}</ul>`
      : `<p class="note">This template takes no inputs — run it as it is.</p>`
  }

  <h2>Run it with Floe<button class="copy" data-copy="run">copy</button></h2>
  <pre class="code" id="run"><code>${esc(runCmd)}</code></pre>

  <h2>Or save it on a schedule<button class="copy" data-copy="save">copy</button></h2>
  <pre class="code" id="save"><code>${esc(saveCmd)}</code></pre>
  <p class="note">No CLI? The same template is in the app's Templates tab: fill the inputs, then <em>Run now</em> or <em>Save as workflow</em>.</p>

  ${
    related.length
      ? `<h2>More ${esc(t.category)} templates</h2>
  <ul class="rel">${related.map((r) => `<li><a href="${r.id}.html">${esc(r.name)}</a></li>`).join("")}</ul>`
      : ""
  }
</article>
<script>
document.querySelectorAll(".copy").forEach(function (b) {
  b.addEventListener("click", function () {
    var text = document.getElementById(b.dataset.copy).innerText;
    navigator.clipboard.writeText(text).then(function () {
      b.textContent = "copied";
      setTimeout(function () { b.textContent = "copy"; }, 1400);
    });
  });
});
</script>
`,
  });
}

/* ── style ─────────────────────────────────────────────────────────────── */

const CSS = `/* Floe site — hand-rolled. Paper by default, glacial night when asked. */
:root {
  --bg: #fbfcfd; --panel: #fff; --panel-2: #f2f6f8; --line: #dde5ea; --line-soft: #e9eff3;
  --text: #10181f; --muted: #566674; --dim: #8a9aa8; --ice: #0d7c8f; --ice-soft: #e2f3f6;
  --warn: #9a6b12; --shadow: 0 1px 2px rgba(16,24,31,.05), 0 8px 24px -16px rgba(16,24,31,.25);
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Helvetica, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #070a0e; --panel: #0c1218; --panel-2: #111a22; --line: #1b2732; --line-soft: #141d26;
    --text: #dbe6ef; --muted: #8698a8; --dim: #5b6b7a; --ice: #5cd2e6; --ice-soft: #10242c;
    --warn: #e8b04b; --shadow: 0 1px 2px rgba(0,0,0,.5), 0 16px 40px -24px rgba(0,0,0,.9);
  }
}
* { box-sizing: border-box; }
/* .card sets display:flex, which beats the [hidden] attribute's default
   display:none — without this the category filter highlights but hides nothing. */
[hidden] { display: none !important; }
body {
  margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 var(--sans);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  body { background: radial-gradient(1100px 520px at 82% -12%, #0f2029 0%, transparent 62%), var(--bg); }
}
a { color: var(--ice); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-family: var(--mono); font-size: .92em; }
main { max-width: 1040px; margin: 0 auto; padding: 0 24px 80px; }
h1 { font-size: 34px; line-height: 1.15; letter-spacing: -.02em; margin: 12px 0 10px; }
h2 {
  font-size: 12px; letter-spacing: .18em; text-transform: uppercase; color: var(--muted);
  margin: 42px 0 14px; display: flex; align-items: center; gap: 12px;
}
h3 { font-size: 16px; margin: 0; letter-spacing: -.01em; }

.top {
  display: flex; align-items: center; justify-content: space-between; gap: 20px;
  max-width: 1040px; margin: 0 auto; padding: 20px 24px;
}
.brand { display: flex; align-items: center; gap: 9px; color: var(--ice); font-family: var(--mono); letter-spacing: .2em; }
.brand:hover { text-decoration: none; }
.top nav { display: flex; gap: 20px; font-size: 13.5px; }
.top nav a { color: var(--muted); }
.top nav a.on, .top nav a:hover { color: var(--text); text-decoration: none; }

.hero { padding: 44px 0 12px; max-width: 760px; }
.eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: var(--ice); margin: 0; }
.lede { font-size: 17px; color: var(--text); margin: 0 0 10px; }
.lede.small { font-size: 15px; color: var(--muted); }
.sub { color: var(--muted); margin: 0; }
.cta { display: flex; gap: 12px; margin: 26px 0 8px; flex-wrap: wrap; }
.btn {
  background: var(--ice); color: var(--bg); border-radius: 9px; padding: 11px 20px;
  font-weight: 600; font-size: 14px;
}
.btn:hover { text-decoration: none; filter: brightness(1.08); }
.btn.ghost { background: none; border: 1px solid var(--line); color: var(--text); }
.btn.ghost:hover { border-color: var(--ice); color: var(--ice); }

.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin: 34px 0 8px; }
.shots figure { margin: 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--panel); box-shadow: var(--shadow); }
.shots img { display: block; width: 100%; height: auto; }

.split { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 28px; }
.feat { margin: 0; padding-left: 18px; color: var(--muted); font-size: 14px; }
.feat li { margin-bottom: 7px; }
.feat strong { color: var(--text); }

.code {
  border: 1px solid var(--line); border-left: 2px solid var(--ice); border-radius: 10px;
  background: var(--panel); padding: 14px 16px; margin: 0; overflow-x: auto;
  font-family: var(--mono); font-size: 12.5px; line-height: 1.65; color: var(--text);
  white-space: pre-wrap; word-break: break-word; box-shadow: var(--shadow);
}
.copy {
  margin-left: auto; background: var(--panel); border: 1px solid var(--line); color: var(--muted);
  border-radius: 6px; padding: 3px 10px; font: inherit; font-size: 10px; letter-spacing: .12em; cursor: pointer;
}
.copy:hover { border-color: var(--ice); color: var(--ice); }

.cats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.catcard {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; background: var(--panel); color: var(--text);
}
.catcard:hover { border-color: var(--ice); text-decoration: none; }
.catcard .n { font-family: var(--mono); font-size: 12px; color: var(--dim); }

.pagehead { padding: 30px 0 6px; }
.search {
  width: 100%; max-width: 380px; margin: 14px 0 16px; background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: 9px; padding: 10px 14px; font: inherit; font-size: 14px; outline: none;
}
.search:focus { border-color: var(--ice); }
.filters { display: flex; flex-wrap: wrap; gap: 7px; }
.filter {
  background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 999px;
  padding: 6px 13px; font: inherit; font-size: 12.5px; cursor: pointer; display: inline-flex; gap: 7px; align-items: center;
}
.filter span { font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.filter:hover { border-color: var(--ice); color: var(--text); }
.filter.on { background: var(--ice); border-color: var(--ice); color: var(--bg); font-weight: 600; }
.filter.on span { color: var(--bg); opacity: .7; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 13px; margin-top: 22px; }
.card {
  display: flex; flex-direction: column; gap: 9px; border: 1px solid var(--line); border-radius: 12px;
  background: var(--panel); padding: 15px 17px 14px; color: var(--text); box-shadow: var(--shadow);
  transition: border-color .15s, transform .15s;
}
.card:hover { border-color: var(--ice); transform: translateY(-2px); text-decoration: none; }
.card p { margin: 0; color: var(--muted); font-size: 13.5px; }
.card .chips { margin-top: auto; }
.cardtop { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cat { font-family: var(--mono); font-size: 10px; letter-spacing: .18em; text-transform: uppercase; color: var(--ice); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  font-family: var(--mono); font-size: 10.5px; padding: 2px 9px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--muted); background: var(--panel-2);
}
.chip.dim { color: var(--dim); }
.chip.login { color: var(--warn); border-color: currentColor; background: none; }
.empty { color: var(--dim); font-family: var(--mono); font-size: 13px; }

.tpl { max-width: 800px; padding-top: 24px; }
.crumb { font-family: var(--mono); font-size: 12px; margin: 0 0 18px; }
.inputs { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; margin: 0; }
.inputs code { background: var(--ice-soft); color: var(--ice); padding: 4px 10px; border-radius: 6px; }
.note { color: var(--muted); font-size: 13.5px; }
.rel { padding-left: 18px; color: var(--muted); }

footer {
  border-top: 1px solid var(--line); margin-top: 40px; padding: 22px 24px 44px;
  max-width: 1040px; margin-left: auto; margin-right: auto;
  display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  color: var(--dim); font-size: 12.5px;
}
@media (max-width: 640px) {
  h1 { font-size: 27px; }
  main { padding: 0 16px 60px; }
  .top { padding: 16px; }
}
`;

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
<path d="M20 3 L35 12 L35 28 L20 37 L5 28 L5 12 Z" fill="none" stroke="#0d7c8f" stroke-width="2.6"/>
<path d="M20 12 L28 17 L28 25 L20 30 L12 25 L12 17 Z" fill="#0d7c8f" opacity=".55"/>
</svg>
`;

/* ── build ─────────────────────────────────────────────────────────────── */

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const written = [];
written.push(write("style.css", CSS));
written.push(write("favicon.svg", FAVICON));
written.push(write("index.html", landing()));
written.push(write("templates/index.html", templatesIndex()));
for (const t of templates) written.push(write(`templates/${t.id}.html`, templatePage(t)));

// Only the screenshots the pages actually reference — the site should not
// ship every shot in docs/.
const shotsDir = join(ROOT, "docs", "screenshots");
mkdirSync(join(OUT, "img"), { recursive: true });
for (const n of SHOTS) {
  const src = join(shotsDir, `${n}.jpg`);
  if (existsSync(src)) cpSync(src, join(OUT, "img", `${n}.jpg`));
}

/* ── link check: every internal href/src must resolve on disk ──────────── */

const pages = written.filter((f) => f.endsWith(".html"));
const broken = [];
let checked = 0;
for (const rel of pages) {
  const html = readFileSync(join(OUT, rel), "utf8");
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const raw = m[1];
    if (/^(https?:|mailto:|#|data:)/.test(raw)) continue;
    checked++;
    const [path] = raw.split("#");
    if (!path) continue;
    let target = resolve(dirname(join(OUT, rel)), path);
    if (target.endsWith("/") || !path.includes(".")) target = join(target, "index.html");
    if (!existsSync(target)) broken.push(`${rel} → ${raw}`);
  }
}

console.log(`site → ${OUT}`);
console.log(`  ${pages.length} pages (1 landing, 1 index, ${templates.length} templates), ${checked} internal links checked`);
if (broken.length) {
  console.error(`\n${broken.length} broken internal link(s):`);
  for (const b of broken) console.error(`  ✗ ${b}`);
  process.exit(1);
}
console.log("  ✓ no broken internal links");
