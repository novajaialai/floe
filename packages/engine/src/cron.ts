/**
 * Minimal 5-field cron parser (no deps).
 *
 *   ┌── minute (0-59)
 *   │ ┌── hour (0-23)
 *   │ │ ┌── day of month (1-31)
 *   │ │ │ ┌── month (1-12)
 *   │ │ │ │ ┌── day of week (0-7, 0 and 7 = Sunday)
 *   * * * * *
 *
 * Each field supports: `*`, a number, `a-b` ranges, `*\/n` and `a-b/n` steps,
 * and comma lists of any of those. Times are evaluated in local time, which is
 * what a user means by "7am briefing".
 */

export interface CronExpr {
  source: string;
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** Both day fields restricted → cron's "either matches" rule applies. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

function parseField(spec: string, idx: number): Set<number> {
  const { name, min, max } = FIELDS[idx];
  const out = new Set<number>();
  if (spec === "") throw new Error(`cron: empty ${name} field`);
  for (const part of spec.split(",")) {
    const [rangePart, stepPart, ...rest] = part.split("/");
    if (rest.length) throw new Error(`cron: bad ${name} term "${part}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0)
        throw new Error(`cron: bad step in ${name} term "${part}"`);
      step = Number(stepPart);
    }
    let lo: number, hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(rangePart)) {
      lo = hi = Number(rangePart);
      if (stepPart !== undefined) hi = max; // "5/10" = every 10 from 5, like vixie cron
    } else {
      const m = /^(\d+)-(\d+)$/.exec(rangePart);
      if (!m) throw new Error(`cron: bad ${name} term "${part}"`);
      lo = Number(m[1]);
      hi = Number(m[2]);
      if (lo > hi) throw new Error(`cron: inverted range in ${name} term "${part}"`);
    }
    if (lo < min || hi > max) throw new Error(`cron: ${name} value out of range in "${part}" (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) out.add(idx === 4 && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(source: string): CronExpr {
  const parts = source.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error(`cron: expected 5 fields (min hour dom month dow), got ${parts.length} in "${source}"`);
  const sets = parts.map(parseField);
  return {
    source: source.trim(),
    minute: sets[0],
    hour: sets[1],
    dayOfMonth: sets[2],
    month: sets[3],
    dayOfWeek: sets[4],
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

/** Does this expression fire in the minute containing `d` (local time)? */
export function cronMatches(expr: CronExpr, d: Date): boolean {
  if (!expr.minute.has(d.getMinutes())) return false;
  if (!expr.hour.has(d.getHours())) return false;
  if (!expr.month.has(d.getMonth() + 1)) return false;
  return dayMatches(expr, d);
}

function dayMatches(expr: CronExpr, d: Date): boolean {
  const dom = expr.dayOfMonth.has(d.getDate());
  const dow = expr.dayOfWeek.has(d.getDay());
  if (expr.domRestricted && expr.dowRestricted) return dom || dow;
  if (expr.domRestricted) return dom;
  if (expr.dowRestricted) return dow;
  return true;
}

const MINUTE = 60_000;
const HORIZON_DAYS = 400;

/** First firing strictly after `from`, or undefined if none within ~400 days. */
export function nextRun(expr: CronExpr, from: Date = new Date()): Date | undefined {
  return scan(expr, from, 1);
}

/** Most recent firing at or before `from`, or undefined if none within ~400 days. */
export function prevRun(expr: CronExpr, from: Date = new Date()): Date | undefined {
  return scan(expr, from, -1);
}

/** Minute-by-minute walk with whole-day skips; bounded so a bad expr can't hang. */
function scan(expr: CronExpr, from: Date, dir: 1 | -1): Date | undefined {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  if (dir === 1) d.setTime(d.getTime() + MINUTE); // strictly after
  const limit = HORIZON_DAYS * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (expr.month.has(d.getMonth() + 1) && dayMatches(expr, d)) {
      if (expr.hour.has(d.getHours()) && expr.minute.has(d.getMinutes())) return d;
      d.setTime(d.getTime() + dir * MINUTE);
    } else {
      // Whole day is out: jump to the day boundary instead of crawling.
      if (dir === 1) {
        d.setHours(24, 0, 0, 0);
      } else {
        d.setHours(0, 0, 0, 0);
        d.setTime(d.getTime() - MINUTE);
      }
    }
  }
  return undefined;
}

/** Human-ish description used by `floe workflow list`. */
export function describeCron(source: string): string {
  const next = nextRun(parseCron(source));
  return next ? `${source} (next: ${next.toLocaleString()})` : source;
}
