# VAC Expense Ledger

A shared expense tracker for Veterans Advocate Center. One web page, one Postgres
table, hosted entirely on Supabase. Anyone with the link and the shared access code
can add, filter, delete and export expenses; everyone sees the same ledger.

## Where things live

| Piece | Path / place |
|---|---|
| The page (design, form, ledger, CSV export) | `index.html` |
| Database schema | `supabase/migrations/001_expenses.sql`, `002_users.sql` |
| Hosting + API (serves the page, checks the code, talks to the DB) | `supabase/functions/expense-tracker/index.ts` |
| Generated copy of the page for the function | `supabase/functions/expense-tracker/page.ts` (run `./build.sh`) |

Supabase project: `wnykwdqnlzjjyozlibtg` (SRS1610's Org, Sydney region).

API (live): https://wnykwdqnlzjjyozlibtg.supabase.co/functions/v1/expense-tracker/api

## Hosting the page

The function also answers `GET` with the page, but Supabase rewrites HTML from
functions on the default `*.supabase.co` domain to plain text, so a browser shows
source code there. Host the `public/` folder (just `index.html`) somewhere else; it
already points at the live API, so nothing in it needs changing.

Target address: **vac-expense**.

- **Netlify (recommended, free)** → `https://vac-expense.netlify.app`
  1. Sign in at https://app.netlify.com (free account).
  2. Open https://app.netlify.com/drop and drag the `public` folder onto it.
  3. Site settings → Site details → Change site name → `vac-expense`.
  4. To update later: run `./build.sh`, then drag `public` onto the site's
     Deploys page again.
- **GitHub Pages (free)** → `https://<your-username>.github.io/vac-expense/`
  1. Create a public repository named `vac-expense`.
  2. Upload `public/index.html` to it (rename is not needed; keep it `index.html`).
  3. Settings → Pages → Source: Deploy from branch, `main`, folder `/ (root)`.
- **Supabase custom domain** (paid add-on): then the function's own `GET` route
  serves the page directly.

## How access works

- Each staff member signs in with a username and password. Accounts live in
  `app_users` with bcrypt-hashed passwords; sessions live in `app_sessions` and
  last 30 days per device, or until the person clicks **Sign out**.
- Every table has row level security on and no policies, so the public API keys
  cannot read or write anything. Only the edge function (which holds the service
  role key) touches the database, and only with a valid session.
- Anyone signed in can change their own password from the **Change password**
  button in the header.
- Each expense records who added it (shown in the row tooltip and the CSV).

### Manage accounts

Run these in the Supabase SQL editor for the project (Database → SQL).

Add a person (username: lowercase letters, digits, `.`, `_`, `-`):

```sql
select public.add_user('jane', 'a-starting-password', 'Jane Doe');
```

Reset someone's password:

```sql
select public.set_password((select id from public.app_users where username = 'jane'), 'new-password');
```

Remove a person (their sessions go too):

```sql
delete from public.app_users where username = 'jane';
```

See who has accounts:

```sql
select username, display_name, created_at from public.app_users order by username;
```

## Change categories, payment methods or currency

1. Edit the `CATEGORIES`, `METHODS`, `CURRENCY` and `LOCALE` constants near the
   top of the script in `index.html`.
2. Mirror any category or method change in the `CATEGORIES` / `METHODS` sets in
   `supabase/functions/expense-tracker/index.ts` (the function rejects values it
   does not know).
3. Run `./build.sh`, then redeploy the function (Supabase CLI:
   `supabase functions deploy expense-tracker --no-verify-jwt`, or ask Claude to
   redeploy through the Supabase connector).

## Export

**Export CSV** downloads whatever the ledger is currently showing (respecting the
category pill and month filter), oldest first, with a notes column.

## Local preview

Open `index.html` directly in a browser. It talks to the live function at the
`DEPLOYED_API` address in the script, so the live data appears after you sign in.
