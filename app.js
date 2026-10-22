import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";
import { SUPABASE_URL, SUPABASE_KEY, USERNAME_EMAIL_DOMAIN } from "./config.js";

const app = document.getElementById("app");
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mount = (id) => { app.replaceChildren($(`#${id}`).content.cloneNode(true)); };
const showError = (el, err) => { el.textContent = err?.message ?? String(err); el.hidden = false; };

if (!SUPABASE_URL || !SUPABASE_KEY) {
  mount("tpl-setup");
  throw new Error("config.js is not filled in");
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const toEmail = (u) => `${u.trim().toLowerCase()}@${USERNAME_EMAIL_DOMAIN}`;

let state = {
  user: null, member: null, household: null, members: [], options: [], votes: [], groceries: [],
  dishes: [], eaten: [], calMonth: firstOfMonth(new Date()), calDay: ymd(new Date()),
};
let channel = null;

sb.auth.onAuthStateChange((_event, session) => {
  const uid = session?.user?.id ?? null;
  if (uid === state.user?.id) return;
  state.user = session?.user ?? null;
  route();
});

$("#logout").addEventListener("click", () => sb.auth.signOut());
app.addEventListener("click", onListClick);

async function route() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  $("#who").hidden = !state.user;
  if (!state.user) return showAuth();

  const { data: member, error } = await sb.from("members").select("*").eq("user_id", state.user.id).maybeSingle();
  if (error) { app.textContent = error.message; return; }
  state.member = member;
  $("#who-name").textContent = member?.username ?? state.user.user_metadata?.username ?? "";
  if (!member) return showHousehold();
  showMain();
}

// ---------------------------------------------------------------- auth ----

function showAuth() {
  mount("tpl-auth");
  const form = $("#auth-form");
  const submit = $("button[type=submit]", form);
  const err = $(".error", form);
  let mode = "login";

  app.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    app.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    submit.textContent = mode === "login" ? "Log in" : "Create account";
    form.password.autocomplete = mode === "login" ? "current-password" : "new-password";
    err.hidden = true;
  }));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    const username = form.username.value.trim();
    const email = toEmail(username);
    const password = form.password.value;
    const { error } = mode === "login"
      ? await sb.auth.signInWithPassword({ email, password })
      : await sb.auth.signUp({ email, password, options: { data: { username } } });
    submit.disabled = false;
    if (error) {
      showError(err, error.message === "Invalid login credentials" ? new Error("Wrong username or password") : error);
    } else if (mode === "signup") {
      const { data } = await sb.auth.getSession();
      if (!data.session) showError(err, new Error("Account created, but email confirmation is on in Supabase. Turn it off (see README) and log in."));
    }
  });
}

// ----------------------------------------------------------- household ----

function showHousehold() {
  mount("tpl-household");
  const err = app.querySelector(":scope > .card > .error");
  const username = state.user.user_metadata?.username ?? state.user.email.split("@")[0];

  $("#create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await sb.rpc("create_household", { p_name: e.target.name.value, p_username: username });
    error ? showError(err, error) : route();
  });
  $("#join-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await sb.rpc("join_household", { p_code: e.target.code.value, p_username: username });
    error ? showError(err, error) : route();
  });
}

// --------------------------------------------------------------- dates ----

// Regulars not eaten for this many days show up under "It's been a while".
const STALE_DAYS = 14;

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function daysAgo(dateStr) { return Math.round((parseYmd(ymd(new Date())) - parseYmd(dateStr)) / 864e5); }
function agoText(dateStr) {
  if (!dateStr) return "not had yet";
  const n = daysAgo(dateStr);
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 14) return `${n} days ago`;
  if (n < 60) return `${Math.round(n / 7)} weeks ago`;
  return `${Math.round(n / 30)} months ago`;
}
function slotForNow() {
  const h = new Date().getHours();
  return h < 11 ? "breakfast" : h < 16 ? "lunch" : "dinner";
}
const kindIcon = (k) => (k === "out" ? "🍽️" : "🏠");
const norm = (s) => String(s ?? "").trim().toLowerCase();

