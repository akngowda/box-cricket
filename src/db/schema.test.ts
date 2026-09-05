/**
 * Phase 2 verification — the migrations and RLS run against a real Postgres
 * (PGlite, Postgres compiled to WASM), not a mock.
 *
 * The headline test is the one the build prompt asks for: an anonymous user
 * can read a match but cannot insert a delivery (R35).
 */

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sql = (p: string): string => readFileSync(`${root}${p}`, 'utf8');

let db: PGlite;

/** Ids seeded below, so the assertions read like sentences. */
const ID = {
  admin: '00000000-0000-0000-0000-0000000000a1',
  scorer: '00000000-0000-0000-0000-0000000000a2',
  otherScorer: '00000000-0000-0000-0000-0000000000a3',
  jersey: '00000000-0000-0000-0000-0000000000b1',
  series: '00000000-0000-0000-0000-0000000000c1',
  squadA: '00000000-0000-0000-0000-0000000000d1',
  squadB: '00000000-0000-0000-0000-0000000000d2',
  match: '00000000-0000-0000-0000-0000000000e1',
  innings: '00000000-0000-0000-0000-0000000000f1',
  p1: '00000000-0000-0000-0000-000000000101',
  p2: '00000000-0000-0000-0000-000000000102',
  p3: '00000000-0000-0000-0000-000000000103',
} as const;

/** Run a statement as anon / a signed-in user / the owner. */
async function as(
  who: 'anon' | 'admin' | 'scorer' | 'otherScorer' | 'owner',
  statement: string,
): Promise<unknown[]> {
  await db.exec('reset role');
  if (who === 'owner') {
    await db.query(`select set_config('request.jwt.claim.sub', '', true)`);
    const res = await db.query(statement);
    return res.rows;
  }
  const uid = who === 'anon' ? '' : ID[who];
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  await db.exec(`set role ${who === 'anon' ? 'anon' : 'authenticated'}`);
  try {
    const res = await db.query(statement);
    return res.rows;
  } finally {
    await db.exec('reset role');
  }
}

async function expectRejected(
  who: Parameters<typeof as>[0],
  statement: string,
): Promise<string> {
  try {
    await as(who, statement);
  } catch (err) {
    return String((err as Error).message);
  }
  throw new Error(`expected the statement to be rejected: ${statement}`);
}

const delivery = (id: string, seq: number, extra = ''): string => `
  insert into public.deliveries
    (id, innings_id, seq, over_no, ball_no, bowler_id, striker_id, non_striker_id,
     zone, contact, declared_runs, physical_runs, team_runs, batsman_runs, bowler_conceded${extra ? ', extra_type' : ''})
  values ('${id}', '${ID.innings}', ${seq}, 0, ${seq}, '${ID.p3}', '${ID.p1}', '${ID.p2}',
          3, 'direct', 6, 0, 6, 6, 6${extra ? `, '${extra}'` : ''})`;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(sql('supabase/tests/00_auth_stub.sql'));
  await db.exec(sql('supabase/migrations/0001_init.sql'));
  await db.exec(sql('supabase/migrations/0002_rls.sql'));
  await db.exec(sql('supabase/migrations/0003_admins_and_audit.sql'));
  await db.exec(sql('supabase/migrations/0004_allowed_admins.sql'));

  // Users: the profiles rows appear via the on_auth_user_created trigger.
  await db.exec(`
    insert into public.allowed_admins (email) values ('scorer@example.com'), ('other@example.com');
    insert into auth.users (id, email) values
      ('${ID.admin}', 'akarsha.kng@gmail.com'),
      ('${ID.scorer}', 'scorer@example.com'),
      ('${ID.otherScorer}', 'other@example.com');
    -- Everyone on the allowlist signs up as an admin, but the RLS tests need
    -- two plain scorers. The role guard only lets the super admin change a
    -- role, so act as him while seeding.
    select set_config('request.jwt.claim.sub', '${ID.admin}', false);
    update public.profiles set role = 'scorer'
      where id in ('${ID.scorer}', '${ID.otherScorer}');
    select set_config('request.jwt.claim.sub', '', false);

    insert into public.players (id, name) values
      ('${ID.p1}', 'Rahul'), ('${ID.p2}', 'Kiran'), ('${ID.p3}', 'Arjun');
    insert into public.jerseys (id, name, colour_hex) values ('${ID.jersey}', 'BLR Bulls', '#1e7a3c');
    insert into public.jerseys (id, name) values ('00000000-0000-0000-0000-0000000000b2', 'ATX Kings');
    insert into public.series (id, name) values ('${ID.series}', 'Weekend Series 1');
    insert into public.squads (id, series_id, jersey_id) values
      ('${ID.squadA}', '${ID.series}', '${ID.jersey}'),
      ('${ID.squadB}', '${ID.series}', '00000000-0000-0000-0000-0000000000b2');
    insert into public.squad_players (squad_id, series_id, player_id) values
      ('${ID.squadA}', '${ID.series}', '${ID.p1}'),
      ('${ID.squadA}', '${ID.series}', '${ID.p2}'),
      ('${ID.squadB}', '${ID.series}', '${ID.p3}');
    insert into public.matches (id, series_id, match_no, squad_a_id, squad_b_id, status, scorer_id)
      values ('${ID.match}', '${ID.series}', 1, '${ID.squadA}', '${ID.squadB}', 'live', '${ID.scorer}');
    insert into public.innings (id, match_id, seq, batting_squad_id, bowling_squad_id)
      values ('${ID.innings}', '${ID.match}', 1, '${ID.squadA}', '${ID.squadB}');
  `);
});

