-- Username + password accounts, replacing the shared access code.
-- Passwords are hashed with bcrypt inside Postgres (pgcrypto), so an account can
-- be added or reset with one SQL statement. The edge function checks logins
-- through verify_login() and keeps sessions in app_sessions.

create table if not exists public.app_users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique check (username = lower(username) and username ~ '^[a-z0-9._-]{2,40}$'),
  password_hash text not null,
  display_name  text not null check (length(display_name) between 1 and 80),
  created_at    timestamptz not null default now()
);

create table if not exists public.app_sessions (
  token       text primary key,
  user_id     uuid not null references public.app_users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists app_sessions_user_idx on public.app_sessions (user_id);

alter table public.expenses add column if not exists added_by text;

alter table public.app_users enable row level security;
alter table public.app_sessions enable row level security;
revoke all on public.app_users from anon, authenticated;
revoke all on public.app_sessions from anon, authenticated;

-- Returns the user's id when the username/password pair is right, else null.
create or replace function public.verify_login(p_username text, p_password text)
returns uuid
language sql
security definer
set search_path = public, extensions
as $$
  select id from public.app_users
  where username = lower(trim(p_username))
    and password_hash = crypt(p_password, password_hash)
  limit 1;
$$;

-- Sets a new password for a user (hashing happens here).
create or replace function public.set_password(p_user_id uuid, p_password text)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update public.app_users set password_hash = crypt(p_password, gen_salt('bf'))
  where id = p_user_id;
$$;

-- Creates an account. Used from the SQL editor to add staff.
create or replace function public.add_user(p_username text, p_password text, p_display_name text)
returns uuid
language sql
security definer
set search_path = public, extensions
as $$
  insert into public.app_users (username, password_hash, display_name)
  values (lower(trim(p_username)), crypt(p_password, gen_salt('bf')), trim(p_display_name))
  returning id;
$$;

-- Only the service role (the edge function) may call these.
revoke all on function public.verify_login(text, text) from public, anon, authenticated;
revoke all on function public.set_password(uuid, text) from public, anon, authenticated;
revoke all on function public.add_user(text, text, text) from public, anon, authenticated;

-- The shared access code is retired.
delete from public.app_settings where key = 'access_code';
