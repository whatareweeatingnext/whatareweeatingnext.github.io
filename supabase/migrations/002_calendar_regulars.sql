-- Calendar of meals eaten + regular dishes (home-made and eaten out).
-- Already included in schema.sql; run this alone on databases created before it.

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
