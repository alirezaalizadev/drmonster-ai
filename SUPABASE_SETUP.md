# DrMonster AI — Supabase setup

The app now stores companies, documents and logos in **Supabase** (Database +
Auth + Storage) instead of in-browser demo data. Follow these steps once.

> ### ⚠️ Already set this up before? Re-run the schema.
> The production invoice system, Contract Maker and now **Company Risk Intelligence**
> added new database columns and tables. Open **SQL Editor** and run
> [`supabase/schema.sql`](supabase/schema.sql) again — it is idempotent and uses
> `add column/table if not exists`, so re-running is safe and only adds what's
> missing. **Save draft / Save & finalize, and saving a risk investigation, will
> error until you do this** (e.g. "column documents.number_mode does not exist",
> "table public.app_settings not found", or "relation public.risk_investigations
> does not exist").

## 1. Create a Supabase project
1. Go to <https://supabase.com/dashboard> and sign in.
2. Click **New project**, give it a name, set a database password, pick a region,
   and wait ~1 minute for it to provision.

## 2. Create the database schema + storage bucket
1. In your project, open **SQL Editor** (left sidebar) → **New query**.
2. Open [`supabase/schema.sql`](supabase/schema.sql) from this folder, copy the
   **entire** file, paste it into the query editor, and click **Run**.
3. This creates the `companies` and `documents` tables, Row Level Security
   policies, and the private `company-logos` storage bucket. It is safe to re-run.

## 3. Get your credentials (URL + anon key)
1. In Supabase, open **Project Settings** (the gear icon, bottom-left) → **API**.
2. Copy two values:
   - **Project URL** — e.g. `https://abcdefgh.supabase.co`
   - **Project API keys → `anon` `public`** — a long string starting with `eyJ…`

> Only ever copy the **anon / public** key. Never paste the **`service_role`**
> key into the app or anywhere in the frontend — it bypasses all security. The
> anon key is designed to be public and is protected by the Row Level Security
> policies from step 2.

## 4. Enter the credentials in the app
1. Open `index.html` in a browser (double-click it, or serve the folder).
2. On the first screen (**Connect Supabase**), paste the **Project URL** and the
   **anon public** key, then click **Save & continue**.
   - These are stored only in your browser's `localStorage`. You can change them
     later under **Settings → Supabase connection**.

## 5. Create your login
1. On the **Sign in** screen, click **Create account**, enter an email + password,
   and submit.
2. **Email confirmation:** by default Supabase may require confirming your email.
   For quick testing you can turn it off:
   **Authentication → Sign In / Providers → Email → disable "Confirm email" → Save.**
   Otherwise, click the confirmation link Supabase emails you, then sign in.

That's it. You can now add companies (with bank details + logo), select seller /
buyer on a new invoice, and every document you generate is saved to Supabase.

---

## Production invoice workflow

- **Numbering** — the generator assigns numbers automatically. Set the format in
  **Settings → Invoice numbering** (tokens `{YYYY} {YY} {MM} {DD} {SEQ}` /
  `{SEQ:4}`). The counter increments each time an auto-numbered invoice is
  finalized. On any invoice you can switch **Auto → Manual** to type your own.
- **Products** — multiple rows, each with description, quantity, **unit**, unit
  price and an auto line total. Subtotal and total are computed by the app;
  currencies supported: **USD, EUR, GBP, TRY** (add more in one line of code).
- **Save draft** keeps an editable invoice. **Save & finalize** locks it and
  commits the number. A finalized invoice is never modified silently — to change
  it, use **Create revision**, which saves a new linked document (the original
  stays intact).
- **Export** — after a **Preview & export** step you can **Export PDF** (opens the
  browser's print dialog → *Save as PDF*, pixel-faithful to the preview) and
  **Export DOCX** (a real Word file). Logos are embedded with aspect ratio
  preserved; all seller/buyer/product/shipping/payment/bank details are included.

> The generator — not any AI — controls every number, date, quantity, price,
> total, currency and all company/bank data. Missing information is left blank,
> never invented.

## Edit an existing document

**Edit Document → Upload** accepts **PDF, DOCX, PNG, JPG, JPEG**. The app:

1. **Preserves your original** in the private `source-documents` bucket — it is
   write-once and **never overwritten**.
2. **Analyses it** (Claude reads the PDF/image; DOCX text is extracted in-browser)
   and **transcribes** the identifiable fields — it never invents missing values.
3. Shows the **original** next to the **extracted fields**; you then tell the
   assistant what to change and approve the **OLD → NEW** proposal.
4. Recomputes totals in app code and pulls **verified company details from your
   Companies database** for known parties (unknown parties are shown from the
   document and flagged as unverified).
5. Saves the result as a **new revision**, linked to the preserved original, with
   full revision history.

> Honesty note: the revised document is **regenerated in DrMonster's standard
> invoice format** — it is not a pixel-for-pixel edit of your uploaded file. If a
> scan or layout can't be read reliably, the app says so rather than pretending
> perfect fidelity. Your original always remains downloadable and unchanged.

---

## AI Assistant (optional but recommended)

The **Assistant** panel on the New Invoice screen turns instructions like *"Make an
invoice from Thai Textile to Karoglu for 20 winding machines at $2,500 each"* into
**proposed** fields. Claude only interprets language — it never sets bank details,
tax/registration numbers, invoice numbers, totals, or tracking numbers, and the app
matches companies against your database, validates quantities/prices, and computes
all totals before anything is applied.

**The Anthropic API key lives only on the server** (a Supabase Edge Function) — never
in the browser. To enable it:

1. **Get an Anthropic API key** — sign in at <https://console.anthropic.com>, open
   **Settings → API keys → Create key**, and copy the `sk-ant-...` value.
2. **Install the Supabase CLI** (once): <https://supabase.com/docs/guides/cli> —
   e.g. `brew install supabase/tap/supabase`, then `supabase login`.
3. **Link your project** (find the ref in your Project URL `https://<ref>.supabase.co`):
   ```bash
   supabase link --project-ref <your-project-ref>
   ```
4. **Set the key as a secret** (server-side only):
   ```bash
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-key
   ```
5. **Deploy both functions** from this folder (they share the one secret):
   ```bash
   supabase functions deploy ai-invoice
   supabase functions deploy ai-document
   ```
   - `ai-invoice` powers the New-Invoice assistant (interpret an instruction into fields).
   - `ai-document` powers **Edit Document** (read an uploaded PDF/DOCX/image and extract fields).

That's it — reload the app and use the Assistant and Edit Document. Requests are authenticated with your
Supabase login, so only signed-in users can call it. If you skip this, everything else
still works: you can always create invoices manually without AI. (The function defaults
to `claude-opus-5`; override with `supabase secrets set ANTHROPIC_MODEL=claude-sonnet-5`.)

> Never put the Anthropic key in `index.html` or the browser. It belongs only in the
> Edge Function secret above.

---

## Company Risk Intelligence (separate module)

**Company Risk Intelligence** is a standalone module (its own sidebar entry, routes,
tables and screening engine) — completely independent of Document Maker. It screens a
company for **direct sanctions**, **country/geographic exposure**, **ownership and key
people**, **trade relationships**, **PEPs** and **adverse media**, then produces an
explainable risk score with cited evidence.

### It never fabricates findings
The engine distinguishes a **provider being unavailable** from an actual **"no match"**.
With no external data providers configured it still runs, but honestly reports reduced
coverage and unavailable sources — it will not invent sanctions hits, owners, directors,
shipments, relationships or news.

### 1. Database (required to *save* investigations)
Re-run [`supabase/schema.sql`](supabase/schema.sql) (see the box at the top). It adds
`risk_investigations`, `risk_findings` and `risk_watchlist` with owner-only RLS. You can
run investigations without saving, but saving/history/watchlist need these tables.

### 2. Deploy the screening engine (required to *run* investigations)
The screening logic and all provider secrets live in one Edge Function. Deploy it the
same way as the others:
```bash
supabase functions deploy risk-screen
```
It reuses the **same `ANTHROPIC_API_KEY` secret** you already set for the AI assistant to
perform **cited web research** (relationships, ownership, adverse media) via Claude's
web-search tool. Until it's deployed, **Run Full Risk Check** will say the engine isn't
deployed. **Demo mode** in the New Check screen works without any of this — it renders
clearly-labelled *sample* data (never saved) so you can preview the interface.

### 3. Add a sanctions data provider (optional, recommended for real sanctions data)
Direct sanctions screening uses a configurable **OpenSanctions-compatible** provider. To
enable authoritative sanctions matching, set an API key as a server secret:
```bash
supabase secrets set OPENSANCTIONS_API_KEY=your-key
# optional overrides:
# supabase secrets set SANCTIONS_API_URL=https://api.opensanctions.org
# supabase secrets set RISK_JURISDICTIONS='[{"code":"IR","name":"Iran","program":"comprehensive"}, ...]'
```
Without it, the report clearly shows **"sanctions provider not configured"** in the
Sanctions and Sources tabs — which is *not* the same as "no match".

> Everything sensitive stays server-side in `risk-screen`; no provider key is ever sent
> to the browser. Requests are authenticated with the user's Supabase login and all risk
> data is protected by owner-only Row Level Security.

---

### What lives where
| Data | Location |
|------|----------|
| Company details + bank information | `public.companies` table |
| Invoice / document records (drafts, finalized, revisions) | `public.documents` table |
| Invoice-number format + counter | `public.app_settings` table |
| Company logos (PNG/JPG/JPEG/WebP/SVG) | `company-logos` **private** storage bucket |
| Auth (users, sessions) | Supabase Auth |
| AI assistant + document analysis (Claude) | `ai-invoice` + `ai-document` Edge Functions — Anthropic key is a shared server secret |
| Uploaded original documents (PDF/DOCX/PNG/JPG) | `source-documents` **private** storage bucket (write-once, preserved) |
| Company risk investigations, findings, watchlist | `public.risk_investigations` / `risk_findings` / `risk_watchlist` tables |
| Risk screening engine + provider secrets (sanctions, web research) | `risk-screen` Edge Function — `ANTHROPIC_API_KEY` (shared) + optional `OPENSANCTIONS_API_KEY` |

### Security notes
- The frontend uses **only** the public **anon** key. No `service_role` key is
  present anywhere in the client.
- All tables have **Row Level Security**: a signed-in user can only read/write
  their own companies and documents.
- The logo bucket is **private**. Logos are shown via short-lived **signed URLs**
  requested at runtime with the user's session — they are not publicly readable.
- Unauthenticated users see only the login screen; no company or document data is
  fetched until a valid session exists.
