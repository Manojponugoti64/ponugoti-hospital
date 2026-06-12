# Ponugoti Hospital — Patient Records System

A simple, internal patient records system for **Ponugoti Hospital**. Staff (reception, lab, nurses, doctors, admin) sign in to:

- Register patients with MRN, demographics, contact, history
- Record admissions: ward, bed, doctor, complaints, diagnosis
- Log investigations / lab results per admission
- Write discharge summaries
- Print A4-ready discharge summary for the patient

Built as a static site (HTML + CSS + vanilla JS) deployed to GitHub Pages. Authentication, database, and row-level security are handled by [Supabase](https://supabase.com) on its free tier.

**Live site:** https://manojponugoti64.github.io/ponugoti-hospital/

> **Status (2026-06-12):** The system is live and in use. The database schema, row-level
> security, billing tables, and the admin account (`ponugotimanojkumar@gmail.com`) are all
> set up. If you are returning to this project, you do **not** need to redo the one-time
> setup below — it is kept for reference and for setting up a fresh copy.

---

## One-time setup

You only have to do this once. After this, daily use is just "open the site, sign in, work".
**This has already been done for the live deployment** — skip to [Daily use](#daily-use)
unless you are standing up a brand-new project.

### 1. Apply the database schema

1. Open the [Supabase SQL Editor](https://supabase.com/dashboard/project/guudjjhraialvabauixz/sql/new).
2. Open [`schema.sql`](./schema.sql) in this repo, copy its full contents.
3. Paste into the SQL editor and click **Run** (bottom-right). You should see "Success. No rows returned."

This creates the tables (`profiles`, `patients`, `admissions`, `investigations`), the roles enum, RLS policies, and a trigger that auto-creates a profile row when a new auth user is added.

### 2. Create the first user (you — admin)

1. Open [Authentication → Users](https://supabase.com/dashboard/project/guudjjhraialvabauixz/auth/users).
2. Click **Add user → Create new user**.
3. Enter your email and a password you'll remember. Tick **Auto Confirm User**.
4. Click **Create**.

### 3. Promote yourself to admin

In the [SQL editor](https://supabase.com/dashboard/project/guudjjhraialvabauixz/sql/new), run (replace the email):

```sql
update public.profiles
   set role = 'admin', full_name = 'Dr. Manoj Kumar'
 where id = (select id from auth.users where email = 'you@example.com');
```

### 4. Add more staff

Add them via Authentication → Users. After they appear in the list, open the **Staff** page on the live site (only admins can see it) and set their full name + role.

Roles:

| Role       | Can do |
|------------|--------|
| admin      | Everything, plus manage staff and delete records |
| doctor     | Edit patient, admission, diagnosis, discharge summary, investigations |
| nurse      | Edit patient, admission, investigations |
| lab        | Add / edit investigations only |
| reception  | Register patients, edit admission dates/demographics |

---

## Daily use

1. Open the live site
2. Sign in with your email + password
3. Work — list/search patients, register new ones, open a patient and add admissions and investigations
4. On discharge: fill the discharge fields, click **Print discharge summary**, print or save as PDF for the patient

### Backups

On the dashboard, click **Download backup**. You get a JSON file containing all patients, admissions, investigations, and profiles. Recommend doing this **once a week** and saving to your Google Drive.

The Supabase free tier does **not** include automatic point-in-time recovery, so these
manual backups are your safety net. Treat the weekly download as non-optional for real
patient data.

---

## Keeping the backend awake (important)

Supabase **free-tier projects auto-pause after ~7 days with no activity.** When a project
is paused, its domain stops resolving and the **entire site stops working** — staff cannot
sign in and no data loads. (This is exactly what happened once already; restoring the
project from the Supabase dashboard brings it back, but any downtime is disruptive in a
hospital.)

To prevent this, the repo includes a scheduled GitHub Actions workflow,
[`.github/workflows/keepalive.yml`](.github/workflows/keepalive.yml), that pings the
backend every 3 days so it never goes idle. It uses only the public anon key — no secrets
to configure.

**For this to run, the workflow must be on the `main` branch** (merge the PR that added
it). You can confirm it is working from the repo's **Actions** tab — you should see
"Supabase Keep-Alive" runs succeeding, and you can trigger one manually with **Run workflow**.

Caveats:

- GitHub disables scheduled workflows after **60 days of no repo activity**. If nobody
  touches the repo for two months, re-enable it from the Actions tab (or push any commit).
- The keep-alive is a free best-effort safeguard. For a backend that is **guaranteed** never
  to pause (and that includes daily backups + point-in-time recovery), upgrade the Supabase
  project to the **Pro plan** (~$25/month). For a hospital handling real patient records,
  this is worth considering.

---

## Tech stack

- **Frontend**: HTML + CSS + vanilla JavaScript (no build step). Hosted on GitHub Pages.
- **Auth + DB**: [Supabase](https://supabase.com) free tier (PostgreSQL, Auth, Row-Level Security)
- **Cost**: ₹0 / month while you stay under 500 MB DB + 50 K monthly logins

Files:

- `index.html` — auto-redirect to login or dashboard
- `login.html` — staff sign-in
- `dashboard.html` — patient list + search + backup
- `new-patient.html` — register a patient
- `patient.html` — patient detail: demographics, admissions, investigations, discharge editor
- `print-discharge.html` — printable A4 discharge summary
- `admin.html` — staff role management (admin only)
- `app.js` — shared client utilities (auth, formatting, role gating, topbar)
- `config.js` — Supabase URL + anon key (public by design)
- `style.css` — all styles
- `schema.sql` — core schema (profiles, patients, admissions, investigations, billing) + RLS
- `migrations/0002_harden_function_security.sql` — security hardening applied on top of the schema
- `.github/workflows/keepalive.yml` — keeps the free-tier backend from auto-pausing

---

## Security & compliance notes

- The anon key in `config.js` is **public by design**. Data is protected by Row-Level
  Security policies on the database (see `schema.sql`). RLS is enabled on every table and
  read access is scoped to signed-in staff only — an anonymous request returns no patient
  data.
- A security-hardening migration ([`migrations/0002_harden_function_security.sql`](migrations/0002_harden_function_security.sql))
  has been applied: function `search_path`s are pinned and `SECURITY DEFINER` helper
  functions are no longer callable through the public API. This cleared the Supabase
  database-linter warnings.
- **One manual hardening step remains** (10 seconds, Supabase dashboard):
  **Authentication → Policies → enable "Leaked password protection"**
  ([docs](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)).
  This blocks staff from choosing passwords known to be compromised.
- Real patient data has legal implications under India's Digital Personal Data Protection
  Act 2023. You as the hospital operator are the data fiduciary. Keep:
  - Strong Supabase dashboard password + 2FA
  - Don't share staff login credentials
  - Run regular backups (see above — the weekly **Download backup** is your only recovery
    path on the free tier)
- After any database schema change, re-check the Supabase **Advisors** tab (or ask the
  Supabase dashboard) for new security/performance warnings.

---

## License

Proprietary — for use by Ponugoti Hospital only.
