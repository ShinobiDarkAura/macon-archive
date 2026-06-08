# Maçon Archive — Setup

This is a single-page web app (`index.html`) that runs anywhere and syncs your
collector archive across all devices via Supabase. It works in three steps:
**(1) Supabase** for the synced, private database, **(2) paste two config values**
into `index.html`, **(3) GitHub Pages** to host it at a URL you can open anywhere.

It also runs fine with **no setup at all** — just open `index.html` and it works
in local-only mode (data lives in that one browser). Do the steps below when you
want it synced across your and Hannah's devices.

---

## 1 · Supabase (the synced database)

1. Go to **supabase.com** → create a free account → **New project**.
   Pick a name (e.g. `macon`), set a database password, choose a region near you.
2. When the project finishes provisioning, open the left sidebar → **SQL Editor**
   → **New query**. Paste the entire contents of `schema.sql` (next to this file)
   and click **Run**. This creates the `collectors` table and locks access to only
   your two emails.
3. **IMPORTANT — set your emails:** in `schema.sql`, before running, replace
   `alex@studiomacon.co` and `hannah@studiomacon.co` with your real email
   addresses. Only those emails will ever be able to sign in and see the data.
4. Left sidebar → **Project Settings** → **API**. Copy two values:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **anon public** key (a long string under "Project API keys")
5. Left sidebar → **Authentication** → **Providers** → make sure **Email** is
   enabled (it is by default). Magic-link sign-in uses this.

## 2 · Paste your config

Open `index.html`, find the `CONFIG` block near the top, and fill in the two values:

```js
const CONFIG = {
  SUPABASE_URL: "https://abcdefgh.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...your anon key...",
};
```

Save. That's it — the app will now require sign-in and sync everywhere.

> The anon key is *meant* to be public; your data is protected by the email rule
> in `schema.sql`, not by hiding the key. That's why setting your real emails in
> step 1.3 matters.

## 3 · GitHub Pages (host it at a URL)

1. Create a new GitHub repo (e.g. `macon-archive`).
2. Upload `index.html` (and optionally `SETUP.md`, `schema.sql`) to the repo.
3. Repo → **Settings** → **Pages** → under "Build and deployment", set
   **Source: Deploy from a branch**, **Branch: main**, **folder: / (root)** → Save.
4. Wait ~1 minute. Your archive is live at
   `https://<your-username>.github.io/macon-archive/`.
5. Open that URL on any device, sign in with your email, and the archive is there.

### Sign-in note
Add your GitHub Pages URL to Supabase → **Authentication** → **URL Configuration**
→ **Site URL** and **Redirect URLs**, so the magic-link email returns you to the
right place. Use `https://<your-username>.github.io/macon-archive/`.

---

## Using it day to day
- **Sign in once per device** — the session persists, so you rarely re-enter it.
- **Realtime sync** — add a collector on your phone, it appears on the laptop.
- **Export (JSON)** regularly as a backup you can keep beside your Maçon files.
- **Export (CSV)** opens straight into the spreadsheet version you already have.

## If you ever want to stop using Supabase
Clear the two CONFIG values and the app reverts to local-only mode. Your last
JSON export is your portable copy.
