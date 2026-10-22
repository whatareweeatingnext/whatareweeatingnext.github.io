# What Are We Eating Next 🍲

A tiny web app for two people sharing a kitchen:

- **🗳️ Vote**: suggest meals (🏠 home or 🍽️ out), both vote 👍/👎, then pick the winner. Votes show up live on both phones.
  "It's been a while" lists regulars you haven't had in 2+ weeks, one tap to add them to the vote.
- **📅 Calendar**: a month view of what you ate. Picking a vote winner logs it automatically, or add meals to any day by hand.
- **⭐ Regulars**: two lists, things you make at home and things you eat out (with the place), each showing when you last had it.
- **🧺 Groceries**: log what you have this week, and tap ✕ when something's used up.

Username and password login. It's a static site on GitHub Pages, at https://whatareweeatingnext.github.io, with data stored in [Supabase](https://supabase.com) (free tier).

## Privacy

The code is public, but your data isn't. Every table uses Postgres row-level security
([`supabase/schema.sql`](supabase/schema.sql)), so a signed-in user can only read or write rows
that belong to their own household. The Supabase *publishable key* in `config.js` is designed to be public.
**Never** commit a secret or `service_role` key.

## One-time setup (about 5 minutes)

1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query**, paste all of `supabase/schema.sql`, then click **Run**.
   (Databases created before the calendar existed only need `supabase/migrations/002_calendar_regulars.sql`.)
3. **Authentication → Sign In / Providers → Email**: turn **off** “Confirm email”. Usernames are mapped
   to pseudo-emails, so no mail can be delivered.
4. **Project Settings → API**: copy the **Project URL** (Settings → Data API) and the **publishable** key (Settings → API Keys) into `config.js`, then commit and push.
5. Open the site, **Sign up** with a username and password, then **Create** a household.
   Go to the 🏠 tab and send the join code to your partner. They sign up and **Join** with that code.
6. Optional but recommended: once you've both signed up, go to **Authentication → Sign In / Providers**
   and turn off **Allow new users to sign up**.

## Tests

```sh
npm install        # once; only installs playwright-core (uses your installed Chrome)
npm test           # unit + UI tests
npm run test:unit  # just the logic in lib.js (dates, staleness, scoring, calendar)
npm run test:ui    # clicks through the real page in headless Chrome at phone sizes
```

- `tests/unit/` tests the pure helpers in `lib.js` with Node's built-in test runner.
- `tests/ui/` drives `index.html` with Playwright against `tests/ui/fake-supabase.js`, an
  in-memory stand-in that mirrors the database rules, so no real data is touched.
- `tests/db/db_test.sql` checks row-level security and the one-regular-everywhere rules on the
  real database. Paste it into the Supabase SQL Editor and run it: it rolls itself back and
  reports PASS/FAIL per check in the error message.

GitHub Actions runs the unit and UI tests on every push.

## Local dev

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.
