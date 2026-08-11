-- =============================================================================
-- DrMonster AI — Supabase schema
-- Run this once in your Supabase project:  Dashboard → SQL Editor → New query →
-- paste this whole file → Run.  It is safe to re-run (idempotent).
-- =============================================================================

-- gen_random_uuid() is available via pgcrypto (enabled by default on Supabase).
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- COMPANIES  (company details + one set of bank details + logo reference)
-- -----------------------------------------------------------------------------
create table if not exists public.companies (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  -- company
  name                 text not null,
  address              text,
  city                 text,
  country              text,
  tax_number           text,
  registration_number  text,
  phone                text,
  email                text,
  website              text,
  default_currency     text default 'USD',
  notes                text,
  -- bank information
  bank_name            text,
  bank_address         text,
  account_holder       text,
  iban                 text,
  account_number       text,
  swift_bic            text,
  -- logo (object path inside the private "company-logos" storage bucket)
  logo_path            text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists companies_user_id_idx on public.companies(user_id);

-- -----------------------------------------------------------------------------
-- DOCUMENTS  (persistent invoice/document records)
-- Seller/buyer are stored both as a live FK (for lookups) and as a JSON snapshot
-- (so an issued document keeps its exact wording even if the company is edited).
-- -----------------------------------------------------------------------------
create table if not exists public.documents (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  number           text,
  number_mode      text default 'auto',      -- auto | manual
  doc_date         date,
  currency         text default 'USD',
  seller_id        uuid references public.companies(id) on delete set null,
  buyer_id         uuid references public.companies(id) on delete set null,
  seller_snapshot  jsonb,
  buyer_snapshot   jsonb,
  items            jsonb not null default '[]'::jsonb,  -- [{description,quantity,unit,unitPrice}]
  shipping_route   text,
  payment_terms    text,
  notes            text,
  logo_mode        text default 'auto',      -- auto | custom | hidden
  logo_size        text default 'medium',    -- small | medium | large
  custom_logo_path text,
  status           text default 'draft',     -- draft | finalized
  subtotal         numeric default 0,
  total            numeric default 0,
  revision         int  default 1,           -- revision counter (1 = original)
  revision_of      uuid references public.documents(id) on delete set null, -- root/original invoice
  finalized_at     timestamptz,
  -- edit-existing-document: the preserved uploaded original + what was extracted from it
  source_file_path text,                      -- object path in the private "source-documents" bucket
  source_file_name text,
  source_file_type text,
  source_extraction jsonb,                    -- fields Claude read from the uploaded file (for reference)
  -- contracts (Contract Maker): invoices and contracts share this table
  document_type    text not null default 'invoice',  -- invoice | contract
  contract         jsonb,                     -- {ctype, terms{}, clauses[], sig{}} for document_type='contract'
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists documents_user_id_idx on public.documents(user_id);

-- Migration helpers (safe on an already-created table from an earlier version):
alter table public.documents add column if not exists number_mode  text default 'auto';
alter table public.documents add column if not exists subtotal     numeric default 0;
alter table public.documents add column if not exists revision     int default 1;
alter table public.documents add column if not exists revision_of  uuid references public.documents(id) on delete set null;
alter table public.documents add column if not exists finalized_at timestamptz;
alter table public.documents add column if not exists updated_at   timestamptz not null default now();
alter table public.documents add column if not exists source_file_path  text;
alter table public.documents add column if not exists source_file_name  text;
alter table public.documents add column if not exists source_file_type  text;
alter table public.documents add column if not exists source_extraction jsonb;
alter table public.documents add column if not exists document_type text not null default 'invoice';
alter table public.documents add column if not exists contract      jsonb;

-- -----------------------------------------------------------------------------
-- APP SETTINGS  (per-user workspace settings, e.g. invoice-number format)
-- -----------------------------------------------------------------------------
create table if not exists public.app_settings (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

drop policy if exists app_settings_select_own on public.app_settings;
drop policy if exists app_settings_insert_own on public.app_settings;
drop policy if exists app_settings_update_own on public.app_settings;

create policy app_settings_select_own on public.app_settings
  for select using (auth.uid() = user_id);
create policy app_settings_insert_own on public.app_settings
  for insert with check (auth.uid() = user_id);
create policy app_settings_update_own on public.app_settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- updated_at trigger
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists companies_set_updated_at on public.companies;
create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security — each user only ever sees / touches their own rows.
-- The public "anon" API key is safe in the browser because RLS enforces this.
-- -----------------------------------------------------------------------------
alter table public.companies enable row level security;
alter table public.documents enable row level security;

drop policy if exists companies_select_own on public.companies;
drop policy if exists companies_insert_own on public.companies;
drop policy if exists companies_update_own on public.companies;
drop policy if exists companies_delete_own on public.companies;

create policy companies_select_own on public.companies
  for select using (auth.uid() = user_id);
create policy companies_insert_own on public.companies
  for insert with check (auth.uid() = user_id);
create policy companies_update_own on public.companies
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy companies_delete_own on public.companies
  for delete using (auth.uid() = user_id);

drop policy if exists documents_select_own on public.documents;
drop policy if exists documents_insert_own on public.documents;
drop policy if exists documents_update_own on public.documents;
drop policy if exists documents_delete_own on public.documents;

create policy documents_select_own on public.documents
  for select using (auth.uid() = user_id);
create policy documents_insert_own on public.documents
  for insert with check (auth.uid() = user_id);
create policy documents_update_own on public.documents
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy documents_delete_own on public.documents
  for delete using (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- STORAGE — private bucket for company logos.
-- Object paths are  "<user_id>/<filename>"  so the first path segment is used
-- to enforce per-user access.  The bucket is PRIVATE; logos are read through
-- short-lived signed URLs generated on the client with the anon key + user JWT.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'company-logos', 'company-logos', false, 5242880,
  array['image/png','image/jpeg','image/webp','image/svg+xml']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists logos_select_own on storage.objects;
drop policy if exists logos_insert_own on storage.objects;
drop policy if exists logos_update_own on storage.objects;
drop policy if exists logos_delete_own on storage.objects;

create policy logos_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'company-logos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy logos_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'company-logos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy logos_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'company-logos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'company-logos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy logos_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'company-logos' and (storage.foldername(name))[1] = auth.uid()::text);

-- -----------------------------------------------------------------------------
-- STORAGE — private bucket for UPLOADED ORIGINAL documents (edit-existing flow).
-- Originals are preserved here and never overwritten. Path is "<user_id>/<file>".
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'source-documents', 'source-documents', false, 10485760,
  array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/png','image/jpeg']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists sources_select_own on storage.objects;
drop policy if exists sources_insert_own on storage.objects;
drop policy if exists sources_delete_own on storage.objects;

create policy sources_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'source-documents' and (storage.foldername(name))[1] = auth.uid()::text);

create policy sources_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'source-documents' and (storage.foldername(name))[1] = auth.uid()::text);

-- Intentionally no UPDATE/DELETE-all policy: originals are write-once + read.
create policy sources_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'source-documents' and (storage.foldername(name))[1] = auth.uid()::text);