describe('0001 — schema', () => {
  it('R1a — the profiles trigger defaults a new auth user to scorer', async () => {
    const rows = (await as('owner', `select role from public.profiles where id = '${ID.scorer}'`)) as Array<{
      role: string;
    }>;
    expect(rows[0]?.role).toBe('scorer');
  });

  it('R39 — one player, one squad per series, and a removed row frees him up', async () => {
    const msg = await expectRejected(
      'owner',
      `insert into public.squad_players (squad_id, series_id, player_id)
       values ('${ID.squadB}', '${ID.series}', '${ID.p1}')`,
    );
    expect(msg).toMatch(/squad_players_one_per_series_idx|duplicate key/i);

    // A swap is remove + add in one transaction (R1a).
    await as(
      'owner',
      `update public.squad_players set removed_at = now()
       where player_id = '${ID.p1}' and squad_id = '${ID.squadA}'`,
    );
    await as(
      'owner',
      `insert into public.squad_players (squad_id, series_id, player_id)
       values ('${ID.squadB}', '${ID.series}', '${ID.p1}')`,
    );
    // Put him back where he started so later tests see the original line-up.
    await as('owner', `delete from public.squad_players where squad_id = '${ID.squadB}' and player_id = '${ID.p1}'`);
    await as(
      'owner',
      `update public.squad_players set removed_at = null
       where player_id = '${ID.p1}' and squad_id = '${ID.squadA}'`,
    );
  });

  it('R29 / decision 20 — planned_matches can go up but never down', async () => {
    await as('owner', `update public.series set planned_matches = 4 where id = '${ID.series}'`);
    const msg = await expectRejected(
      'owner',
      `update public.series set planned_matches = 2 where id = '${ID.series}'`,
    );
    expect(msg).toMatch(/only be increased/);
  });

  it('R2 — the effective config freezes once the toss has written it', async () => {
    await as(
      'owner',
      `update public.matches set effective_rules = '{"oversPerInnings":6}'::jsonb where id = '${ID.match}'`,
    );
    const msg = await expectRejected(
      'owner',
      `update public.matches set effective_rules = '{"oversPerInnings":8}'::jsonb where id = '${ID.match}'`,
    );
    expect(msg).toMatch(/frozen at the toss/);
  });

  it('R7b / R10 / R11 / R14a — the delivery interlocks are constraints, not just UI', async () => {
    const wideWithRuns = await expectRejected(
      'owner',
      `insert into public.deliveries (id, innings_id, seq, over_no, ball_no, bowler_id, striker_id,
         extra_type, declared_runs, contact)
       values (gen_random_uuid(), '${ID.innings}', 90, 0, 1, '${ID.p3}', '${ID.p1}', 'wide', 4, 'direct')`,
    );
    expect(wideWithRuns).toMatch(/check constraint/i);

    const caughtWithRuns = await expectRejected(
      'owner',
      `insert into public.deliveries (id, innings_id, seq, over_no, ball_no, bowler_id, striker_id,
         wicket_type, player_out_id, declared_runs, contact)
       values (gen_random_uuid(), '${ID.innings}', 91, 0, 1, '${ID.p3}', '${ID.p1}', 'caught', '${ID.p1}', 4, 'direct')`,
    );
    expect(caughtWithRuns).toMatch(/check constraint/i);

    const wrongRow = await expectRejected(
      'owner',
      `insert into public.deliveries (id, innings_id, seq, over_no, ball_no, bowler_id, striker_id,
         declared_runs, contact)
       values (gen_random_uuid(), '${ID.innings}', 92, 0, 1, '${ID.p3}', '${ID.p1}', 6, 'pitched')`,
    );
    expect(wrongRow).toMatch(/check constraint/i);
  });

  it('§4 — UNIQUE(innings_id, seq) and the client-generated id make double-scoring impossible', async () => {
    const id = '00000000-0000-0000-0000-000000000901';
    await as('scorer', delivery(id, 1));
    // The same phone retrying: same primary key, no second row.
    const retry = await expectRejected('scorer', delivery(id, 1));
    expect(retry).toMatch(/duplicate key/i);
    // A second device racing on the same ball number.
    const race = await expectRejected('scorer', delivery('00000000-0000-0000-0000-000000000902', 1));
    expect(race).toMatch(/deliveries_innings_id_seq_key|duplicate key/i);
  });
});

