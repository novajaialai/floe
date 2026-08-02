#!/usr/bin/env node
/**
 * Lints templates/*.yaml — the source of truth behind the CLI, the in-app
 * gallery and the generated site. A bad template is only discovered at 7am
 * otherwise, so this runs in `npm test` and before every build of the site.
 *
 *   node scripts/lint-templates.mjs [dir]
 *
 * It deliberately imports the ENGINE's parser (not its own), so the lint
 * checks what Floe will actually load.
 */
import { readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, "templates");
const ENGINE = join(ROOT, "packages/engine/dist/templates.js");

if (!existsSync(ENGINE)) {
  console.error(`engine not built (${ENGINE}) — run: npm run build`);
  process.exit(1);
}
const { loadTemplate, promptPlaceholders, CATEGORIES } = await import(ENGINE);
const { parseCron } = await import(join(ROOT, "packages/engine/dist/cron.js"));

const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
if (!files.length) {
  console.error(`no templates in ${DIR}`);
  process.exit(1);
}

const problems = [];
const seenNames = new Map();
const byCategory = new Map();
const fail = (file, msg) => problems.push(`${file}: ${msg}`);

for (const file of files) {
  let tpl;
  try {
    tpl = loadTemplate(join(DIR, file));
  } catch (err) {
    fail(file, `unparseable — ${err.message}`);
    continue;
  }

  // Required fields.
  for (const field of ["name", "description", "prompt"]) {
    if (!tpl[field] || !String(tpl[field]).trim()) fail(file, `missing "${field}"`);
  }
  if (!tpl.category) fail(file, "missing \"category\"");
  else if (!CATEGORIES.includes(tpl.category)) fail(file, `category "${tpl.category}" not one of ${CATEGORIES.join(", ")}`);
  if (!tpl.integrations.length) fail(file, "integrations is empty (use [web] if it is just the open web)");
  if (tpl.description && tpl.description.length > 110) fail(file, `description is ${tpl.description.length} chars (max 110)`);
  if (tpl.prompt && tpl.prompt.length < 120) fail(file, "prompt is suspiciously short (<120 chars)");

  // Filename convention: <category>-<slug>.yaml keeps the dir self-sorting.
  if (tpl.category && !file.startsWith(`${tpl.category}-`))
    fail(file, `filename should start with "${tpl.category}-"`);

  // Unique display names, unique ids (ids are filenames, so collisions can't
  // happen on one dir — but a .yml/.yaml pair can, so check anyway).
  const key = tpl.name.toLowerCase();
  if (seenNames.has(key)) fail(file, `duplicate name "${tpl.name}" (also in ${seenNames.get(key)})`);
  seenNames.set(key, file);

  // Placeholders and inputs must be the same set, in both directions.
  const used = promptPlaceholders(tpl.prompt ?? "");
  for (const p of used) if (!tpl.inputs.includes(p)) fail(file, `prompt uses {${p}} but it is not in inputs`);
  for (const i of tpl.inputs) if (!used.includes(i)) fail(file, `input "${i}" is never used in the prompt`);
  for (const i of tpl.inputs) if (!/^[a-z][a-z0-9_]*$/.test(i)) fail(file, `input "${i}" should be lower_snake_case`);

  // A schedule that does not parse is a 7am failure, so reject it now.
  if (tpl.schedule) {
    try {
      parseCron(tpl.schedule);
    } catch (err) {
      fail(file, `bad cron "${tpl.schedule}" — ${err.message}`);
    }
  }

  if (tpl.category) byCategory.set(tpl.category, (byCategory.get(tpl.category) ?? 0) + 1);
}

// Coverage is a property of the shipped library, not of an arbitrary folder.
if (DIR === join(ROOT, "templates"))
  for (const c of CATEGORIES) if (!byCategory.get(c)) problems.push(`category "${c}" has no templates`);

const counts = CATEGORIES.map((c) => `${c} ${byCategory.get(c) ?? 0}`).join("  ");
if (problems.length) {
  console.error(`\n${problems.length} problem(s) in ${files.length} templates:\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("");
  process.exit(1);
}
console.log(`✓ ${files.length} templates OK  (${counts})`);
