-- Delete every test series, and nothing else.
--
-- Only series marked as a test are touched: their squads, matches, innings and
-- every ball. Real series, and the player pool and team names, are untouched.
--
-- Paste into the Supabase SQL editor and Run.

begin;

with test_series as (
  select id from public.series where is_test
),
test_matches as (
  select m.id from public.matches m join test_series t on t.id = m.series_id
),
test_innings as (
  select i.id from public.innings i join test_matches tm on tm.id = i.match_id
)
delete from public.deliveries d where d.innings_id in (select id from test_innings);

with test_series as (
  select id from public.series where is_test
),
test_matches as (
  select m.id from public.matches m join test_series t on t.id = m.series_id
)
delete from public.match_events e where e.match_id in (select id from test_matches);

with test_series as (
  select id from public.series where is_test
),
test_matches as (
  select m.id from public.matches m join test_series t on t.id = m.series_id
),
test_innings as (
  select i.id from public.innings i join test_matches tm on tm.id = i.match_id
)
delete from public.innings_snapshot s where s.innings_id in (select id from test_innings);

with test_series as (
  select id from public.series where is_test
),
test_matches as (
  select m.id from public.matches m join test_series t on t.id = m.series_id
)
delete from public.innings i where i.match_id in (select id from test_matches);

delete from public.matches m
  where m.series_id in (select id from public.series where is_test);

delete from public.squad_players sp
  where sp.series_id in (select id from public.series where is_test);

delete from public.squads q
  where q.series_id in (select id from public.series where is_test);

delete from public.series where is_test;

commit;

-- What is left. Test counts should be 0; the real ones are your record.
select
  (select count(*) from public.series where is_test)     as test_series_left,
  (select count(*) from public.series)                   as series_kept,
  (select count(*) from public.matches)                  as matches_kept,
  (select count(*) from public.deliveries)               as deliveries_kept,
  (select count(*) from public.players)                  as players_kept,
  (select count(*) from public.jerseys)                  as teams_kept;
