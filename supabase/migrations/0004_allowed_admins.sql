-- Who is allowed to have an account at all.
--
-- There are no invitations and no open sign-up. The super admin adds an email
-- to this list; only then can that person create their own password. Anyone
-- else who tries is refused by the database, not by the interface — so it
-- cannot be bypassed by calling the API directly.

create table if not exists public.allowed_admins (
  email      text primary key,
  added_by   uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

-- The super admin is on the list by definition, so the very first sign-in
-- works with nothing seeded by hand.
insert into public.allowed_admins (email)
values (public.super_admin_email())
on conflict (email) do nothing;

-- Sign-up gate. An email that is not on the list never gets a profile, and
-- raising here aborts the auth.users insert as well.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  addr text := lower(new.email);
begin
  if addr is distinct from public.super_admin_email()
     and not exists (select 1 from public.allowed_admins a where lower(a.email) = addr) then
    raise exception 'This email has not been added by the administrator';
  end if;

  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'admin')
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Only the super admin edits the list.
-- ---------------------------------------------------------------------------

alter table public.allowed_admins enable row level security;

grant select, insert, delete on public.allowed_admins to authenticated;
revoke all on public.allowed_admins from anon;

drop policy if exists allowed_admins_read_staff on public.allowed_admins;
create policy allowed_admins_read_staff on public.allowed_admins
  for select to authenticated using (public.is_staff());

drop policy if exists allowed_admins_insert_super on public.allowed_admins;
create policy allowed_admins_insert_super on public.allowed_admins
  for insert to authenticated with check (public.is_super_admin());

drop policy if exists allowed_admins_delete_super on public.allowed_admins;
create policy allowed_admins_delete_super on public.allowed_admins
  for delete to authenticated
  using (public.is_super_admin() and lower(email) <> public.super_admin_email());

-- Stamp who added the row, and keep the address tidy.
create or replace function public.allowed_admins_prepare()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.email := lower(btrim(new.email));
  new.added_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists allowed_admins_prepare_trg on public.allowed_admins;
create trigger allowed_admins_prepare_trg
  before insert on public.allowed_admins
  for each row execute function public.allowed_admins_prepare();