// ---------------------------------------------------------------- main ----

function showMain() {
  mount("tpl-main");

  app.querySelectorAll(".bottom-nav button").forEach((b) => b.addEventListener("click", () => {
    app.querySelectorAll(".bottom-nav button").forEach((x) => x.classList.toggle("active", x === b));
    app.querySelectorAll("[data-view]:not(button)").forEach((s) => (s.hidden = s.dataset.view !== b.dataset.view));
    window.scrollTo(0, 0);
  }));

  $("#option-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const name = f.name.value.trim();
    if (!name) return;
    const dish = findDish(name, f.kind.value);
    f.reset();
    await sb.from("meal_options").insert({ name: dish?.name ?? name, kind: dish?.kind ?? f.kind.value, dish_id: dish?.id ?? null });
    loadMeals();
  });
  // Picking a known regular fills in home/out for you.
  for (const f of [$("#option-form"), $("#eaten-form")]) {
    f.name.addEventListener("change", () => {
      const dish = findDish(f.name.value);
      if (dish) { f.kind.value = dish.kind; f.kind.dispatchEvent(new Event("change")); if (f.place) f.place.value = dish.place ?? ""; }
    });
  }

  const ef = $("#eaten-form");
  ef.slot.value = slotForNow();
  ef.kind.addEventListener("change", () => (ef.place.hidden = ef.kind.value !== "out"));
  ef.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = ef.name.value.trim();
    if (!name) return;
    const kind = ef.kind.value;
    const dish = findDish(name, kind);
    const place = kind === "out" ? (ef.place.value.trim() || dish?.place || null) : null;
    await sb.from("meals_eaten").insert({ name: dish?.name ?? name, kind, place, slot: ef.slot.value, eaten_on: state.calDay, dish_id: dish?.id ?? null });
    ef.name.value = ""; ef.place.value = "";
    loadEaten();
  });

  app.querySelectorAll(".dish-form").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = f.name.value.trim();
    if (!name) return;
    const kind = f.dataset.kind;
    if (findDish(name, kind)) { f.reset(); return; }
    const { error } = await sb.from("dishes").insert({ name, kind, place: f.place?.value.trim() || null });
    if (error) return alert(error.message);
    f.reset();
    f.name.focus();
    loadDishes();
  }));

  $("#grocery-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    const qty = e.target.qty.value.trim() || null;
    if (!name) return;
    e.target.reset();
    e.target.name.focus();
    await sb.from("groceries").insert({ name, qty });
    loadGroceries();
  });

  $("#new-round").addEventListener("click", async () => {
    if (!state.options.length || !confirm("Clear all current suggestions?")) return;
    await sb.from("meal_options").update({ status: "archived" }).eq("status", "open");
    loadMeals();
  });

  loadHousehold();
  loadMeals();
  loadGroceries();
  loadDishes();
  loadEaten();
  renderCalendar();

  channel = sb.channel("household")
    .on("postgres_changes", { event: "*", schema: "public", table: "meal_options" }, loadMeals)
    .on("postgres_changes", { event: "*", schema: "public", table: "votes" }, loadMeals)
    .on("postgres_changes", { event: "*", schema: "public", table: "groceries" }, loadGroceries)
    .on("postgres_changes", { event: "*", schema: "public", table: "dishes" }, loadDishes)
    .on("postgres_changes", { event: "*", schema: "public", table: "meals_eaten" }, loadEaten)
    .subscribe();
}

function findDish(name, kind) {
  const n = norm(name);
  return state.dishes.find((d) => norm(d.name) === n && (!kind || d.kind === kind));
}

// Most recent day each regular was eaten, matched by link or by name.
function lastEaten(dish) {
  let last = null;
  for (const m of state.eaten) {
    if ((m.dish_id === dish.id || (m.kind === dish.kind && norm(m.name) === norm(dish.name))) && (!last || m.eaten_on > last)) last = m.eaten_on;
  }
  return last;
}

