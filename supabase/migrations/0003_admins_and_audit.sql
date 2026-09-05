-- Admins, and the activity log.
--
-- The app already had these locally; this is the same model in Postgres:
--   * one super admin, fixed here, who cannot be demoted or removed
--   * he is the only one who can grant or revoke admin
--   * every change is attributable to the email that made it

-- ---------------------------------------------------------------------------
-- The super admin
-- ---------------------------------------------------------------------------

create or replace function public.super_admin_email()
returns text
language sql
immutable
as $$
  select 'akarsha.kng@gmail.com'::text;
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and lower(p.email) = public.super_admin_email()
  );
$$;

-- A new user is a scorer, except the super admin, who is an admin from his
-- very first sign-in so there is never a chicken-and-egg lockout.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (
    new.id,
    new.email,
    case when lower(new.email) = public.super_admin_email() then 'admin' else 'scorer' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Only the super admin hands out admin, and nobody can demote him.
create or replace function public.guard_role_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    if not public.is_super_admin() then
      raise exception 'only the super admin can change roles';
    end if;
    if lower(old.email) = public.super_admin_email() then
      raise exception 'the super admin cannot be demoted';
    end if;
  end if;
  return new;
end;
$$;

-- 0001 granted only SELECT on profiles. The super admin needs UPDATE to hand
-- out admin; the trigger below is what stops anyone else from using it.
grant update on public.profiles to authenticated;

drop trigger if exists profiles_guard_role_trg on public.profiles;
create trigger profiles_guard_role_trg
  before update on public.profiles
  for each row execute function public.guard_role_changes();

-- ---------------------------------------------------------------------------
-- Activity log — who changed what, and when
-- ---------------------------------------------------------------------------

-- Deliveries and match_events already carry created_by. This covers everything
-- that is not a ball: the pool, squads, series, matches, the toss and settings.
create table if not exists public.audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid references public.profiles (id),
  actor_email text,
  action     text not null,
  detail     text,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_recent_idx on public.audit_log (created_at desc);

alter table public.audit_log enable row level security;

grant select, insert on public.audit_log to authenticated;

-- Staff can write their own lines and read the log; it is not public.
create policy audit_read_staff on public.audit_log
  for select to authenticated using (public.is_staff());

create policy audit_insert_staff on public.audit_log
  for insert to authenticated
  with check (public.is_staff() and (actor_id is null or actor_id = auth.uid()));

-- The log is append-only: no update policy, and no delete grant.
revoke delete, update on public.audit_log from authenticated, anon;

-- Stamp the actor automatically so a client cannot write someone else's name.
create or replace function public.audit_set_actor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.actor_id := auth.uid();
  new.actor_email := (select p.email from public.profiles p where p.id = auth.uid());
  return new;
end;
$$;

drop trigger if exists audit_set_actor_trg on public.audit_log;
create trigger audit_set_actor_trg
  before insert on public.audit_log
  for each row execute function public.audit_set_actor();

-- ---------------------------------------------------------------------------
-- Belt and braces on the private tables.
--
-- Supabase grants SELECT on new public tables to anon by default, and today
-- these return nothing only because no policy admits an anonymous reader.
-- Taking the grant away too means a permissive policy added later still cannot
-- expose emails or the activity log to the public.
-- ---------------------------------------------------------------------------

revoke all on public.profiles from anon;
revoke all on public.audit_log from anon;
revoke all on public.app_settings from anon;
