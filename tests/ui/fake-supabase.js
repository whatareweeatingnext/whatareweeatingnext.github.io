// In-memory stand-in for supabase-js used by the UI tests. It mirrors the
// database rules in supabase/schema.sql: per-household row isolation,
// ensure_dish/link_dish (one regular everywhere), unique open vote option,
// one entry per regular per meal per day, rename sync and archiving.
// Tests seed it through window.__SEED before the page loads.

const seed = structuredClone(window.__SEED ?? {});
const db = {
  users: seed.users ?? [],
  households: seed.households ?? [],
  members: seed.members ?? [],
  dishes: (seed.dishes ?? []).map((d) => ({ place: null, archived: false, ...d })),
  meals_eaten: seed.meals_eaten ?? [],
  meal_options: seed.meal_options ?? [],
  votes: seed.votes ?? [],
  groceries: seed.groceries ?? [],
};
let sessionUserId = seed.sessionUserId ?? null;
let seq = 1;
const uid = (p = "id") => `${p}${seq++}`;
const now = () => new Date().toISOString();
const err = (code, message) => ({ code, message });
const clean = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
const me = () => db.users.find((u) => u.id === sessionUserId) ?? null;
const myHousehold = () => db.members.find((m) => m.user_id === sessionUserId)?.household_id ?? null;
const visible = (table, r) => {
  if (table === "households") return r.id === myHousehold();
  if ("household_id" in r) return r.household_id === myHousehold() && myHousehold() !== null;
  return true;
};

function ensureDish(name, kind = "home", place = null) {
  const n = clean(name);
  if (!n) throw err("23514", "dish name required");
  let d = db.dishes.find((x) => x.household_id === myHousehold() && x.kind === kind && x.name.toLowerCase() === n.toLowerCase());
  if (d) { d.archived = false; d.place ??= clean(place) || null; return d; }
  d = { id: uid("dish"), household_id: myHousehold(), name: n, kind, place: clean(place) || null, archived: false, created_at: now() };
  db.dishes.push(d);
  return d;
}

function linkDish(table, row) {
  const d = row.dish_id ? db.dishes.find((x) => x.id === row.dish_id && visible("dishes", x)) : ensureDish(row.name, row.kind, row.place);
  if (!d) throw err("P0001", "unknown dish");
  row.dish_id = d.id; row.name = d.name; row.kind = d.kind;
  const dup = table === "meal_options"
    ? row.status === "open" && db.meal_options.some((o) => o !== row && o.household_id === row.household_id && o.status === "open" && o.dish_id === d.id)
    : db.meals_eaten.some((m) => m !== row && m.household_id === row.household_id && m.eaten_on === row.eaten_on && (m.slot ?? "") === (row.slot ?? "") && m.dish_id === d.id);
  if (dup) throw err("23505", "duplicate key value violates unique constraint");
}

const defaults = {
  groceries: () => ({ created_at: now() }),
  dishes: () => ({ kind: "home", place: null, archived: false, created_at: now() }),
  meals_eaten: () => ({ kind: "home", place: null, eaten_on: new Date().toISOString().slice(0, 10), slot: null, created_at: now() }),
  meal_options: () => ({ kind: "home", status: "open", created_at: now() }),
  votes: () => ({}),
};