-- =============================================================================
-- COMPANY RISK INTELLIGENCE  (standalone module — separate from Document Maker)
-- Owner-only RLS, same convention as the rest of the app. Safe / idempotent.
-- =============================================================================
create table if not exists public.risk_investigations (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  company_name        text not null,
  country             text,
  registration_number text,
  website             text,
  address             text,
  status              text default 'complete',   -- running | complete | error
  risk_score          int  default 0,
  risk_level          text default 'unknown',    -- low | moderate | high | critical | unknown
  confidence          text default 'low',        -- very_high | high | medium | low
  data_coverage       int  default 0,            -- 0..100
  direct_sanctions    text default 'unknown',    -- clear | potential | match | unknown | unavailable
  country_exposure    text default 'unknown',    -- clear | low | moderate | high | critical | unknown | unavailable
  summary             text,
  providers           jsonb default '[]'::jsonb, -- audit: [{key,label,status,checkedAt,dataDate,version}]
  result              jsonb,                     -- full normalized dashboard snapshot
  watchlisted         boolean default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists risk_investigations_user_idx on public.risk_investigations(user_id, created_at desc);

create table if not exists public.risk_findings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  investigation_id uuid not null references public.risk_investigations(id) on delete cascade,
  category         text,      -- sanctions | country_exposure | relationship | ownership | director | pep | adverse_media | corporate | trade
  subject          text,      -- entity the finding is about
  related_entity   text,
  country          text,
  relationship     text,      -- distributor | supplier | subsidiary | shareholder | ubo | director | customer | ...
  match_type       text,      -- confirmed | potential | no_match | manual_review | info
  temporality      text,      -- current | historical | unknown
  directness       text,      -- direct | indirect | unknown
  confidence       text,      -- very_high | high | medium | low
  evidence         text,
  source           text,
  source_url       text,
  evidence_date    date,
  retrieved_at     timestamptz default now(),
  decision         text default 'open',  -- open | confirmed | potential | false_positive | needs_review | dismissed
  decision_note    text,
  decided_at       timestamptz,
  data             jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists risk_findings_inv_idx on public.risk_findings(investigation_id);
create index if not exists risk_findings_user_idx on public.risk_findings(user_id);

create table if not exists public.risk_watchlist (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  investigation_id uuid references public.risk_investigations(id) on delete set null,
  company_name     text not null,
  country          text,
  last_score       int,
  last_level       text,
  created_at       timestamptz not null default now()
);
create index if not exists risk_watchlist_user_idx on public.risk_watchlist(user_id);

drop trigger if exists risk_investigations_set_updated_at on public.risk_investigations;
create trigger risk_investigations_set_updated_at
  before update on public.risk_investigations
  for each row execute function public.set_updated_at();

alter table public.risk_investigations enable row level security;
alter table public.risk_findings enable row level security;
alter table public.risk_watchlist enable row level security;

drop policy if exists risk_inv_all_own on public.risk_investigations;
create policy risk_inv_all_own on public.risk_investigations
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists risk_find_all_own on public.risk_findings;
create policy risk_find_all_own on public.risk_findings
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists risk_watch_all_own on public.risk_watchlist;
create policy risk_watch_all_own on public.risk_watchlist
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Done.