async function logEaten({ name, kind, place = null, dish_id = null, slot = slotForNow(), eaten_on = ymd(new Date()) }) {
  await sb.from("meals_eaten").insert({ name, kind, place, dish_id, slot, eaten_on });
  loadEaten();
}

async function suggestDish(dish) {
  if (state.options.some((o) => norm(o.name) === norm(dish.name))) return;
  await sb.from("meal_options").insert({ name: dish.name, kind: dish.kind, dish_id: dish.id });
  loadMeals();
}

async function onListClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const { act, id } = btn.dataset;
  const dish = id && state.dishes.find((d) => d.id === id);

  if (act === "vote") {
    const value = Number(btn.dataset.value);
    const mine = state.votes.find((v) => v.option_id === id && v.user_id === state.user.id);
    if (mine?.value === value) {
      await sb.from("votes").delete().eq("option_id", id).eq("user_id", state.user.id);
    } else {
      await sb.from("votes").upsert({ option_id: id, value });
    }
    loadMeals();
  } else if (act === "del-option") {
    await sb.from("meal_options").delete().eq("id", id);
    loadMeals();
  } else if (act === "choose") {
    const o = state.options.find((x) => x.id === id);
    await sb.from("meal_options").update({ status: "archived" }).eq("status", "open").neq("id", id);
    await sb.from("meal_options").update({ status: "chosen", decided_at: new Date().toISOString() }).eq("id", id);
    const d = o?.dish_id ? state.dishes.find((x) => x.id === o.dish_id) : findDish(o?.name ?? "", o?.kind);
    if (o) await logEaten({ name: o.name, kind: o.kind ?? "home", place: d?.place ?? null, dish_id: d?.id ?? null });
    loadMeals();
  } else if (act === "del-grocery") {
    await sb.from("groceries").delete().eq("id", id);
    loadGroceries();
  } else if (act === "dish-vote" && dish) {
    await suggestDish(dish);
    btn.textContent = "✓";
  } else if (act === "dish-ate" && dish) {
    await logEaten({ name: dish.name, kind: dish.kind, place: dish.place, dish_id: dish.id });
  } else if (act === "del-dish" && dish) {
    if (!confirm(`Remove "${dish.name}" from regulars? Past meals stay in the calendar.`)) return;
    await sb.from("dishes").delete().eq("id", id);
    loadDishes();
  } else if (act === "del-eaten") {
    await sb.from("meals_eaten").delete().eq("id", id);
    loadEaten();
  } else if (act === "save-regular") {
    const m = state.eaten.find((x) => x.id === id);
    if (!m || findDish(m.name, m.kind)) return;
    const { data } = await sb.from("dishes").insert({ name: m.name, kind: m.kind, place: m.place }).select().single();
    if (data) await sb.from("meals_eaten").update({ dish_id: data.id }).eq("id", m.id);
    loadDishes(); loadEaten();
  } else if (act === "cal-prev" || act === "cal-next") {
    const d = state.calMonth;
    state.calMonth = new Date(d.getFullYear(), d.getMonth() + (act === "cal-next" ? 1 : -1), 1);
    renderCalendar();
  } else if (act === "cal-day") {
    state.calDay = btn.dataset.day;
    renderCalendar();
  }
}

async function loadHousehold() {
  const [{ data: hh }, { data: members }] = await Promise.all([
    sb.from("households").select("*").single(),
    sb.from("members").select("user_id, username").order("created_at"),
  ]);
  state.household = hh;
  state.members = members ?? [];
  $("#hh-name").textContent = hh?.name ?? "";
  $("#hh-code").textContent = hh?.join_code ?? "";
  $("#members").innerHTML = state.members.map((m) => `<li>${esc(m.username)}</li>`).join("");
  renderMeals();
}

const nameOf = (uid) => state.members.find((m) => m.user_id === uid)?.username ?? "someone";

// ---------------------------------------------------------------- vote ----