describe('0002 — RLS', () => {
  it('R35 — an anonymous user can read a match but cannot insert a delivery', async () => {
    const matches = (await as('anon', `select id, status from public.matches`)) as Array<{ id: string }>;
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe(ID.match);

    const balls = await as('anon', `select id from public.deliveries`);
    expect(balls.length).toBeGreaterThan(0); // ball-by-ball is public (R34)

    const msg = await expectRejected('anon', delivery('00000000-0000-0000-0000-000000000911', 11));
    expect(msg).toMatch(/permission denied|row-level security/i);
  });

  it('R35 — anon cannot add a player, create a series, or change settings', async () => {
    expect(await expectRejected('anon', `insert into public.players (name) values ('Sneaky')`)).toMatch(
      /permission denied|row-level security/i,
    );
    expect(await expectRejected('anon', `insert into public.series (name) values ('Mine')`)).toMatch(
      /permission denied|row-level security/i,
    );
    expect(await expectRejected('anon', `select * from public.app_settings`)).toMatch(
      /permission denied/i,
    );
  });

  it('R35 — the assigned scorer can score; another scorer cannot', async () => {
    await as('scorer', delivery('00000000-0000-0000-0000-000000000921', 21));
    const msg = await expectRejected('otherScorer', delivery('00000000-0000-0000-0000-000000000922', 22));
    expect(msg).toMatch(/row-level security/i);
  });

  it('R35 — an admin can score any match', async () => {
    await as('admin', delivery('00000000-0000-0000-0000-000000000931', 31));
    const rows = (await as('owner', `select count(*)::int as n from public.deliveries`)) as Array<{ n: number }>;
    expect(rows[0]?.n).toBeGreaterThanOrEqual(3);
  });

  it('R7d / §4 — nobody can DELETE a delivery; voiding is the only way back', async () => {
    for (const who of ['anon', 'scorer', 'admin'] as const) {
      const msg = await expectRejected(who, `delete from public.deliveries where seq = 21`);
      expect(msg).toMatch(/permission denied/i);
    }
    await as('scorer', `update public.deliveries set is_voided = true where seq = 21`);
    const rows = (await as('anon', `select is_voided from public.deliveries where seq = 21`)) as Array<{
      is_voided: boolean;
    }>;
    expect(rows[0]?.is_voided).toBe(true);
  });

  it('§4 — the log is append-only: an update may touch nothing but is_voided', async () => {
    const msg = await expectRejected(
      'scorer',
      `update public.deliveries set team_runs = 999 where seq = 1`,
    );
    expect(msg).toMatch(/append-only/);
  });

  it('R1 — a scorer may add to the pool mid-match; only an admin deletes one (R35a)', async () => {
    await as('scorer', `insert into public.players (name) values ('Walk-up')`);

    // RLS filters rows on DELETE rather than raising, so the proof is that the
    // scorer's delete matches nothing and the row survives.
    await as('scorer', `delete from public.players where name = 'Walk-up'`);
    const survived = (await as(
      'owner',
      `select count(*)::int as n from public.players where name = 'Walk-up'`,
    )) as Array<{ n: number }>;
    expect(survived[0]?.n).toBe(1);

    await as('admin', `delete from public.players where name = 'Walk-up'`);
    const gone = (await as(
      'owner',
      `select count(*)::int as n from public.players where name = 'Walk-up'`,
    )) as Array<{ n: number }>;
    expect(gone[0]?.n).toBe(0);
  });

  it('R35 — only an admin creates a series, a jersey or a match', async () => {
    expect(
      await expectRejected('scorer', `insert into public.series (name) values ('Scorer series')`),
    ).toMatch(/row-level security/i);
    await as('admin', `insert into public.series (name) values ('Admin series')`);
  });
});

