# What Are We Eating 🍲

A tiny web app for two people sharing a kitchen:

- **Groceries**: log what you have this week, and tap ✕ when something's used up.
- **Next meal**: suggest meals, both vote 👍/👎, then pick the winner. Votes show up live on both phones.

Username and password login. It's a static site on GitHub Pages, with data stored in [Supabase](https://supabase.com) (free tier).

## Privacy

The code is public, but your data isn't. Every table uses Postgres row-level security
([`supabase/schema.sql`](supabase/schema.sql)), so a signed-in user can only read or write rows
that belong to their own household. The Supabase *anon key* in `config.js` is designed to be public.
**Never** commit the `service_role` key.

## One-time setup (about 5 minutes)

1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query**, paste all of `supabase/schema.sql`, then click **Run**.
3. **Authentication → Sign In / Providers → Email**: turn **off** “Confirm email”. Usernames are mapped
   to pseudo-emails, so no mail can be delivered.
4. **Project Settings → API**: copy the **Project URL** and **anon public** key into `config.js`, then commit and push.
5. Open the site, **Sign up** with a username and password, then **Create** a household.
   Go to the 🏠 tab and send the join code to your partner. They sign up and **Join** with that code.
6. Optional but recommended: once you've both signed up, go to **Authentication → Sign In / Providers**
   and turn off **Allow new users to sign up**.

## Local dev

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.