function query(table) {
  const filters = [];
  let op = "select", payload = null, single = false, maybe = false, returning = false, orders = [], limit = Infinity;
  const matches = (r) => visible(table, r) && filters.every(([k, v, neg]) => (neg ? r[k] !== v : r[k] === v));

  function run() {
    if (!sessionUserId && table !== "members") return { data: single ? null : [], error: null };
    let out = [];
    try {
      if (op === "insert" || op === "upsert") {
        if (!myHousehold()) throw err("42501", "not in a household");
        for (const p of Array.isArray(payload) ? payload : [payload]) {
          const row = { id: uid(table), ...defaults[table](), household_id: myHousehold(), ...p };
          if (table === "votes") row.user_id = sessionUserId;
          if (table === "meal_options" || table === "dishes") row.created_by = sessionUserId;
          if (table === "meals_eaten" || table === "meal_options") linkDish(table, row);
          if (op === "upsert" && table === "votes") db.votes = db.votes.filter((v) => !(v.option_id === row.option_id && v.user_id === row.user_id));
          db[table].push(row);
          out.push(row);
        }
      } else if (op === "update") {
        out = db[table].filter(matches);
        for (const r of out) {
          if (table === "dishes" && payload.name !== undefined) {
            const n = clean(payload.name);
            if (db.dishes.some((d) => d !== r && d.household_id === r.household_id && d.kind === r.kind && d.name.toLowerCase() === n.toLowerCase())) throw err("23505", "duplicate dish");
          }
          const before = { ...r };
          Object.assign(r, payload);
          if (table === "meal_options" || table === "meals_eaten") {
            try { linkDish(table, r); } catch (e) { Object.assign(r, before); throw e; }
          }
          if (table === "dishes") {
            for (const t of ["meals_eaten", "meal_options"]) db[t].filter((m) => m.dish_id === r.id).forEach((m) => { m.name = r.name; m.kind = r.kind; });
          }
        }
      } else if (op === "delete") {
        out = db[table].filter(matches);
        db[table] = db[table].filter((r) => !out.includes(r));
        if (table === "meal_options") db.votes = db.votes.filter((v) => !out.some((o) => o.id === v.option_id));
      } else {
        out = db[table].filter(matches).map((r) => ({ ...r }));
        for (const [col, asc] of orders.slice().reverse()) {
          out.sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (asc ? 1 : -1));
        }
        out = out.slice(0, limit);
      }
    } catch (e) {
      return { data: null, error: e };
    }
    if (op !== "select" && !returning) return { data: null, error: null };
    if (single) {
      if (!out.length && !maybe) return { data: null, error: err("PGRST116", "no rows") };
      return { data: out[0] ?? null, error: null };
    }
    return { data: out, error: null };
  }

  const c = {
    select() { if (op !== "select") returning = true; return c; },
    insert(p) { op = "insert"; payload = p; return c; },
    upsert(p) { op = "upsert"; payload = p; return c; },
    update(p) { op = "update"; payload = p; return c; },
    delete() { op = "delete"; return c; },
    eq(k, v) { filters.push([k, v, false]); return c; },
    neq(k, v) { filters.push([k, v, true]); return c; },
    order(col, opts = {}) { orders.push([col, opts.ascending !== false]); return c; },
    limit(n) { limit = n; return c; },
    single() { single = true; return c; },
    maybeSingle() { single = true; maybe = true; return c; },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  };
  return c;
}

const listeners = [];
const session = () => (me() ? { user: { id: me().id, email: me().email, user_metadata: { username: me().username } } } : null);
const emit = (event) => listeners.forEach((cb) => cb(event, session()));

async function rpc(fn, args) {
  try {
    if (!sessionUserId) throw err("42501", "not signed in");
    if (fn === "ensure_dish") return { data: ensureDish(args.p_name, args.p_kind, args.p_place).id, error: null };
    if (fn === "create_household" || fn === "join_household") {
      if (myHousehold()) throw err("P0001", "already in a household");
      let h;
      if (fn === "create_household") {
        h = { id: uid("hh"), name: clean(args.p_name) || "Home", join_code: "JOIN" + seq++ };
        db.households.push(h);
      } else {
        h = db.households.find((x) => x.join_code === clean(args.p_code).toUpperCase());
        if (!h) throw err("P0001", "invalid join code");
      }
      db.members.push({ user_id: sessionUserId, household_id: h.id, username: args.p_username, created_at: now() });
      return { data: h.id, error: null };
    }
    throw err("PGRST202", `unknown function ${fn}`);
  } catch (e) {
    return { data: null, error: e };
  }
}

export function createClient() {
  return {
    auth: {
      onAuthStateChange(cb) { listeners.push(cb); setTimeout(() => cb("INITIAL_SESSION", session())); return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: session() } }; },
      async signInWithPassword({ email, password }) {
        const u = db.users.find((x) => x.email === email && x.password === password);
        if (!u) return { data: {}, error: { message: "Invalid login credentials" } };
        sessionUserId = u.id; emit("SIGNED_IN");
        return { data: session(), error: null };
      },
      async signUp({ email, password, options }) {
        if (db.users.some((x) => x.email === email)) return { data: {}, error: { message: "User already registered" } };
        if (password.length < 6) return { data: {}, error: { message: "Password should be at least 6 characters." } };
        const u = { id: uid("user"), email, password, username: options?.data?.username };
        db.users.push(u);
        sessionUserId = u.id; emit("SIGNED_IN");
        return { data: session(), error: null };
      },
      async signOut() { sessionUserId = null; emit("SIGNED_OUT"); return { error: null }; },
    },
    from: query,
    rpc,
    channel() { return { on() { return this; }, subscribe() { return this; } }; },
    removeChannel() {},
  };
}

window.__fake = { db, get sessionUserId() { return sessionUserId; } };
