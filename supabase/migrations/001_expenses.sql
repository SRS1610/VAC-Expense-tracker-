-- VAC Expense Tracker schema.
-- Both tables are locked down with row level security and NO policies for the
-- anon/authenticated roles, so the only way in is through the edge function,
-- which uses the service role key after checking the shared access code.

create extension if not exists pgcrypto;

create table if not exists public.expenses (
  id            uuid primary key default gen_random_uuid(),
  expense_date  date not null,
  description   text not null check (length(description) between 1 and 200),
  category      text not null check (length(category) between 1 and 60),
  paid_with     text not null check (length(paid_with) between 1 and 40),
  amount        numeric(12,2) not null check (amount > 0),
  notes         text check (notes is null or length(notes) <= 300),
  created_at    timestamptz not null default now()
);

create index if not exists expenses_date_idx on public.expenses (expense_date desc, created_at desc);
create index if not exists expenses_category_idx on public.expenses (category);

create table if not exists public.app_settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

alter table public.expenses enable row level security;
alter table public.app_settings enable row level security;

-- Belt and braces: even if a policy is added later, anon and authenticated
-- have no table privileges at all.
revoke all on public.expenses from anon, authenticated;
revoke all on public.app_settings from anon, authenticated;
