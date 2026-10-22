// Pure helpers shared by app.js and the tests. No DOM, no network.

// Regulars not eaten for this many days show up under "It's been a while".
export const STALE_DAYS = 14;
export const STALE_LIMIT = 6;
export const SLOT_ORDER = { breakfast: 0, lunch: 1, snack: 2, dinner: 3 };

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const kindIcon = (k) => (k === "out" ? "🍽️" : "🏠");

// Same rule as the database: trim, collapse inner whitespace, ignore case.
export const cleanName = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
export const norm = (s) => cleanName(s).toLowerCase();

// Dates are local calendar days as "YYYY-MM-DD" strings.
export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
export const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);

// Whole days from dateStr to today; Math.round absorbs DST's 23/25-hour days.
export function daysAgo(dateStr, today = ymd(new Date())) {
  return Math.round((parseYmd(today) - parseYmd(dateStr)) / 864e5);
}

export function agoText(dateStr, today = ymd(new Date())) {
  if (!dateStr) return "not had yet";
  const n = daysAgo(dateStr, today);
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 14) return `${n} days ago`;
  if (n < 60) return `${Math.round(n / 7)} weeks ago`;
  if (n < 365) return `${Math.round(n / 30)} months ago`;
  const y = Math.round(n / 365);
  return y === 1 ? "a year ago" : `${y} years ago`;
}

export function slotForHour(h) {
  return h < 11 ? "breakfast" : h < 16 ? "lunch" : "dinner";
}

export const activeDishes = (dishes) => dishes.filter((d) => !d.archived);

export function findDish(dishes, name, kind) {
  const n = norm(name);
  if (!n) return undefined;
  return activeDishes(dishes).find((d) => norm(d.name) === n && (!kind || d.kind === kind));
}

// Most recent day (up to today) a regular was eaten; future entries don't count.
export function lastEaten(eaten, dishId, today = ymd(new Date())) {
  let last = null;
  for (const m of eaten) {
    if (m.dish_id === dishId && m.eaten_on <= today && (!last || m.eaten_on > last)) last = m.eaten_on;
  }
  return last;
}

// Regulars not had in STALE_DAYS+: longest-ago first, never-had after them (A–Z).
export function staleDishes(dishes, eaten, today = ymd(new Date()), { days = STALE_DAYS, limit = STALE_LIMIT } = {}) {
  return activeDishes(dishes)
    .map((d) => ({ d, last: lastEaten(eaten, d.id, today) }))
    .filter(({ last }) => !last || daysAgo(last, today) >= days)
    .sort((a, b) => (a.last && b.last ? a.last.localeCompare(b.last) || a.d.name.localeCompare(b.d.name)
      : a.last ? -1 : b.last ? 1 : a.d.name.localeCompare(b.d.name)))
    .slice(0, limit);
}

// One list per kind: never-had first, then longest-ago, then A–Z.
export function regularsList(dishes, eaten, kind, today = ymd(new Date())) {
  return activeDishes(dishes).filter((d) => d.kind === kind)
    .map((d) => ({ d, last: lastEaten(eaten, d.id, today) }))
    .sort((a, b) => (a.last ?? "").localeCompare(b.last ?? "") || a.d.name.localeCompare(b.d.name));
}

// Vote options with score and my vote, best first; ties go to the earlier suggestion.
export function scoreOptions(options, votes, userId) {
  return options.map((o) => {
    const vs = votes.filter((v) => v.option_id === o.id);
    return { ...o, vs, score: vs.reduce((n, v) => n + v.value, 0), mine: vs.find((v) => v.user_id === userId)?.value ?? 0 };
  }).sort((a, b) => b.score - a.score || String(a.created_at).localeCompare(String(b.created_at)));
}

// Only a positive score leads; nobody wins on zero or negative votes.
export const leader = (scored) => (scored[0] && scored[0].score > 0 ? scored[0] : null);

// Clicking the vote I already cast removes it; otherwise it sets/replaces it.
export const voteAction = (mine, value) => (mine === value ? "remove" : "set");

// Month grid: leading blanks for the weekday offset, then one cell per day.
// Each day's marks follow meal order (breakfast → dinner), like the day list.
export function monthCells(month, eaten) {
  const byDay = groupByDay(eaten);
  const blanks = month.getDay();
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let d = 1; d <= days; d++) {
    const key = ymd(new Date(month.getFullYear(), month.getMonth(), d));
    const meals = sortBySlot(byDay[key] ?? []);
    cells.push({ day: d, key, marks: meals.slice(0, 3).map((x) => kindIcon(x.kind)).join("") + (meals.length > 3 ? "+" : "") });
  }
  return { blanks, cells };
}

export function groupByDay(eaten) {
  const byDay = {};
  for (const e of eaten) (byDay[e.eaten_on] ??= []).push(e);
  return byDay;
}

export const sortBySlot = (meals) => meals.slice().sort((a, b) => (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9));
