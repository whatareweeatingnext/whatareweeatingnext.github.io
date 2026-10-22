-- what-are-we-eating: database schema
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Every table is protected by row-level security: a signed-in user can only
-- see and change rows belonging to their own household.

create extension if not exists pgcrypto;

-- Households ---------------------------------------------------------------

create table if not exists public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  join_code  text not null unique default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8)),
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  username     text not null,
  created_at   timestamptz not null default now()
);

-- Returns the caller's household (security definer so RLS on members
-- doesn't recurse when policies call it).
create or replace function public.my_household()
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.members where user_id = auth.uid()
$$;

create or replace function public.create_household(p_name text, p_username text)
returns uuid language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then
    raise exception 'already in a household';
  end if;
  insert into households(name) values (coalesce(nullif(trim(p_name), ''), 'Home')) returning id into hid;
  insert into members(user_id, household_id, username) values (auth.uid(), hid, p_username);
  return hid;
end $$;

create or replace function public.join_household(p_code text, p_username text)
returns uuid language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then
    raise exception 'already in a household';
  end if;
  select id into hid from households where join_code = upper(trim(p_code));
  if hid is null then raise exception 'invalid join code'; end if;
  insert into members(user_id, household_id, username) values (auth.uid(), hid, p_username);
  return hid;
end $$;

-- Groceries ----------------------------------------------------------------

