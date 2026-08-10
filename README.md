# DrMonster AI — Deployment

DrMonster AI is a **static single-page app** (`index.html`, no build framework) served
by a tiny standard Node.js server (`server.js`). Data, auth and storage run on
**Supabase**; the **Claude** integration runs in **Supabase Edge Functions** (so the
Anthropic key never touches the browser).

> This is **not** a Next.js project — there's no framework build to run. `npm start`
> launches a plain Node server that serves the page and injects your public Supabase
> config from environment variables.

## What deploys where

| Part | Where it runs |
|------|---------------|
| The web app (`index.html` + `server.js`) | **Railway** (this repo) |
| Database, Auth, Storage | **Supabase** (your project) |
| Claude AI functions (`supabase/functions/*`) | **Supabase** (deployed with the Supabase CLI) |

## Scripts

- `npm run build` — validates the static files (no framework compile needed).
- `npm start` — runs `node server.js`, listening on Railway's `$PORT`.

## Environment variables to add in Railway → Variables

| Name | Value | Notes |
|------|-------|-------|
| `SUPABASE_URL` | your Supabase Project URL | Supabase → Project Settings → API |
| `SUPABASE_ANON_KEY` | your Supabase anon/public key | public + RLS-protected; safe in the browser |

`PORT` is set automatically by Railway — don't add it. `ANTHROPIC_API_KEY` is **not** a
Railway variable; it's a Supabase secret (see `SUPABASE_SETUP.md`).

## Deploy from GitHub to Railway (step by step)

1. **Supabase (once):** run `supabase/schema.sql` in the SQL Editor, and deploy the
   functions + key — see `SUPABASE_SETUP.md`.
2. **Push this repo to GitHub** (see the assistant's instructions).
3. On <https://railway.app> → **New Project → Deploy from GitHub repo** → pick this repo.
4. Railway auto-detects Node, runs `npm install` → `npm run build` → `npm start`.
5. Open **Variables** and add `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
6. Open **Settings → Networking → Generate Domain** to get your public URL.
7. In **Supabase → Authentication → URL Configuration**, set **Site URL** to that
   Railway URL and add it under **Redirect URLs** (so email confirmation links work).

Full walkthrough is in the chat instructions and `SUPABASE_SETUP.md`.