async function loadMeals() {
  const [{ data: options }, { data: votes }] = await Promise.all([
    sb.from("meal_options").select("*").eq("status", "open").order("created_at"),
    sb.from("votes").select("*"),
  ]);
  state.options = options ?? [];
  state.votes = votes ?? [];
  renderMeals();
  renderStale();
}

function renderMeals() {
  if (!$("#options")) return;
  const scored = state.options.map((o) => {
    const vs = state.votes.filter((v) => v.option_id === o.id);
    return { ...o, vs, score: vs.reduce((n, v) => n + v.value, 0), mine: vs.find((v) => v.user_id === state.user.id)?.value ?? 0 };
  }).sort((a, b) => b.score - a.score || a.created_at.localeCompare(b.created_at));

  $("#options").innerHTML = scored.length ? scored.map((o) => `
    <li>
      <div class="grow">
        <div>${kindIcon(o.kind)} ${esc(o.name)}</div>
        <div class="voters">${o.vs.map((v) => `${v.value > 0 ? "👍" : "👎"} ${esc(nameOf(v.user_id))}`).join(" · ") || `suggested by ${esc(nameOf(o.created_by))}`}</div>
      </div>
      <div class="vote">
        <button data-act="vote" data-value="1" data-id="${o.id}" class="up ${o.mine === 1 ? "on" : ""}" aria-label="Vote yes">👍</button>
        <span class="score">${o.score}</span>
        <button data-act="vote" data-value="-1" data-id="${o.id}" class="down ${o.mine === -1 ? "on" : ""}" aria-label="Vote no">👎</button>
      </div>
      <button class="x" data-act="del-option" data-id="${o.id}" aria-label="Remove">✕</button>
    </li>`).join("") : `<li class="muted">No suggestions yet. Add one above, or pick from "It's been a while".</li>`;

  const top = scored[0];
  $("#winner").innerHTML = top && top.score > 0
    ? `<div><div class="muted small">Leading</div><strong>${kindIcon(top.kind)} ${esc(top.name)}</strong></div>
       <button class="primary" data-act="choose" data-id="${top.id}">We're eating this</button>`
    : "";
}

function renderStale() {
  if (!$("#stale")) return;
  const rows = state.dishes.map((d) => ({ d, last: lastEaten(d) }))
    .filter(({ last }) => !last || daysAgo(last) >= STALE_DAYS)
    // Longest-ago first; never-logged ones after the dated ones.
    .sort((a, b) => (a.last && b.last ? a.last.localeCompare(b.last) : a.last ? -1 : b.last ? 1 : a.d.name.localeCompare(b.d.name)))
    .slice(0, 6);
  $("#stale-card").hidden = !state.dishes.length;
  $("#stale").innerHTML = rows.length ? rows.map(({ d, last }) => {
    const inVote = state.options.some((o) => norm(o.name) === norm(d.name));
    return `<li>
      <div class="grow">${kindIcon(d.kind)} ${esc(d.name)}${d.place ? ` <span class="meta">· ${esc(d.place)}</span>` : ""}
        <div class="meta">${agoText(last)}</div></div>
      <button data-act="dish-vote" data-id="${d.id}" ${inVote ? "disabled" : ""}>${inVote ? "✓ In vote" : "+ Vote"}</button>
    </li>`;
  }).join("") : `<li class="muted">You've had all your regulars recently 🎉</li>`;
}

// ------------------------------------------------------------ regulars ----

async function loadDishes() {
  const { data } = await sb.from("dishes").select("*").order("name");
  state.dishes = data ?? [];
  renderDishes();
  renderStale();
  renderCalendar();
  $("#dish-names").innerHTML = state.dishes.map((d) => `<option value="${esc(d.name)}">`).join("");
}

