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
