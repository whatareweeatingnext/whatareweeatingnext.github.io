-- Every calendar entry and vote option points at exactly one regular (dish).
-- New names create the regular automatically; existing names reuse it.

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
