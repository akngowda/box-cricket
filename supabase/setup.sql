-- Box Cricket — complete setup.
-- Paste into the Supabase SQL editor and press Run. Safe to run again.
-- Generated from supabase/migrations/*.sql — edit those, not this.

-- ==========================================================
-- supabase/migrations/0001_init.sql
-- ==========================================================
-- Box Cricket — schema (02-ARCHITECTURE §4)
--
-- The deliveries table is the event log and is append-only. Everything else
-- exists to give a delivery its context. Rule IDs (R1, R16b, ...) refer to
-- 01-RULES-SPEC.md.

-- gen_random_uuid() is core Postgres from 13 on, so no extension is needed.

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

-- One row per logged-in human. Viewers never log in, so they have no row.
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  role         text not null default 'scorer' check (role in ('admin', 'scorer')),
  display_name text,
  created_at   timestamptz not null default now()
);

-- R1 — the permanent player pool. A player is added once and never deleted,
-- only marked inactive; R35a allows a soft delete once he has stats.
create table if not exists public.players (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) > 0),
  nickname      text,
  photo_url     text,
  batting_hand  text check (batting_hand in ('left', 'right')),
  bowling_style text,
  is_active     boolean not null default true,
  deleted_at    timestamptz,                          -- R35a soft delete
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles (id)
);

create index if not exists players_active_idx on public.players (is_active) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Durable labels vs weekly line-ups (R1)
-- ---------------------------------------------------------------------------

-- A jersey is a durable label reused week to week. It is NOT a roster, and
-- nothing is ever aggregated by it (R31).
create table if not exists public.jerseys (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  short_name text,
  colour_hex text check (colour_hex ~ '^#[0-9a-fA-F]{6}$'),
  logo_url   text,
  deleted_at timestamptz,                              -- R35a
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Competition
-- ---------------------------------------------------------------------------

create table if not exists public.series (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  season          text,
  -- R29 / decision 20 — increase only, enforced by a trigger below.
  planned_matches integer not null default 3 check (planned_matches > 0),
  status          text not null default 'setup'
                    check (status in ('setup', 'in_progress', 'completed')),
  -- R0 — the series level of the settings cascade. Shaped like RulesConfig.
  rules_config    jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  closed_at       timestamptz,
  deleted_at      timestamptz                          -- R35a
);

-- R1 — a squad is one jersey's line-up for one series. Redrawn every week.
create table if not exists public.squads (
  id               uuid primary key default gen_random_uuid(),
  series_id        uuid not null references public.series (id) on delete cascade,
  jersey_id        uuid not null references public.jerseys (id),
  name_override    text,
  -- R24 — last man is enabled per team, before the toss.
  last_man_enabled boolean not null default false,
  created_at       timestamptz not null default now(),
  unique (series_id, jersey_id)
);

-- R1a — membership is a range, never a delete: removal sets removed_at so the
-- player's stats survive (R1a, and 02-ARCHITECTURE "Roster changes as events").
create table if not exists public.squad_players (
  id                uuid primary key default gen_random_uuid(),
  squad_id          uuid not null references public.squads (id) on delete cascade,
  -- Denormalised from squads so R39 can be a partial unique index. Kept in
  -- sync by squad_players_sync_series below; callers never set it.
  series_id         uuid not null references public.series (id) on delete cascade,
  player_id         uuid not null references public.players (id),
  added_at          timestamptz not null default now(),
  added_by          uuid references public.profiles (id),
  removed_at        timestamptz,
  is_captain        boolean not null default false,
  -- R25a — this player runs for the last man.
  is_deadrunner_for uuid references public.players (id)
);

create index if not exists squad_players_squad_idx on public.squad_players (squad_id);

-- R39 — one player, one squad per series. Removed rows do not block a re-add
-- or a swap to the other squad.
create unique index if not exists squad_players_one_per_series_idx
  on public.squad_players (series_id, player_id)
  where removed_at is null;

-- squad_a_id / squad_b_id are nullable on purpose: a knockout bracket is
-- created with later rounds empty and a completion trigger fills them
-- (02-ARCHITECTURE §4). The scoring pad must refuse a match with a NULL slot.
create table if not exists public.matches (
  id                    uuid primary key default gen_random_uuid(),
  series_id             uuid not null references public.series (id) on delete cascade,
  match_no              integer not null,
  match_date            date,
  venue                 text,
  squad_a_id            uuid references public.squads (id),
  squad_b_id            uuid references public.squads (id),
  overs                 integer not null default 6 check (overs > 0),
  -- R0 — the match level of the cascade...
  rules_override        jsonb not null default '{}'::jsonb,
  -- ...and the frozen result of general <- series <- match, written at the
  -- toss (R2). The engine reads only this. Null until the toss happens.
  effective_rules       jsonb,
  status                text not null default 'scheduled'
                          check (status in ('scheduled', 'live', 'completed', 'abandoned')),
  -- R3 — the result is generated and stored the instant Spin is pressed.
  toss_calling_squad_id uuid references public.squads (id),
  toss_call             text check (toss_call in ('heads', 'tails')),
  toss_result           text check (toss_result in ('heads', 'tails')),
  toss_winner_squad_id  uuid references public.squads (id),
  toss_decision         text check (toss_decision in ('bat', 'bowl')),
  tossed_at             timestamptz,
  result_text           text,
  winner_squad_id       uuid references public.squads (id),
  scorer_id             uuid references public.profiles (id),
  created_at            timestamptz not null default now(),
  unique (series_id, match_no),
  check (squad_a_id is null or squad_b_id is null or squad_a_id <> squad_b_id)
);

create index if not exists matches_status_idx on public.matches (status);
create index if not exists matches_series_idx on public.matches (series_id, match_no);

create table if not exists public.innings (
  id                 uuid primary key default gen_random_uuid(),
  match_id           uuid not null references public.matches (id) on delete cascade,
  seq                smallint not null check (seq in (1, 2)),
  batting_squad_id   uuid not null references public.squads (id),
  bowling_squad_id   uuid not null references public.squads (id),
  target             integer,                          -- R28, second innings only
  status             text not null default 'in_progress'
                       check (status in ('in_progress', 'complete')),
  end_reason         text check (end_reason in ('overs_complete', 'all_out', 'target_reached')),
  impact_over_number smallint,                         -- R20
  last_man_active    boolean not null default false,   -- R25
  deadrunner_id      uuid references public.players (id),  -- R25a
  created_at         timestamptz not null default now(),
  unique (match_id, seq)
);

-- ---------------------------------------------------------------------------
-- THE EVENT LOG. Append only. No DELETE path — void instead (§4).
-- ---------------------------------------------------------------------------

create table if not exists public.deliveries (
  -- Client-generated UUID: a retry after a flaky network is a no-op (§4).
  id              uuid primary key,
  innings_id      uuid not null references public.innings (id) on delete cascade,
  seq             integer not null,
  over_no         smallint not null,                   -- 0-indexed
  ball_no          smallint not null,                  -- 1-indexed within the over
  bowler_id       uuid not null references public.players (id),
  striker_id      uuid not null references public.players (id),
  non_striker_id  uuid references public.players (id), -- null when last man (R25)
  -- R4 — informational; the cones made the call.
  zone            smallint check (zone between 0 and 3),
  -- R5 / R8 — which declared row was tapped. Stats only, never arithmetic.
  contact         text not null default 'none' check (contact in ('pitched', 'direct', 'none')),
  declared_runs   smallint not null default 0 check (declared_runs in (0, 1, 2, 3, 4, 6)),
  physical_runs   smallint not null default 0 check (physical_runs between 0 and 9),  -- R7
  extra_type      text not null default 'none' check (extra_type in ('none', 'wide', 'noball')),
  is_body_hit     boolean not null default false,      -- R17a
  is_roof_hit     boolean not null default false,      -- R19
  is_free_hit     boolean not null default false,      -- R12
  impact_over     boolean not null default false,      -- R20
  impact_ball     boolean not null default false,      -- R21
  -- R14 — no LBW, no byes.
  wicket_type     text check (wicket_type in ('bowled', 'caught', 'runout', 'stumped',
                                              'dotout', 'bodyout', 'retired_out',
                                              'retired_hurt')),
  player_out_id   uuid references public.players (id),
  fielder_id      uuid references public.players (id), -- R33 fielding stats
  -- Denormalised, always recomputable by replaying through the engine.
  team_runs       smallint not null default 0,
  batsman_runs    smallint not null default 0,
  bowler_conceded smallint not null default 0,
  is_voided       boolean not null default false,      -- R7d undo
  created_at      timestamptz not null default now(),
  created_by      uuid references public.profiles (id),
  unique (innings_id, seq),
  -- R7b — a wide carries nothing off the bat and only allows a stumping (R10).
  check (extra_type <> 'wide' or (declared_runs = 0 and physical_runs = 0 and not is_body_hit)),
  check (extra_type <> 'wide' or wicket_type is null or wicket_type = 'stumped'),
  -- R11 — only a run out is possible on a no-ball, and body does not count.
  check (extra_type <> 'noball' or wicket_type is null or wicket_type = 'runout'),
  check (extra_type <> 'noball' or not is_body_hit),
  -- R7b — a body hit is 0 off the bat.
  check (not is_body_hit or (declared_runs = 0 and physical_runs = 0)),
  -- R14a — only a run out can carry runs; every other dismissal scores 0.
  check (wicket_type is null or wicket_type = 'runout'
         or (declared_runs = 0 and physical_runs = 0)),
  -- R5 — the declared value must belong to the row that was tapped.
  check (
    (declared_runs = 0 and contact = 'none')
    or (contact = 'pitched' and declared_runs in (1, 2, 3))
    or (contact = 'direct'  and declared_runs in (2, 4, 6))
  ),
  check (player_out_id is not null or wicket_type is null)
);

create index if not exists deliveries_innings_seq_idx on public.deliveries (innings_id, seq);
create index if not exists deliveries_live_idx on public.deliveries (innings_id, seq) where not is_voided;

-- Everything that is not a ball (§4).
create table if not exists public.match_events (
  id         uuid primary key default gen_random_uuid(),
  match_id   uuid not null references public.matches (id) on delete cascade,
  innings_id uuid references public.innings (id) on delete cascade,
  -- Ordering against deliveries within an innings (R1a stamps the ball).
  seq        integer,
  type       text not null check (type in (
                'squad_player_added', 'squad_player_removed', 'squad_player_swapped',
                'impact_over_declared', 'impact_over_undone', 'last_man_activated',
                'deadrunner_set', 'strike_switched_manually', 'bowler_selected',
                'bowler_replaced_midover', 'retired_out', 'retired_hurt',
                'retired_hurt_returned', 'ball_voided', 'innings_start',
                'innings_end', 'match_end')),
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id)
);

create index if not exists match_events_innings_idx on public.match_events (innings_id, seq);

-- Read cache so viewers do not replay the whole log on every page load (§4).
create table if not exists public.innings_snapshot (
  innings_id uuid primary key references public.innings (id) on delete cascade,
  runs       integer not null default 0,
  wickets    integer not null default 0,
  balls      integer not null default 0,
  state      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- R0 — the three settings levels. General is seeded once and stands alone.
create table if not exists public.app_settings (
  id         uuid primary key default gen_random_uuid(),
  scope      text not null check (scope in ('general', 'series', 'match')),
  scope_id   uuid,
  config     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  check ((scope = 'general' and scope_id is null) or (scope <> 'general' and scope_id is not null))
);

create unique index if not exists app_settings_general_idx
  on public.app_settings ((scope)) where scope = 'general';
create unique index if not exists app_settings_scoped_idx
  on public.app_settings (scope, scope_id) where scope <> 'general';

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- A new auth user becomes a scorer. Promote to admin by hand (§9 step 2).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'scorer')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep squad_players.series_id honest — it exists only so R39 can be an index.
create or replace function public.squad_players_sync_series()
returns trigger
language plpgsql
as $$
begin
  select s.series_id into new.series_id from public.squads s where s.id = new.squad_id;
  if new.series_id is null then
    raise exception 'squad % does not exist', new.squad_id;
  end if;
  return new;
end;
$$;

drop trigger if exists squad_players_sync_series_trg on public.squad_players;
create trigger squad_players_sync_series_trg
  before insert or update of squad_id on public.squad_players
  for each row execute function public.squad_players_sync_series();

-- Decision 20 — planned_matches can only go up, and never below what has
-- already been played.
create or replace function public.series_planned_matches_guard()
returns trigger
language plpgsql
as $$
declare
  played integer;
begin
  if new.planned_matches < old.planned_matches then
    raise exception 'planned_matches can only be increased (was %, got %)',
      old.planned_matches, new.planned_matches;
  end if;
  select count(*) into played
  from public.matches m
  where m.series_id = new.id and m.status = 'completed';
  if new.planned_matches < played then
    raise exception 'planned_matches (%) is below the % matches already played',
      new.planned_matches, played;
  end if;
  return new;
end;
$$;

drop trigger if exists series_planned_matches_guard_trg on public.series;
create trigger series_planned_matches_guard_trg
  before update of planned_matches on public.series
  for each row execute function public.series_planned_matches_guard();

-- The log is append-only. The only field an update may touch is is_voided
-- (R7d undo); everything else about a bowled ball is history.
create or replace function public.deliveries_append_only()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(new) - 'is_voided') is distinct from (to_jsonb(old) - 'is_voided') then
    raise exception 'deliveries are append-only: only is_voided may change (R7d)';
  end if;
  return new;
end;
$$;

drop trigger if exists deliveries_append_only_trg on public.deliveries;
create trigger deliveries_append_only_trg
  before update on public.deliveries
  for each row execute function public.deliveries_append_only();

-- R2 — once the toss is recorded the rules freeze for that match.
create or replace function public.matches_freeze_rules()
returns trigger
language plpgsql
as $$
begin
  if old.effective_rules is not null
     and new.effective_rules is distinct from old.effective_rules then
    raise exception 'the effective config is frozen at the toss (R2)';
  end if;
  return new;
end;
$$;

drop trigger if exists matches_freeze_rules_trg on public.matches;
create trigger matches_freeze_rules_trg
  before update on public.matches
  for each row execute function public.matches_freeze_rules();


-- ==========================================================
-- supabase/migrations/0002_rls.sql
-- ==========================================================
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

drop policy if exists players_read_all on public.players;
create policy players_read_all          on public.players          for select to anon, authenticated using (true);
drop policy if exists jerseys_read_all on public.jerseys;
create policy jerseys_read_all          on public.jerseys          for select to anon, authenticated using (true);
drop policy if exists series_read_all on public.series;
create policy series_read_all           on public.series           for select to anon, authenticated using (true);
drop policy if exists squads_read_all on public.squads;
create policy squads_read_all           on public.squads           for select to anon, authenticated using (true);
drop policy if exists squad_players_read_all on public.squad_players;
create policy squad_players_read_all    on public.squad_players    for select to anon, authenticated using (true);
drop policy if exists matches_read_all on public.matches;
create policy matches_read_all          on public.matches          for select to anon, authenticated using (true);
drop policy if exists innings_read_all on public.innings;
create policy innings_read_all          on public.innings          for select to anon, authenticated using (true);
drop policy if exists deliveries_read_all on public.deliveries;
create policy deliveries_read_all       on public.deliveries       for select to anon, authenticated using (true);
drop policy if exists match_events_read_all on public.match_events;
create policy match_events_read_all     on public.match_events     for select to anon, authenticated using (true);
drop policy if exists innings_snapshot_read_all on public.innings_snapshot;
create policy innings_snapshot_read_all on public.innings_snapshot for select to anon, authenticated using (true);

-- Profiles and settings are not public: emails, and settings are an admin tool.
drop policy if exists profiles_read_self_or_admin on public.profiles;
create policy profiles_read_self_or_admin on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists app_settings_read_staff on public.app_settings;
create policy app_settings_read_staff on public.app_settings
  for select to authenticated using (public.is_staff());
drop policy if exists app_settings_write_admin on public.app_settings;
create policy app_settings_write_admin on public.app_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- The pool (R1) — a scorer may add a player mid-match; only an admin edits or
-- deletes one (R35a).
-- ---------------------------------------------------------------------------

drop policy if exists players_insert_staff on public.players;
create policy players_insert_staff on public.players
  for insert to authenticated with check (public.is_staff());
drop policy if exists players_update_staff on public.players;
create policy players_update_staff on public.players
  for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists players_delete_admin on public.players;
create policy players_delete_admin on public.players
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Competition setup — admin only (R35).
-- ---------------------------------------------------------------------------

drop policy if exists jerseys_write_admin on public.jerseys;
create policy jerseys_write_admin on public.jerseys
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists series_write_admin on public.series;
create policy series_write_admin on public.series
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists squads_write_admin on public.squads;
create policy squads_write_admin on public.squads
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists matches_write_admin on public.matches;
create policy matches_write_admin on public.matches
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- R1a — roster changes happen mid-match, so the match's scorer can make them
-- too. Everything else about a squad stays admin-only.
drop policy if exists squad_players_insert_staff on public.squad_players;
create policy squad_players_insert_staff on public.squad_players
  for insert to authenticated with check (public.is_staff());
drop policy if exists squad_players_update_staff on public.squad_players;
create policy squad_players_update_staff on public.squad_players
  for update to authenticated using (public.is_staff()) with check (public.is_staff());
drop policy if exists squad_players_delete_admin on public.squad_players;
create policy squad_players_delete_admin on public.squad_players
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Scoring — the assigned scorer, or an admin.
-- ---------------------------------------------------------------------------

drop policy if exists innings_insert_scorer on public.innings;
create policy innings_insert_scorer on public.innings
  for insert to authenticated with check (public.can_score_match(match_id));
drop policy if exists innings_update_scorer on public.innings;
create policy innings_update_scorer on public.innings
  for update to authenticated
  using (public.can_score_match(match_id))
  with check (public.can_score_match(match_id));

drop policy if exists deliveries_insert_scorer on public.deliveries;
create policy deliveries_insert_scorer on public.deliveries
  for insert to authenticated with check (public.can_score_innings(innings_id));
-- Update exists only so a ball can be voided (R7d); the append-only trigger in
-- 0001 makes sure nothing else about it can change.
drop policy if exists deliveries_update_scorer on public.deliveries;
create policy deliveries_update_scorer on public.deliveries
  for update to authenticated
  using (public.can_score_innings(innings_id))
  with check (public.can_score_innings(innings_id));

drop policy if exists match_events_insert_scorer on public.match_events;
create policy match_events_insert_scorer on public.match_events
  for insert to authenticated with check (public.can_score_match(match_id));
drop policy if exists match_events_update_admin on public.match_events;
create policy match_events_update_admin on public.match_events
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists innings_snapshot_write_scorer on public.innings_snapshot;
create policy innings_snapshot_write_scorer on public.innings_snapshot
  for insert to authenticated with check (public.can_score_innings(innings_id));
drop policy if exists innings_snapshot_update_scorer on public.innings_snapshot;
create policy innings_snapshot_update_scorer on public.innings_snapshot
  for update to authenticated
  using (public.can_score_innings(innings_id))
  with check (public.can_score_innings(innings_id));


-- ==========================================================
-- supabase/migrations/0003_admins_and_audit.sql
-- ==========================================================
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
drop policy if exists audit_read_staff on public.audit_log;
create policy audit_read_staff on public.audit_log
  for select to authenticated using (public.is_staff());

drop policy if exists audit_insert_staff on public.audit_log;
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


-- ==========================================================
-- supabase/migrations/0004_allowed_admins.sql
-- ==========================================================
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
drop policy if exists allowed_admins_read_staff on public.allowed_admins;
create policy allowed_admins_read_staff on public.allowed_admins
  for select to authenticated using (public.is_staff());

drop policy if exists allowed_admins_insert_super on public.allowed_admins;
drop policy if exists allowed_admins_insert_super on public.allowed_admins;
create policy allowed_admins_insert_super on public.allowed_admins
  for insert to authenticated with check (public.is_super_admin());

drop policy if exists allowed_admins_delete_super on public.allowed_admins;
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

