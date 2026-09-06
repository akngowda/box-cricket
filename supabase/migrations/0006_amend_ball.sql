-- Correcting a ball after the fact.
--
-- The log stays append-only in the way that matters: a ball keeps its place,
-- its over, its bowler and its batsman for ever, and nothing is deleted. What
-- an admin may now change is what the ball was WORTH — because a scorer
-- notices a wrong total an over later, and the alternative was re-scoring the
-- rest of the innings.
--
-- Every correction is written to the activity log by the app, so the change is
-- itself part of the history.

create or replace function public.deliveries_append_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  fixed_before jsonb;
  fixed_after  jsonb;
begin
  -- Everything except the run fields and the void flag is immutable.
  fixed_before := to_jsonb(old) - 'is_voided' - 'declared_runs' - 'physical_runs'
                  - 'contact' - 'zone' - 'team_runs' - 'batsman_runs' - 'bowler_conceded';
  fixed_after  := to_jsonb(new) - 'is_voided' - 'declared_runs' - 'physical_runs'
                  - 'contact' - 'zone' - 'team_runs' - 'batsman_runs' - 'bowler_conceded';

  if fixed_before is distinct from fixed_after then
    raise exception 'a delivery keeps its over, its bowler and its batsman (R7d)';
  end if;

  -- Changing what it was worth is an admin correction, not ordinary scoring.
  if (to_jsonb(old) - 'is_voided') is distinct from (to_jsonb(new) - 'is_voided')
     and not public.is_admin() then
    raise exception 'only an admin can correct a scored ball';
  end if;

  return new;
end;
$$;
