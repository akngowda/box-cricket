-- Box Cricket — Row Level Security (02-ARCHITECTURE §4, R35, R35a)
--
-- The shape of it:
--   anon           reads everything a viewer needs, writes nothing (R35)
--   scorer         writes deliveries and match_events for HIS match, plus
--                  players (R1 lets him add to the pool mid-match)
--   admin          everything else
--   nobody         deletes a delivery. Void it instead (R7d).

-- ---------------------------------------------------------------------------
-- Helpers. security definer so a policy can read profiles without recursing
-- into profiles' own policies.
-- ---------------------------------------------------------------------------

create or replace function public.auth_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.role from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.auth_role() = 'admin', false);
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.auth_role() in ('admin', 'scorer'), false);
$$;

-- Admin, or the scorer this match is assigned to.
create or replace function public.can_score_match(p_match uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
      or exists (
        select 1 from public.matches m
        where m.id = p_match
          and m.scorer_id = auth.uid()
          and public.auth_role() = 'scorer'
      );
$$;

create or replace function public.can_score_innings(p_innings uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.innings i
    where i.id = p_innings and public.can_score_match(i.match_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- Grants. RLS filters rows; grants decide whether a verb is reachable at all.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;

-- R35 — public viewing, no login.
grant select on
  public.players, public.jerseys, public.series, public.squads,
  public.squad_players, public.matches, public.innings, public.deliveries,
  public.match_events, public.innings_snapshot
to anon, authenticated;

grant insert, update on
  public.players, public.jerseys, public.series, public.squads,
  public.squad_players, public.matches, public.innings, public.deliveries,
  public.match_events, public.innings_snapshot, public.app_settings
to authenticated;

grant select on public.profiles, public.app_settings to authenticated;
grant delete on public.players, public.jerseys, public.series, public.squads,
                public.squad_players to authenticated;   -- R35a, admin-gated below

-- No DELETE path on the log, for anyone (§4). Voiding is an UPDATE.
revoke delete on public.deliveries from anon, authenticated;

alter table public.profiles          enable row level security;
alter table public.players           enable row level security;
alter table public.jerseys           enable row level security;
alter table public.series            enable row level security;
alter table public.squads            enable row level security;
alter table public.squad_players     enable row level security;
alter table public.matches           enable row level security;
alter table public.innings           enable row level security;
alter table public.deliveries        enable row level security;
alter table public.match_events      enable row level security;
alter table public.innings_snapshot  enable row level security;
alter table public.app_settings      enable row level security;

-- ---------------------------------------------------------------------------
-- Public read (R35). Soft-deleted rows stay readable so old scorecards never
-- break (R35a) — the UI hides them, history does not.
-- ---------------------------------------------------------------------------

create policy players_read_all          on public.players          for select to anon, authenticated using (true);
create policy jerseys_read_all          on public.jerseys          for select to anon, authenticated using (true);
create policy series_read_all           on public.series           for select to anon, authenticated using (true);
create policy squads_read_all           on public.squads           for select to anon, authenticated using (true);
create policy squad_players_read_all    on public.squad_players    for select to anon, authenticated using (true);
create policy matches_read_all          on public.matches          for select to anon, authenticated using (true);
create policy innings_read_all          on public.innings          for select to anon, authenticated using (true);
create policy deliveries_read_all       on public.deliveries       for select to anon, authenticated using (true);
create policy match_events_read_all     on public.match_events     for select to anon, authenticated using (true);
create policy innings_snapshot_read_all on public.innings_snapshot for select to anon, authenticated using (true);

-- Profiles and settings are not public: emails, and settings are an admin tool.
create policy profiles_read_self_or_admin on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_update_admin on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy app_settings_read_staff on public.app_settings
  for select to authenticated using (public.is_staff());
create policy app_settings_write_admin on public.app_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- The pool (R1) — a scorer may add a player mid-match; only an admin edits or
-- deletes one (R35a).
-- ---------------------------------------------------------------------------

create policy players_insert_staff on public.players
  for insert to authenticated with check (public.is_staff());
create policy players_update_staff on public.players
  for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy players_delete_admin on public.players
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Competition setup — admin only (R35).
-- ---------------------------------------------------------------------------

create policy jerseys_write_admin on public.jerseys
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy series_write_admin on public.series
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy squads_write_admin on public.squads
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy matches_write_admin on public.matches
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- R1a — roster changes happen mid-match, so the match's scorer can make them
-- too. Everything else about a squad stays admin-only.
create policy squad_players_insert_staff on public.squad_players
  for insert to authenticated with check (public.is_staff());
create policy squad_players_update_staff on public.squad_players
  for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy squad_players_delete_admin on public.squad_players
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Scoring — the assigned scorer, or an admin.
-- ---------------------------------------------------------------------------

create policy innings_insert_scorer on public.innings
  for insert to authenticated with check (public.can_score_match(match_id));
create policy innings_update_scorer on public.innings
  for update to authenticated
  using (public.can_score_match(match_id))
  with check (public.can_score_match(match_id));

create policy deliveries_insert_scorer on public.deliveries
  for insert to authenticated with check (public.can_score_innings(innings_id));
-- Update exists only so a ball can be voided (R7d); the append-only trigger in
-- 0001 makes sure nothing else about it can change.
create policy deliveries_update_scorer on public.deliveries
  for update to authenticated
  using (public.can_score_innings(innings_id))
  with check (public.can_score_innings(innings_id));

create policy match_events_insert_scorer on public.match_events
  for insert to authenticated with check (public.can_score_match(match_id));
create policy match_events_update_admin on public.match_events
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy innings_snapshot_write_scorer on public.innings_snapshot
  for insert to authenticated with check (public.can_score_innings(innings_id));
create policy innings_snapshot_update_scorer on public.innings_snapshot
  for update to authenticated
  using (public.can_score_innings(innings_id))
  with check (public.can_score_innings(innings_id));
