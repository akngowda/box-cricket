/**
 * Engine <-> database round trip.
 *
 * Scores an innings with the engine, writes every ball through RLS as the
 * assigned scorer, reads the log back, and replays it. If the schema and the
 * engine ever disagree — a constraint the engine can produce, a column the
 * replay needs — this test is where it surfaces.
 */

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyDelivery, createInnings } from '../engine/engine';
import { resolveConfig } from '../engine/rules';
import { replayInnings } from '../engine/replay';
import type { DeliveryInput, InningsState } from '../engine/types';
import type { DeliveryRow } from './database.types';
import { freezeRules, rulesFromMatch, toDeliveryRow, toStoredDelivery } from './mappers';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sql = (p: string): string => readFileSync(`${root}${p}`, 'utf8');

const SCORER = '00000000-0000-0000-0000-0000000000a2';
const MATCH = '00000000-0000-0000-0000-0000000000e1';
const INNINGS = '00000000-0000-0000-0000-0000000000f1';
const P = {
  b1: '00000000-0000-0000-0000-000000000101',
  b2: '00000000-0000-0000-0000-000000000102',
  b3: '00000000-0000-0000-0000-000000000103',
  o1: '00000000-0000-0000-0000-000000000201',
  o2: '00000000-0000-0000-0000-000000000202',
} as const;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(sql('supabase/tests/00_auth_stub.sql'));
  await db.exec(sql('supabase/migrations/0001_init.sql'));
  await db.exec(sql('supabase/migrations/0002_rls.sql'));
  await db.exec(`
    insert into auth.users (id, email) values ('${SCORER}', 'scorer@example.com');
    insert into public.players (id, name) values
      ('${P.b1}', 'Rahul'), ('${P.b2}', 'Kiran'), ('${P.b3}', 'Vinay'),
      ('${P.o1}', 'Arjun'), ('${P.o2}', 'Sam');
    insert into public.jerseys (id, name) values
      ('00000000-0000-0000-0000-0000000000b1', 'BLR Bulls'),
      ('00000000-0000-0000-0000-0000000000b2', 'ATX Kings');
    insert into public.series (id, name) values ('00000000-0000-0000-0000-0000000000c1', 'Weekend 1');
    insert into public.squads (id, series_id, jersey_id) values
      ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1'),
      ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b2');
    insert into public.matches (id, series_id, match_no, squad_a_id, squad_b_id, status, scorer_id)
      values ('${MATCH}', '00000000-0000-0000-0000-0000000000c1', 1,
              '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2', 'live', '${SCORER}');
    insert into public.innings (id, match_id, seq, batting_squad_id, bowling_squad_id)
      values ('${INNINGS}', '${MATCH}', 1,
              '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2');
  `);
});

async function asScorer(statement: string, params: unknown[] = []): Promise<unknown[]> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [SCORER]);
  await db.exec('set role authenticated');
  try {
    const res = await db.query(statement, params);
    return res.rows;
  } finally {
    await db.exec('reset role');
  }
}

describe('R0 / R2 — the frozen effective config', () => {
  it('R0 — freezeRules merges the cascade; rulesFromMatch reads it back', () => {
    const frozen = freezeRules({ threeDotOut: true }, { maxOversPerBowler: 3 }, { oversPerInnings: 8 });
    expect(frozen.threeDotOut).toBe(true);
    expect(frozen.maxOversPerBowler).toBe(3);
    expect(frozen.oversPerInnings).toBe(8);
    expect(rulesFromMatch(frozen as never)).toEqual(frozen);
  });

  it('R2 — before the toss there is nothing frozen', () => {
    expect(rulesFromMatch(null)).toBeNull();
  });
});

describe('§1 — the log round trips through Postgres and replays to the same score', () => {
  it('R23 / R7d — engine → rows → RLS insert → replay gives an identical scoreboard', async () => {
    const rules = resolveConfig({}, {}, { threeDotOut: true, threeBodyOut: true });
    const init = {
      battingOrder: [P.b1, P.b2, P.b3],
      bowlingSquad: [P.o1, P.o2],
      strikerId: P.b1,
      nonStrikerId: P.b2,
      bowlerId: P.o1,
    };

    // A mixed over, all faced by b1 (nothing here changes strike): a six, a
    // wide, a no-ball, the free hit driven for four, then a body hit and two
    // dots — the body hit is 0 off the bat so it counts as the first dot
    // (R17), making the last ball an automatic Dot Out (R16c).
    const script: Array<Partial<DeliveryInput>> = [
      { declaredRuns: 6, contact: 'direct' },
      { extra: 'wide' },
      { extra: 'noball' },
      { declaredRuns: 4, contact: 'direct' },
      { isBodyHit: true },
      {},
      {},
    ];

    let state: InningsState = createInnings(init);
    const rows: DeliveryRow[] = [];

    for (const [i, partial] of script.entries()) {
      const before = state;
      // At the over break the engine clears the bowler (R20b), so the scorer
      // picks the next one. Every row carries bowler_id, which is what makes
      // the log replayable on its own.
      const bowlerId =
        before.currentBowlerId ?? (before.lastOverBowlerId === P.o1 ? P.o2 : P.o1);
      const input: DeliveryInput = { id: uuid(i), bowlerId, ...partial };
      const { state: next, result } = applyDelivery(before, input, rules);
      state = next;

      const row = toDeliveryRow(input, result, before, { inningsId: INNINGS, seq: i + 1, createdBy: SCORER });
      const cols = Object.keys(row);
      const values = Object.values(row);
      await asScorer(
        `insert into public.deliveries (${cols.join(', ')})
         values (${values.map((_, n) => `$${n + 1}`).join(', ')})`,
        values,
      );
      rows.push(row as DeliveryRow);
    }

    // The engine's own view of the innings.
    expect(state.runs).toBe(6 + 1 + 2 + 4);
    expect(state.legalBalls).toBe(5);
    expect(state.wickets).toBe(1);
    expect(state.fallOfWickets[0]?.type).toBe('dotout');

    // Everything the engine produced was accepted by the constraints.
    const stored = (await asScorer(
      `select * from public.deliveries where innings_id = '${INNINGS}' order by seq`,
    )) as DeliveryRow[];
    expect(stored).toHaveLength(script.length);
    expect(stored.map((r) => r.team_runs)).toEqual(rows.map((r) => r.team_runs));

    // And replaying the stored log lands on exactly the same state (§1).
    const replayed = replayInnings(stored.map(toStoredDelivery), rules, init);
    expect(replayed.state.runs).toBe(state.runs);
    expect(replayed.state.wickets).toBe(state.wickets);
    expect(replayed.state.legalBalls).toBe(state.legalBalls);
    expect(replayed.state.batsmen[P.b1]?.runs).toBe(state.batsmen[P.b1]?.runs);
    expect(replayed.state.batsmen[P.b1]?.outType).toBe('dotout');
    expect(replayed.state).toEqual(state);

    // R7d — void the last ball in the database and the replay drops it.
    await asScorer(`update public.deliveries set is_voided = true where seq = ${script.length}`);
    const afterUndo = (await asScorer(
      `select * from public.deliveries where innings_id = '${INNINGS}' order by seq`,
    )) as DeliveryRow[];
    const undone = replayInnings(afterUndo.map(toStoredDelivery), rules, init);
    expect(undone.state.wickets).toBe(0);
    expect(undone.state.batsmen[P.b1]?.isOut).toBe(false);
    expect(undone.state.legalBalls).toBe(state.legalBalls - 1);
  });
});

function uuid(i: number): string {
  return `00000000-0000-0000-0000-0000000${String(i + 10).padStart(5, '0')}`;
}
