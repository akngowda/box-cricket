-- Clear every match, keep the people.
--
-- For when the pool and the team names are real but the cricket was practice.
-- Paste into the Supabase SQL editor and Run.
--
-- KEPT: players, teams (jerseys), your login, the admin allowlist, settings.
-- GONE: every series, squad, match, innings and ball.

begin;

delete from public.deliveries;
delete from public.match_events;
delete from public.innings_snapshot;
delete from public.innings;
delete from public.matches;
delete from public.squad_players;
delete from public.squads;
delete from public.series;

commit;

select
  (select count(*) from public.players)    as players_kept,
  (select count(*) from public.jerseys)    as teams_kept,
  (select count(*) from public.series)     as series,
  (select count(*) from public.matches)    as matches,
  (select count(*) from public.deliveries) as deliveries;
