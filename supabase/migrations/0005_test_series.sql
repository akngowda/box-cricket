-- Test series.
--
-- Trying the app out creates real rows, and they should not clutter the real
-- record forever. A series marked as a test can be deleted outright, matches
-- and balls and all. A series that is NOT marked is permanent: nothing can
-- delete it, which is the whole point of an append-only scorebook.

alter table public.series
  add column if not exists is_test boolean not null default false;

create index if not exists series_test_idx on public.series (is_test) where is_test;

-- Is this innings part of a series someone marked as a test?
create or replace function public.innings_is_test(p_innings uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(s.is_test, false)
  from public.innings i
  join public.matches m on m.id = i.match_id
  join public.series  s on s.id = m.series_id
  where i.id = p_innings;
$$;

create or replace function public.match_is_test(p_match uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(s.is_test, false)
  from public.matches m
  join public.series s on s.id = m.series_id
  where m.id = p_match;
$$;

-- 0002 revoked DELETE on the log from everyone. Hand back exactly one case:
-- an admin clearing a test series. A real ball still cannot be deleted by
-- anybody — it is voided, never removed.
grant delete on public.deliveries to authenticated;

drop policy if exists deliveries_delete_test_only on public.deliveries;
create policy deliveries_delete_test_only on public.deliveries
  for delete to authenticated
  using (public.is_admin() and public.innings_is_test(innings_id));

grant delete on public.innings, public.match_events to authenticated;

drop policy if exists innings_delete_test_only on public.innings;
create policy innings_delete_test_only on public.innings
  for delete to authenticated
  using (public.is_admin() and public.match_is_test(match_id));

drop policy if exists match_events_delete_test_only on public.match_events;
create policy match_events_delete_test_only on public.match_events
  for delete to authenticated
  using (public.is_admin() and public.match_is_test(match_id));

-- Matches and series themselves: admins already have full write access, so
-- narrow deletion to test rows only.
drop policy if exists matches_write_admin on public.matches;
create policy matches_write_admin on public.matches
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists matches_delete_test_only on public.matches;
create policy matches_delete_test_only on public.matches
  for delete to authenticated
  using (public.is_admin() and public.match_is_test(id));

drop policy if exists series_delete_test_only on public.series;
create policy series_delete_test_only on public.series
  for delete to authenticated
  using (public.is_admin() and is_test);