create table if not exists public.groceries (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.my_household() references public.households(id) on delete cascade,
  name         text not null,
  qty          text,
  added_by     uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- Meal voting --------------------------------------------------------------

create table if not exists public.meal_options (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.my_household() references public.households(id) on delete cascade,
  name         text not null,
  status       text not null default 'open' check (status in ('open', 'chosen', 'archived')),
  created_by   uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);

create table if not exists public.votes (
  option_id    uuid not null references public.meal_options(id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  household_id uuid not null default public.my_household() references public.households(id) on delete cascade,
  value        smallint not null check (value in (-1, 1)),
  primary key (option_id, user_id)
);

-- Row-level security -------------------------------------------------------

alter table public.households   enable row level security;
alter table public.members      enable row level security;
alter table public.groceries    enable row level security;
alter table public.meal_options enable row level security;
alter table public.votes        enable row level security;

drop policy if exists "own household" on public.households;
create policy "own household" on public.households
  for select using (id = public.my_household());

drop policy if exists "household members" on public.members;
create policy "household members" on public.members
  for select using (household_id = public.my_household());

drop policy if exists "household groceries" on public.groceries;
create policy "household groceries" on public.groceries
  for all using (household_id = public.my_household())
  with check (household_id = public.my_household());

drop policy if exists "household meals" on public.meal_options;
create policy "household meals" on public.meal_options
  for all using (household_id = public.my_household())
  with check (household_id = public.my_household());

drop policy if exists "read household votes" on public.votes;
create policy "read household votes" on public.votes
  for select using (household_id = public.my_household());

drop policy if exists "own votes" on public.votes;
create policy "own votes" on public.votes
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid() and household_id = public.my_household());

-- Grants (RLS above still decides which rows are visible) -----------------

revoke all on public.households, public.members, public.groceries, public.meal_options, public.votes from anon;
grant select on public.households, public.members to authenticated;
grant select, insert, update, delete on public.groceries, public.meal_options, public.votes to authenticated;
revoke execute on function public.create_household(text, text), public.join_household(text, text), public.my_household() from public, anon;
grant execute on function public.create_household(text, text), public.join_household(text, text), public.my_household() to authenticated;

-- Live updates so you see each other's votes instantly ----------------------

do $$
begin
  alter publication supabase_realtime add table public.groceries, public.meal_options, public.votes;
exception when duplicate_object then null;
end $$;

-- Calendar + regulars (also in migrations/002_calendar_regulars.sql) --------

create table if not exists public.dishes (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.my_household() references public.households(id) on delete cascade,
  name         text not null check (length(trim(name)) > 0),
  kind         text not null default 'home' check (kind in ('home', 'out')),
  place        text,
  created_by   uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create unique index if not exists dishes_unique_name on public.dishes (household_id, kind, lower(name));

create table if not exists public.meals_eaten (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.my_household() references public.households(id) on delete cascade,
  eaten_on     date not null default current_date,
  slot         text check (slot in ('breakfast', 'lunch', 'dinner', 'snack')),
  name         text not null check (length(trim(name)) > 0),
  kind         text not null default 'home' check (kind in ('home', 'out')),
  place        text,
  dish_id      uuid references public.dishes(id) on delete set null,
  created_by   uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists meals_eaten_by_day on public.meals_eaten (household_id, eaten_on);

alter table public.meal_options add column if not exists kind text not null default 'home' check (kind in ('home', 'out'));
alter table public.meal_options add column if not exists dish_id uuid references public.dishes(id) on delete set null;

alter table public.dishes      enable row level security;
alter table public.meals_eaten enable row level security;

drop policy if exists "household dishes" on public.dishes;
create policy "household dishes" on public.dishes
  for all using (household_id = public.my_household())
  with check (household_id = public.my_household());

drop policy if exists "household meals eaten" on public.meals_eaten;
create policy "household meals eaten" on public.meals_eaten
  for all using (household_id = public.my_household())
  with check (household_id = public.my_household());

revoke all on public.dishes, public.meals_eaten from anon;
grant select, insert, update, delete on public.dishes, public.meals_eaten to authenticated;

do $$ begin alter publication supabase_realtime add table public.dishes;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.meals_eaten;
exception when duplicate_object then null; end $$;

-- One regular everywhere (also in migrations/003_one_dish_everywhere.sql) -----

alter table public.dishes add column if not exists archived boolean not null default false;

-- Find-or-create a regular by name (case/whitespace-insensitive). Un-archives it if needed.
create or replace function public.ensure_dish(p_name text, p_kind text default 'home', p_place text default null)
returns uuid language plpgsql set search_path = public as $$
declare did uuid;
begin
  insert into dishes(name, kind, place)
  values (regexp_replace(trim(p_name), '\s+', ' ', 'g'), coalesce(p_kind, 'home'), nullif(trim(p_place), ''))
  on conflict (household_id, kind, lower(name)) do update
    set archived = false, place = coalesce(dishes.place, excluded.place)
  returning id into did;
  return did;
end $$;

-- Link existing rows to their regulars (creating any that are missing).
insert into public.dishes(household_id, name, kind, place)
select distinct on (household_id, kind, lower(regexp_replace(trim(name), '\s+', ' ', 'g')))
       household_id, regexp_replace(trim(name), '\s+', ' ', 'g'), kind, place
from (
  select household_id, name, kind, place from public.meals_eaten where dish_id is null
  union all
  select household_id, name, kind, null from public.meal_options where dish_id is null
) x
order by household_id, kind, lower(regexp_replace(trim(name), '\s+', ' ', 'g')), place nulls last
on conflict (household_id, kind, lower(name)) do nothing;

update public.meals_eaten m set dish_id = d.id from public.dishes d
where m.dish_id is null and d.household_id = m.household_id and d.kind = m.kind
  and lower(d.name) = lower(regexp_replace(trim(m.name), '\s+', ' ', 'g'));
update public.meal_options o set dish_id = d.id from public.dishes d
where o.dish_id is null and d.household_id = o.household_id and d.kind = o.kind
  and lower(d.name) = lower(regexp_replace(trim(o.name), '\s+', ' ', 'g'));

-- Keep name/kind on calendar entries and vote options in sync with their regular.
create or replace function public.link_dish()
returns trigger language plpgsql set search_path = public as $$
declare d dishes%rowtype;
begin
  if new.dish_id is null then
    new.dish_id := ensure_dish(new.name, new.kind, to_jsonb(new) ->> 'place');
  end if;
  select * into d from dishes where id = new.dish_id;
  if not found then raise exception 'unknown dish'; end if;
  new.name := d.name;
  new.kind := d.kind;
  return new;
end $$;

drop trigger if exists link_dish on public.meals_eaten;
create trigger link_dish before insert or update on public.meals_eaten
  for each row execute function public.link_dish();
drop trigger if exists link_dish on public.meal_options;
create trigger link_dish before insert or update on public.meal_options
  for each row execute function public.link_dish();

create or replace function public.sync_dish_name()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.name is distinct from old.name or new.kind is distinct from old.kind then
    update meals_eaten  set name = new.name, kind = new.kind where dish_id = new.id;
    update meal_options set name = new.name, kind = new.kind where dish_id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists sync_dish_name on public.dishes;
create trigger sync_dish_name after update on public.dishes
  for each row execute function public.sync_dish_name();

-- No duplicates: one open vote option per regular, one entry per regular per meal per day.
update public.meal_options set status = 'archived'
where id in (
  select id from (
    select id, row_number() over (partition by household_id, dish_id order by created_at) rn
    from public.meal_options where status = 'open'
  ) t where rn > 1
);
create unique index if not exists meal_options_one_open on public.meal_options (household_id, dish_id) where status = 'open';
create unique index if not exists meals_eaten_once on public.meals_eaten (household_id, eaten_on, coalesce(slot, ''), dish_id);

revoke execute on function public.ensure_dish(text, text, text) from public, anon;
grant execute on function public.ensure_dish(text, text, text) to authenticated;
