// Shared setup for the UI tests: a static server for the repo, headless Chrome
// at phone size, the supabase-js CDN import swapped for tests/ui/fake-supabase.js,
// and a fixed clock (2026-10-21 12:00 in Los Angeles).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FAKE = fileURLToPath(new URL("./fake-supabase.js", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

export const TODAY = "2026-10-21";
export const day = (n) => { const d = new Date(2026, 9, 21 - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const email = (u) => `${u}@users.whatareweeatingnext.app`;

export function baseSeed() {
  return {
    sessionUserId: "u1",
    users: [
      { id: "u1", email: email("amey"), password: "secret1", username: "amey" },
      { id: "u2", email: email("wife"), password: "secret2", username: "wife" },
      { id: "u9", email: email("stranger"), password: "secret9", username: "stranger" },
    ],
    households: [{ id: "h1", name: "Our kitchen", join_code: "ABCD1234" }, { id: "h2", name: "Other", join_code: "ZZZZ9999" }],
    members: [
      { user_id: "u1", household_id: "h1", username: "amey", created_at: "1" },
      { user_id: "u2", household_id: "h1", username: "wife", created_at: "2" },
      { user_id: "u9", household_id: "h2", username: "stranger", created_at: "3" },
    ],
    dishes: [
      { id: "d1", household_id: "h1", name: "Rajma chawal", kind: "home" },
      { id: "d2", household_id: "h1", name: "Paneer butter masala", kind: "home" },
      { id: "d3", household_id: "h1", name: "Aloo paratha", kind: "home" },
      { id: "d4", household_id: "h1", name: "Burrito bowl", kind: "out", place: "Chipotle" },
      { id: "d5", household_id: "h1", name: "Pad thai", kind: "out", place: "Thai Basil" },
      { id: "d6", household_id: "h1", name: "Old soup", kind: "home", archived: true },
      { id: "dx", household_id: "h2", name: "Stranger secret dish", kind: "home" },
    ],
    meals_eaten: [
      { id: "e1", household_id: "h1", dish_id: "d1", name: "Rajma chawal", kind: "home", eaten_on: day(1), slot: "dinner", created_at: "1" },
      { id: "e2", household_id: "h1", dish_id: "d4", name: "Burrito bowl", kind: "out", place: "Chipotle", eaten_on: day(2), slot: "lunch", created_at: "1" },
      { id: "e3", household_id: "h1", dish_id: "d2", name: "Paneer butter masala", kind: "home", eaten_on: day(25), slot: "dinner", created_at: "1" },
      { id: "e4", household_id: "h1", dish_id: "d5", name: "Pad thai", kind: "out", eaten_on: day(40), slot: "dinner", created_at: "1" },
      { id: "e6", household_id: "h1", dish_id: "d6", name: "Old soup", kind: "home", eaten_on: day(3), slot: "lunch", created_at: "1" },
      { id: "ex", household_id: "h2", dish_id: "dx", name: "Stranger secret dish", kind: "home", eaten_on: day(0), slot: "lunch", created_at: "1" },
    ],
    meal_options: [],
    votes: [],
    groceries: [{ id: "g1", household_id: "h1", name: "Spinach", qty: "1 bunch", created_at: "2026-10-20T10:00:00Z" }],
  };
}

let server, browser, baseUrl;

export async function startAll() {
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    try {
      const body = await readFile(join(ROOT, path === "/" ? "index.html" : path));
      res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "text/html" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
}

export async function stopAll() {
  await browser?.close();
  await new Promise((r) => server?.close(r));
}

// Opens the app with the given seed. Returns { page, dialogs, answer, db }.
// `answer` queues replies for prompt/confirm dialogs (default: accept).
export async function openApp(seed = baseSeed(), { width = 375, height = 812 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, timezoneId: "America/Los_Angeles", locale: "en-US", hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const dialogs = [];
  const answers = [];
  page.on("dialog", async (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    const a = answers.shift();
    if (a === false) await d.dismiss();
    else await d.accept(typeof a === "string" ? a : d.defaultValue());
  });
  await page.clock.install({ time: new Date("2026-10-21T12:00:00-07:00") });
  // Later routes win in Playwright: block everything external, then allow the swap.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/, async (route) =>
    route.fulfill({ contentType: "text/javascript", body: await readFile(FAKE, "utf8") }));
  await page.addInitScript((s) => { window.__SEED = s; }, seed);
  await page.goto(baseUrl);
  return {
    page, dialogs, errors,
    answer: (...a) => answers.push(...a),
    db: () => page.evaluate(() => structuredClone(window.__fake.db)),
    close: () => context.close(),
  };
}

// Small helpers for reading the UI.
export const texts = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
export const tab = (page, view) => page.click(`.bottom-nav [data-view=${view}]`);
export const settle = (page) => page.waitForTimeout(150);
