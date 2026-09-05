-- Start fresh: wipe every match, ball and player from the database.
--
-- Paste into the Supabase SQL editor and Run. This is deliberately a manual
-- step rather than a button in the app: a real scorebook should never have a
-- one-tap "delete the season" control, and the row level security refuses to
-- delete anything outside a test series precisely so it cannot happen by
-- accident from a phone.
--
-- KEPT: your login, the admin allowlist, and the general settings.
-- GONE:  players, teams, series, squads, matches, innings, every delivery.

begin;

-- Children first, so nothing trips a foreign key on the way out.
delete from public.deliveries;
delete from public.match_events;
delete from public.innings_snapshot;
delete from public.innings;
delete from public.matches;
delete from public.squad_players;
delete from public.squads;
delete from public.series;
delete from public.players;
delete from public.jerseys;

-- The activity log is history, not data — clear it too if you want silence.
-- delete from public.audit_log;

commit;

-- Check: every one of these should read 0.
select
  (select count(*) from public.players)    as players,
  (select count(*) from public.jerseys)    as teams,
  (select count(*) from public.series)     as series,
  (select count(*) from public.matches)    as matches,
  (select count(*) from public.innings)    as innings,
  (select count(*) from public.deliveries) as deliveries;
