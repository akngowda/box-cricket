-- Who walked in.
--
-- The scorer chooses the next batsman, but there was nowhere to keep that
-- choice: the delivery recorded the wicket and not the man who replaced him.
-- The score is always derived by replaying the log, so on the very next replay
-- the engine fell back to "next available", which is alphabetical — and the
-- wrong batsman took guard.

alter table public.deliveries
  add column if not exists new_batsman_id uuid references public.players (id);
