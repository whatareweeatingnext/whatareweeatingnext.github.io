import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, USERNAME_EMAIL_DOMAIN } from "./config.js";

const app = document.getElementById("app");
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mount = (id) => { app.replaceChildren($(`#${id}`).content.cloneNode(true)); };
const showError = (el, err) => { el.textContent = err?.message ?? String(err); el.hidden = false; };

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  mount("tpl-setup");
  throw new Error("config.js is not filled in");
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const toEmail = (u) => `${u.trim().toLowerCase()}@${USERNAME_EMAIL_DOMAIN}`;

let state = { user: null, member: null, household: null, members: [], options: [], votes: [], history: [], groceries: [] };
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

// ---------------------------------------------------------------- main ----

function showMain() {
  mount("tpl-main");

  app.querySelectorAll(".main-tabs button").forEach((b) => b.addEventListener("click", () => {
    app.querySelectorAll(".main-tabs button").forEach((x) => x.classList.toggle("active", x === b));
    app.querySelectorAll("section[data-view]").forEach((s) => (s.hidden = s.dataset.view !== b.dataset.view));
  }));

  $("#option-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    e.target.reset();
    await sb.from("meal_options").insert({ name });
    loadMeals();
  });

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

  channel = sb.channel("household")
    .on("postgres_changes", { event: "*", schema: "public", table: "meal_options" }, loadMeals)
    .on("postgres_changes", { event: "*", schema: "public", table: "votes" }, loadMeals)
    .on("postgres_changes", { event: "*", schema: "public", table: "groceries" }, loadGroceries)
    .subscribe();
}

async function onListClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, id } = btn.dataset;

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
    await sb.from("meal_options").update({ status: "archived" }).eq("status", "open").neq("id", id);
    await sb.from("meal_options").update({ status: "chosen", decided_at: new Date().toISOString() }).eq("id", id);
    loadMeals();
  } else if (act === "del-grocery") {
    await sb.from("groceries").delete().eq("id", id);
    loadGroceries();
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

async function loadMeals() {
  const [{ data: options }, { data: votes }, { data: history }] = await Promise.all([
    sb.from("meal_options").select("*").eq("status", "open").order("created_at"),
    sb.from("votes").select("*"),
    sb.from("meal_options").select("name, decided_at").eq("status", "chosen").order("decided_at", { ascending: false }).limit(10),
  ]);
  state.options = options ?? [];
  state.votes = votes ?? [];
  state.history = history ?? [];
  renderMeals();
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
        <div>${esc(o.name)}</div>
        <div class="voters">${o.vs.map((v) => `${v.value > 0 ? "👍" : "👎"} ${esc(nameOf(v.user_id))}`).join(" · ") || `suggested by ${esc(nameOf(o.created_by))}`}</div>
      </div>
      <div class="vote">
        <button data-act="vote" data-value="1" data-id="${o.id}" class="up ${o.mine === 1 ? "on" : ""}" aria-label="Vote yes">👍</button>
        <span class="score">${o.score}</span>
        <button data-act="vote" data-value="-1" data-id="${o.id}" class="down ${o.mine === -1 ? "on" : ""}" aria-label="Vote no">👎</button>
      </div>
      <button class="x" data-act="del-option" data-id="${o.id}" aria-label="Remove">✕</button>
    </li>`).join("") : `<li class="muted">No suggestions yet. Add one above.</li>`;

  const top = scored[0];
  $("#winner").innerHTML = top && top.score > 0
    ? `<div><div class="muted small">Leading</div><strong>${esc(top.name)}</strong></div>
       <button class="primary" data-act="choose" data-id="${top.id}">We're eating this</button>`
    : "";

  $("#history").innerHTML = state.history.map((h) =>
    `<li><span class="grow">${esc(h.name)}</span><span class="meta">${new Date(h.decided_at).toLocaleDateString()}</span></li>`
  ).join("") || `<li>Nothing yet.</li>`;
}

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