function renderDishes() {
  for (const kind of ["home", "out"]) {
    const ul = $(`#dishes-${kind}`);
    if (!ul) continue;
    const rows = state.dishes.filter((d) => d.kind === kind).map((d) => ({ d, last: lastEaten(d) }))
      .sort((a, b) => (a.last ?? "").localeCompare(b.last ?? "") || a.d.name.localeCompare(b.d.name));
    ul.innerHTML = rows.length ? rows.map(({ d, last }) => `
      <li>
        <div class="grow">${esc(d.name)}${d.place ? ` <span class="meta">· ${esc(d.place)}</span>` : ""}
          <div class="meta ${last && daysAgo(last) >= STALE_DAYS ? "stale" : ""}">${last ? `last had ${agoText(last)}` : "not had yet"}</div></div>
        <button data-act="dish-vote" data-id="${d.id}" aria-label="Add to vote" title="Add to vote">🗳️</button>
        <button data-act="dish-ate" data-id="${d.id}" aria-label="We ate this today" title="We ate this today">✓</button>
        <button class="x" data-act="del-dish" data-id="${d.id}" aria-label="Remove">✕</button>
      </li>`).join("") : `<li class="muted">Nothing here yet.</li>`;
  }
}

// ------------------------------------------------------------ calendar ----

async function loadEaten() {
  const { data } = await sb.from("meals_eaten").select("*").order("eaten_on", { ascending: false }).order("created_at").limit(3000);
  state.eaten = data ?? [];
  renderCalendar();
  renderDishes();
  renderStale();
}

const SLOT_ORDER = { breakfast: 0, lunch: 1, snack: 2, dinner: 3 };

function renderCalendar() {
  if (!$("#cal-grid")) return;
  const m = state.calMonth;
  $("#cal-title").textContent = m.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const byDay = {};
  for (const e of state.eaten) (byDay[e.eaten_on] ??= []).push(e);

  const today = ymd(new Date());
  const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const cells = ["S", "M", "T", "W", "T", "F", "S"].map((d) => `<div class="dow">${d}</div>`);
  for (let i = 0; i < m.getDay(); i++) cells.push(`<div></div>`);
  for (let d = 1; d <= days; d++) {
    const key = ymd(new Date(m.getFullYear(), m.getMonth(), d));
    const meals = byDay[key] ?? [];
    const marks = meals.slice(0, 3).map((x) => kindIcon(x.kind)).join("") + (meals.length > 3 ? "+" : "");
    cells.push(`<button data-act="cal-day" data-day="${key}" class="day ${key === today ? "today" : ""} ${key === state.calDay ? "sel" : ""}">
      <span class="num">${d}</span><span class="marks">${marks}</span></button>`);
  }
  $("#cal-grid").innerHTML = cells.join("");

  const sel = parseYmd(state.calDay);
  $("#day-title").textContent = state.calDay === today ? "Today" : sel.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const meals = (byDay[state.calDay] ?? []).slice().sort((a, b) => (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9));
  $("#day-meals").innerHTML = meals.length ? meals.map((x) => `
    <li>
      <div class="grow">${kindIcon(x.kind)} ${esc(x.name)}${x.place ? ` <span class="meta">· ${esc(x.place)}</span>` : ""}
        <div class="meta">${x.slot ? x.slot[0].toUpperCase() + x.slot.slice(1) : ""}</div></div>
      ${findDish(x.name, x.kind) ? "" : `<button data-act="save-regular" data-id="${x.id}" title="Save as a regular">⭐</button>`}
      <button class="x" data-act="del-eaten" data-id="${x.id}" aria-label="Remove">✕</button>
    </li>`).join("") : `<li class="muted">Nothing logged.</li>`;
}

// ----------------------------------------------------------- groceries ----

async function loadGroceries() {
  const { data } = await sb.from("groceries").select("*").order("created_at", { ascending: false });
  state.groceries = data ?? [];
  if (!$("#groceries")) return;
  $("#groceries").innerHTML = state.groceries.length ? state.groceries.map((g) => `
    <li>
      <div class="grow">${esc(g.name)}${g.qty ? ` <span class="meta">· ${esc(g.qty)}</span>` : ""}
        <div class="meta">added ${new Date(g.created_at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
      </div>
      <button class="x" data-act="del-grocery" data-id="${g.id}" aria-label="Used up">✕</button>
    </li>`).join("") : `<li class="muted">Nothing logged yet.</li>`;
}
