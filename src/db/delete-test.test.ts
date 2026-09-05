import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('delete-test-series.sql', () => {
  it('removes test series and their cricket, and leaves real series alone', async () => {
    const db = new PGlite();
    await db.exec(readFileSync('supabase/tests/00_auth_stub.sql', 'utf8'));
    await db.exec(readFileSync('supabase/setup.sql', 'utf8'));

    await db.exec(`
      insert into public.players (id, name) values
        ('00000000-0000-0000-0000-000000000001','A'),
        ('00000000-0000-0000-0000-000000000002','B');
      insert into public.jerseys (id, name) values
        ('00000000-0000-0000-0000-0000000000b1','T1'),
        ('00000000-0000-0000-0000-0000000000b2','T2');
      insert into public.series (id, name, is_test) values
        ('00000000-0000-0000-0000-0000000000c1','Practice', true),
        ('00000000-0000-0000-0000-0000000000c2','Real', false);
      insert into public.squads (id, series_id, jersey_id) values
        ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1'),
        ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b2'),
        ('00000000-0000-0000-0000-0000000000d3','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000b1'),
        ('00000000-0000-0000-0000-0000000000d4','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000b2');
      insert into public.squad_players (squad_id, series_id, player_id) values
        ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-000000000001'),
        ('00000000-0000-0000-0000-0000000000d3','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-000000000002');
      insert into public.matches (id, series_id, match_no, squad_a_id, squad_b_id) values
        ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000c1',1,'00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2'),
        ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000c2',1,'00000000-0000-0000-0000-0000000000d3','00000000-0000-0000-0000-0000000000d4');
      insert into public.innings (id, match_id, seq, batting_squad_id, bowling_squad_id) values
        ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000e1',1,'00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d2'),
        ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000e2',1,'00000000-0000-0000-0000-0000000000d3','00000000-0000-0000-0000-0000000000d4');
      insert into public.deliveries (id, innings_id, seq, over_no, ball_no, bowler_id, striker_id) values
        ('00000000-0000-0000-0000-000000000901','00000000-0000-0000-0000-0000000000f1',1,0,1,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002'),
        ('00000000-0000-0000-0000-000000000902','00000000-0000-0000-0000-0000000000f2',1,0,1,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');
    `);

    await db.exec(readFileSync('supabase/delete-test-series.sql', 'utf8'));

    const row = (
      await db.query(`select
        (select count(*)::int from public.series)     as series,
        (select count(*)::int from public.matches)    as matches,
        (select count(*)::int from public.innings)    as innings,
        (select count(*)::int from public.deliveries) as deliveries,
        (select count(*)::int from public.squads)     as squads,
        (select count(*)::int from public.players)    as players`)
    ).rows[0] as Record<string, number>;

    // Exactly the real series survives, with its match and its ball.
    expect(row).toEqual({ series: 1, matches: 1, innings: 1, deliveries: 1, squads: 2, players: 2 });
  });
});
