-- Database tests: row-level security + one-regular-everywhere rules.
-- Paste into Supabase → SQL Editor and run ("Run without RLS" if asked; that
-- only concerns the temp results table). Everything happens in one transaction
-- that ends in an error on purpose, so NOTHING is saved. The error message is
-- the report: every line should start with PASS.

create temp table r(n serial, ok boolean, step text, got text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;
create function pg_temp.chk(step text, got text, want text) returns void language sql as
  $$ insert into r(ok, step, got) values (got is not distinct from want, step, coalesce(got, 'NULL')) $$;
grant execute on function pg_temp.chk(text, text, text) to authenticated, anon;

insert into auth.users(id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@t.test'),
  ('aaaaaaaa-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','b@t.test'),
  ('aaaaaaaa-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','c@t.test');

-- Alice creates a household and adds things ---------------------------------
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}',true);
select pg_temp.chk('before joining: sees no households', (select count(*)::text from households), '0');
select public.create_household('Test home','alice');
do $$ begin perform public.create_household('Second','alice');
  perform pg_temp.chk('create a 2nd household is refused', 'allowed', 'refused');
exception when others then perform pg_temp.chk('create a 2nd household is refused', 'refused', 'refused'); end $$;
insert into groceries(name, qty) values ('Spinach','1 bunch');
insert into meals_eaten(name, kind, slot) values ('  Kadi   Khichadi ', 'home', 'dinner');
insert into meal_options(name, kind) values ('KADI KHICHADI', 'home');
select pg_temp.chk('calendar + vote with odd case/spaces → 1 regular', (select count(*)::text from dishes), '1');
select pg_temp.chk('regular name is cleaned', (select name from dishes), 'Kadi Khichadi');
select pg_temp.chk('calendar and vote point at the same regular', (select count(distinct dish_id)::text from (select dish_id from meals_eaten union all select dish_id from meal_options) x), '1');
select pg_temp.chk('vote option shows the regular''s name', (select name from meal_options), 'Kadi Khichadi');
insert into votes(option_id, value) select id, 1 from meal_options;
do $$ begin insert into votes(option_id, value) select id, 2 from meal_options;
  perform pg_temp.chk('vote value must be ±1', 'allowed', 'refused');
exception when others then perform pg_temp.chk('vote value must be ±1', 'refused', 'refused'); end $$;
do $$ begin insert into meal_options(name, kind) values ('kadi khichadi', 'home');
  perform pg_temp.chk('duplicate open vote option refused', 'allowed', 'refused');
exception when unique_violation then perform pg_temp.chk('duplicate open vote option refused', 'refused', 'refused'); end $$;
do $$ begin insert into meals_eaten(name, kind, slot) values ('kadi khichadi', 'home', 'dinner');
  perform pg_temp.chk('same meal, same day+slot refused', 'allowed', 'refused');
exception when unique_violation then perform pg_temp.chk('same meal, same day+slot refused', 'refused', 'refused'); end $$;
insert into meals_eaten(name, kind, slot) values ('kadi khichadi', 'home', 'lunch');
select pg_temp.chk('same meal, different slot allowed', (select count(*)::text from meals_eaten), '2');
insert into meals_eaten(name, kind, slot) values ('Kadi Khichadi', 'out', 'snack');
select pg_temp.chk('same name eaten out is its own regular', (select string_agg(kind, ',' order by kind) from dishes), 'home,out');
do $$ begin insert into meals_eaten(name, kind) values ('   ', 'home');
  perform pg_temp.chk('blank meal name refused', 'allowed', 'refused');
exception when others then perform pg_temp.chk('blank meal name refused', 'refused', 'refused'); end $$;
do $$ begin insert into meals_eaten(name, kind) values ('Tea', 'delivery');
  perform pg_temp.chk('kind must be home/out', 'allowed', 'refused');
exception when others then perform pg_temp.chk('kind must be home/out', 'refused', 'refused'); end $$;
update dishes set name = 'Kadhi khichdi' where kind = 'home';
select pg_temp.chk('rename flows to calendar', (select string_agg(distinct name, ',') from meals_eaten where kind = 'home'), 'Kadhi khichdi');
select pg_temp.chk('rename flows to vote', (select name from meal_options), 'Kadhi khichdi');
do $$ begin update dishes set name = 'KADHI KHICHDI ' where kind = 'out'; update dishes set name = 'kadhi khichdi' where kind = 'out';
  perform pg_temp.chk('rename to a different-kind name is fine', 'ok', 'ok');
exception when others then perform pg_temp.chk('rename to a different-kind name is fine', sqlerrm, 'ok'); end $$;
insert into dishes(name, kind) values ('Poha', 'home');
do $$ begin update dishes set name = 'poha' where name = 'Kadhi khichdi' and kind = 'home';
  perform pg_temp.chk('rename onto another regular refused', 'allowed', 'refused');
exception when unique_violation then perform pg_temp.chk('rename onto another regular refused', 'refused', 'refused'); end $$;
update dishes set archived = true where name = 'Poha';
select public.ensure_dish('  POHA ', 'home');
select pg_temp.chk('re-adding a removed regular brings it back (no copy)', (select count(*)::text || '/' || bool_or(archived)::text from dishes where lower(name) = 'poha'), '1/false');
select pg_temp.chk('ensure_dish returns the same id every time', (select (public.ensure_dish('poha','home') = public.ensure_dish('Poha ','home'))::text), 'true');

-- Bob joins with the code -----------------------------------------------------
reset role;
select set_config('t.code', (select join_code from households where name = 'Test home'), true);
select set_config('t.hid', (select id::text from households where name = 'Test home'), true);
select set_config('t.did', (select d.id::text from dishes d join households h on h.id = d.household_id where h.name = 'Test home' limit 1), true);
select set_config('t.oid', (select o.id::text from meal_options o join households h on h.id = o.household_id where h.name = 'Test home' limit 1), true);
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-0000-0000-000000000002","role":"authenticated"}',true);
do $$ begin perform public.join_household('WRONG000','bob');
  perform pg_temp.chk('wrong join code refused', 'allowed', 'refused');
exception when others then perform pg_temp.chk('wrong join code refused', 'refused', 'refused'); end $$;
select public.join_household(lower(current_setting('t.code')),'bob');
select pg_temp.chk('join code is case-insensitive; Bob sees members', (select count(*)::text from members), '2');
select pg_temp.chk('Bob sees the shared groceries', (select count(*)::text from groceries), '1');
insert into votes(option_id, value) values (current_setting('t.oid')::uuid, 1);
select pg_temp.chk('both votes visible', (select count(*)::text from votes), '2');
do $$ begin update votes set value = -1 where user_id <> auth.uid();
  perform pg_temp.chk('Bob cannot change Alice''s vote', (select string_agg(value::text, ',' order by value) from votes), '1,1');
end $$;

-- Carol, another household, tries to get in -----------------------------------
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-0000-0000-000000000003","role":"authenticated"}',true);
select public.create_household('Other home','carol');
select pg_temp.chk('Carol sees none of their groceries', (select count(*)::text from groceries), '0');
select pg_temp.chk('Carol sees none of their regulars', (select count(*)::text from dishes), '0');
select pg_temp.chk('Carol sees none of their calendar', (select count(*)::text from meals_eaten), '0');
select pg_temp.chk('Carol sees none of their votes', (select count(*)::text from votes), '0');
select pg_temp.chk('Carol sees only her household', (select count(*)::text from households), '1');
do $$ begin insert into groceries(name, household_id) values ('x', current_setting('t.hid')::uuid);
  perform pg_temp.chk('Carol cannot write into their household', 'allowed', 'refused');
exception when others then perform pg_temp.chk('Carol cannot write into their household', 'refused', 'refused'); end $$;
do $$ begin insert into meals_eaten(dish_id, name, kind) values (current_setting('t.did')::uuid, 'x', 'home');
  perform pg_temp.chk('Carol cannot link to their regular', 'allowed', 'refused');
exception when others then perform pg_temp.chk('Carol cannot link to their regular', 'refused', 'refused'); end $$;
do $$ begin insert into votes(option_id, value, household_id) values (current_setting('t.oid')::uuid, 1, current_setting('t.hid')::uuid);
  perform pg_temp.chk('Carol cannot vote in their round', 'allowed', 'refused');
exception when others then perform pg_temp.chk('Carol cannot vote in their round', 'refused', 'refused'); end $$;
update dishes set name = 'hacked';
delete from groceries;
reset role;
select pg_temp.chk('their data untouched by Carol', (select count(*)::text from groceries g where g.household_id = current_setting('t.hid')::uuid) || '/' || (select count(*)::text from dishes d where d.household_id = current_setting('t.hid')::uuid and d.name = 'hacked'), '1/0');

-- Not signed in -----------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$ begin perform count(*) from groceries;
  perform pg_temp.chk('signed-out visitor cannot read', 'allowed', 'refused');
exception when others then perform pg_temp.chk('signed-out visitor cannot read', 'refused', 'refused'); end $$;
do $$ begin perform public.ensure_dish('x', 'home');
  perform pg_temp.chk('signed-out visitor cannot call functions', 'allowed', 'refused');
exception when others then perform pg_temp.chk('signed-out visitor cannot call functions', 'refused', 'refused'); end $$;
reset role;

-- Report (and roll everything back) ----------------------------------------------
do $$ begin raise exception E'DB TESTS (rolled back, nothing saved): % passed, % failed\n%',
  (select count(*) from r where ok), (select count(*) from r where not ok),
  (select string_agg(case when ok then 'PASS ' else 'FAIL ' end || step || case when ok then '' else ' (got ' || got || ')' end, E'\n' order by n) from r);
end $$;
