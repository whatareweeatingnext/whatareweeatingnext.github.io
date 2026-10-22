import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";
import { SUPABASE_URL, SUPABASE_KEY, USERNAME_EMAIL_DOMAIN } from "./config.js";
import {
  STALE_DAYS, esc, kindIcon, ymd, parseYmd, firstOfMonth, addMonths, daysAgo, agoText, slotForHour,
  activeDishes as active, findDish as find, staleDishes, regularsList,
  scoreOptions, leader, voteAction, monthCells, groupByDay, sortBySlot,
} from "./lib.js";

const app = document.getElementById("app");
const $ = (sel, root = document) => root.querySelector(sel);
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

const slotForNow = () => slotForHour(new Date().getHours());

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
    const { error } = await sb.from("meal_options").insert({ name, kind: f.kind.value });
    if (error && error.code !== DUPLICATE) return alert(error.message);
    f.reset();
    f.kindPicked = false;
    loadMeals();
    loadDishes();
  });
  // Typing a known regular fills in home/out for you, unless you've already
  // picked 🏠/🍽️ yourself (so "Pizza" can be both a home and an out regular).
  for (const f of [$("#option-form"), $("#eaten-form")]) {
    f.kindPicked = false;
    f.kind.addEventListener("input", () => (f.kindPicked = true));
    f.name.addEventListener("input", () => {
      const dish = findDish(f.name.value);
      if (!dish || f.kindPicked) return;
      f.kind.value = dish.kind;
      f.kind.dispatchEvent(new Event("change"));
      if (f.place && !f.place.value) f.place.value = dish.place ?? "";
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
    const place = kind === "out" ? (ef.place.value.trim() || null) : null;
    const { error } = await sb.from("meals_eaten").insert({ name, kind, place, slot: ef.slot.value, eaten_on: state.calDay });
    if (error) return alert(error.code === DUPLICATE ? `Already logged for ${ef.slot.value} that day.` : error.message);
    ef.name.value = ""; ef.place.value = "";
    ef.kindPicked = false;
    loadEaten();
    loadDishes();
  });

  app.querySelectorAll(".dish-form").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = f.name.value.trim();
    if (!name) return;
    const { error } = await sb.rpc("ensure_dish", { p_name: name, p_kind: f.dataset.kind, p_place: f.place?.value.trim() || null });
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

// Postgres unique_violation: the meal is already in the vote / already logged.
const DUPLICATE = "23505";

// Every calendar entry and vote option points at one regular (dish_id); the
// database creates the regular when a new name is added anywhere.
const activeDishes = () => active(state.dishes);
const findDish = (name, kind) => find(state.dishes, name, kind);

async function logEaten(dish, { slot = slotForNow(), eaten_on = ymd(new Date()) } = {}) {
  const { error } = await sb.from("meals_eaten").insert({ dish_id: dish.id, name: dish.name, kind: dish.kind, place: dish.place, slot, eaten_on });
  if (error) alert(error.code === DUPLICATE ? `${dish.name} is already logged for today's ${slot}.` : error.message);
  loadEaten();
}

async function suggestDish(dish) {
  const { error } = await sb.from("meal_options").insert({ dish_id: dish.id, name: dish.name, kind: dish.kind });
  if (error && error.code !== DUPLICATE) alert(error.message);
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
    if (voteAction(mine?.value, value) === "remove") {
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
    const d = state.dishes.find((x) => x.id === o?.dish_id);
    if (d) await logEaten(d);
    loadMeals();
  } else if (act === "del-grocery") {
    await sb.from("groceries").delete().eq("id", id);
    loadGroceries();
  } else if (act === "dish-vote" && dish) {
    await suggestDish(dish);
    btn.textContent = "✓";
  } else if (act === "dish-ate" && dish) {
    await logEaten(dish);
  } else if (act === "edit-dish" && dish) {
    const name = prompt("Rename (updates the calendar and vote too):", dish.name)?.trim();
    if (!name) return;
    const place = dish.kind === "out" ? (prompt("Where?", dish.place ?? "")?.trim() || null) : null;
    const { error } = await sb.from("dishes").update({ name, place }).eq("id", id);
    if (error) return alert(error.code === DUPLICATE ? `"${name}" is already a regular.` : error.message);
    loadDishes(); loadEaten(); loadMeals();
  } else if (act === "del-dish" && dish) {
    if (!confirm(`Remove "${dish.name}" from regulars? It stays in your calendar history, and adding it again brings it back.`)) return;
    await sb.from("dishes").update({ archived: true }).eq("id", id);
    loadDishes();
  } else if (act === "del-eaten") {
    await sb.from("meals_eaten").delete().eq("id", id);
    loadEaten();

  } else if (act === "cal-prev" || act === "cal-next") {
    state.calMonth = addMonths(state.calMonth, act === "cal-next" ? 1 : -1);
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
  const scored = scoreOptions(state.options, state.votes, state.user.id);

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

  const top = leader(scored);
  $("#winner").innerHTML = top
    ? `<div><div class="muted small">Leading</div><strong>${kindIcon(top.kind)} ${esc(top.name)}</strong></div>
       <button class="primary" data-act="choose" data-id="${top.id}">We're eating this</button>`
    : "";
}

function renderStale() {
  if (!$("#stale")) return;
  const rows = staleDishes(state.dishes, state.eaten);
  $("#stale-card").hidden = !activeDishes().length;
  $("#stale").innerHTML = rows.length ? rows.map(({ d, last }) => {
    const inVote = state.options.some((o) => o.dish_id === d.id);
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
  $("#dish-names").innerHTML = activeDishes().map((d) => `<option value="${esc(d.name)}">`).join("");
}

function renderDishes() {
  for (const kind of ["home", "out"]) {
    const ul = $(`#dishes-${kind}`);
    if (!ul) continue;
    const rows = regularsList(state.dishes, state.eaten, kind);
    ul.innerHTML = rows.length ? rows.map(({ d, last }) => `
      <li>
        <div class="grow">${esc(d.name)}${d.place ? ` <span class="meta">· ${esc(d.place)}</span>` : ""}
          <div class="meta ${last && daysAgo(last) >= STALE_DAYS ? "stale" : ""}">${last ? `last had ${agoText(last)}` : "not had yet"}</div></div>
        <button data-act="edit-dish" data-id="${d.id}" aria-label="Rename" title="Rename">✎</button>
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

function renderCalendar() {
  if (!$("#cal-grid")) return;
  const m = state.calMonth;
  $("#cal-title").textContent = m.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const byDay = groupByDay(state.eaten);
  const today = ymd(new Date());
  const { blanks, cells } = monthCells(m, state.eaten);
  $("#cal-grid").innerHTML = [
    ...["S", "M", "T", "W", "T", "F", "S"].map((d) => `<div class="dow">${d}</div>`),
    ...Array.from({ length: blanks }, () => `<div></div>`),
    ...cells.map((c) => `<button data-act="cal-day" data-day="${c.key}" class="day ${c.key === today ? "today" : ""} ${c.key === state.calDay ? "sel" : ""}">
      <span class="num">${c.day}</span><span class="marks">${c.marks}</span></button>`),
  ].join("");

  const sel = parseYmd(state.calDay);
  $("#day-title").textContent = state.calDay === today ? "Today" : sel.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const meals = sortBySlot(byDay[state.calDay] ?? []);
  $("#day-meals").innerHTML = meals.length ? meals.map((x) => {
    const place = x.place ?? state.dishes.find((d) => d.id === x.dish_id)?.place;
    return `
    <li>
      <div class="grow">${kindIcon(x.kind)} ${esc(x.name)}${place ? ` <span class="meta">· ${esc(place)}</span>` : ""}
        <div class="meta">${x.slot ? x.slot[0].toUpperCase() + x.slot.slice(1) : ""}</div></div>
      <button class="x" data-act="del-eaten" data-id="${x.id}" aria-label="Remove">✕</button>
    </li>`;
  }).join("") : `<li class="muted">Nothing logged.</li>`;
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