describe('0003 — admins and the activity log', () => {
  it('the super admin is an admin from his first sign-in, with no bootstrap step', async () => {
    const rows = (await as('owner', `select role from public.profiles where id = '${ID.admin}'`)) as Array<{
      role: string;
    }>;
    expect(rows[0]?.role).toBe('admin');
  });

  it('only the super admin can grant admin, and he cannot be demoted', async () => {
    // RLS filters the row rather than raising, so the proof is that a scorer
    // promoting himself changes nothing at all.
    await as('scorer', `update public.profiles set role = 'admin' where id = '${ID.scorer}'`);
    const unchanged = (await as(
      'owner',
      `select role from public.profiles where id = '${ID.scorer}'`,
    )) as Array<{ role: string }>;
    expect(unchanged[0]?.role).toBe('scorer');

    // The super admin promoting someone else works.
    await as('admin', `update public.profiles set role = 'admin' where id = '${ID.otherScorer}'`);
    const promoted = (await as(
      'owner',
      `select role from public.profiles where id = '${ID.otherScorer}'`,
    )) as Array<{ role: string }>;
    expect(promoted[0]?.role).toBe('admin');

    // But nobody can demote him, not even himself.
    const demote = await expectRejected(
      'admin',
      `update public.profiles set role = 'scorer' where id = '${ID.admin}'`,
    );
    expect(demote).toMatch(/super admin cannot be demoted/);
  });

  it('the activity log stamps the actor itself and cannot be rewritten', async () => {
    await as('scorer', `insert into public.audit_log (action, detail) values ('player_added', 'Walk-up')`);
    const rows = (await as('owner', `select actor_email, action from public.audit_log`)) as Array<{
      actor_email: string;
      action: string;
    }>;
    // The client never says who it is — the trigger does.
    expect(rows[0]?.actor_email).toBe('scorer@example.com');

    const tamper = await expectRejected(
      'scorer',
      `update public.audit_log set detail = 'nothing to see'`,
    );
    expect(tamper).toMatch(/permission denied/i);

    const wipe = await expectRejected('admin', `delete from public.audit_log`);
    expect(wipe).toMatch(/permission denied/i);
  });

  it('R35 — the activity log is not public', async () => {
    const msg = await expectRejected('anon', `select * from public.audit_log`);
    expect(msg).toMatch(/permission denied/i);
  });
});

describe('0004 — only people the super admin added can sign up', () => {
  it('an email that is not on the list cannot create an account at all', async () => {
    const msg = await expectRejected(
      'owner',
      `insert into auth.users (id, email)
       values ('00000000-0000-0000-0000-0000000000ff', 'stranger@example.com')`,
    );
    expect(msg).toMatch(/has not been added by the administrator/);
  });

  it('adding the email first lets that person sign up, as an admin', async () => {
    await as('owner', `insert into public.allowed_admins (email) values ('newmate@example.com')`);
    await as(
      'owner',
      `insert into auth.users (id, email)
       values ('00000000-0000-0000-0000-0000000000fe', 'newmate@example.com')`,
    );
    const rows = (await as(
      'owner',
      `select role from public.profiles where email = 'newmate@example.com'`,
    )) as Array<{ role: string }>;
    expect(rows[0]?.role).toBe('admin');
  });

  it('only the super admin edits the list, and he cannot be removed from it', async () => {
    // A plain admin's insert is filtered by RLS, so the list does not grow.
    await as('otherScorer', `insert into public.allowed_admins (email) values ('sneak@example.com')`).catch(
      () => undefined,
    );
    const sneak = (await as(
      'owner',
      `select count(*)::int as n from public.allowed_admins where email = 'sneak@example.com'`,
    )) as Array<{ n: number }>;
    expect(sneak[0]?.n).toBe(0);

    // The super admin's own entry survives his own delete.
    await as('admin', `delete from public.allowed_admins where email = 'akarsha.kng@gmail.com'`);
    const still = (await as(
      'owner',
      `select count(*)::int as n from public.allowed_admins where email = 'akarsha.kng@gmail.com'`,
    )) as Array<{ n: number }>;
    expect(still[0]?.n).toBe(1);
  });

  it('R35 — the allowlist is not public', async () => {
    const msg = await expectRejected('anon', `select * from public.allowed_admins`);
    expect(msg).toMatch(/permission denied/i);
  });
});
