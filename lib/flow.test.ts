/**
 * Phase 3 -> Phase 4, end to end, through the same functions the screens call.
 *
 * Admin builds a series and two squads, runs the toss, and the pad scores an
 * innings. Everything is derived by replaying the log, so this test is really
 * asking: do the admin screens hand the engine a state it can score?
 */

import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  addToSquad,
  appendDelivery,
  appendEvent,
  abandonMatch,
  createMatch,
  createSeries,
  deleteMatch,
  deleteSeries,
  renamePlayer,
  renameSeries,
  setSeriesIsTest,
  recordCall,
  recordDecision,
  recordSpin,
  removeFromSquad,
  setLastMan,
  squadMembers,
  startSecondInnings,
  voidLastBall,
  type DB,
} from './store';
import { matchRules, scoreboard } from './innings';
import { toDeliveryRow } from '../src/db/mappers';
import { applyDelivery } from '../src/engine/engine';
import { DEFAULT_RULES } from '../src/engine/rules';
import type { DeliveryInput, RulesConfig } from '../src/engine/types';

const EMPTY_DB: DB = {
  admins: [],
  audit: [],
  players: [],
  jerseys: [
    { id: 'jA', name: 'BLR Bulls', short_name: 'BLR', colour_hex: null, logo_url: null, deleted_at: null, created_at: '' },
    { id: 'jB', name: 'ATX Kings', short_name: 'ATX', colour_hex: null, logo_url: null, deleted_at: null, created_at: '' },
  ],
  series: [],
  squads: [],
  squad_players: [],
  matches: [],
  innings: [],
  deliveries: [],
  match_events: [],
  app_settings: [],
};

/** Everything the admin does before a ball is bowled. */
function setUp(overrides: Partial<RulesConfig> = {}, sizes: [number, number] = [3, 3]) {
  let db: DB = structuredClone(EMPTY_DB);

  const names = ['Rahul', 'Kiran', 'Vinay', 'Suresh', 'Arjun', 'Sameer', 'Vikram', 'Naveen'];
  for (const n of names) db = addPlayer(db, n);
  const pool = db.players;

  const created = createSeries(db, 'Week 7', 3, overrides, 'jA', 'jB');
  db = created.db;
  const [squadA, squadB] = db.squads;
  if (!squadA || !squadB) throw new Error('series must create two squads');

  for (let i = 0; i < sizes[0]; i += 1) db = addToSquad(db, squadA.id, pool[i]!.id);
  for (let i = 0; i < sizes[1]; i += 1) db = addToSquad(db, squadB.id, pool[4 + i]!.id);

  const match = createMatch(db, created.seriesId, overrides, 'Turf 4');
  db = match.db;

  return { db, seriesId: created.seriesId, matchId: match.matchId, squadA, squadB, pool };
}

/** The toss, then the openers — exactly what the two screens write. */
function startInnings(db: DB, matchId: string, rules: RulesConfig): DB {
  const match = db.matches.find((m) => m.id === matchId)!;
  db = recordSpin(db, matchId, match.squad_a_id!, 'heads');
  db = recordCall(db, matchId, 'heads'); // the caller called right: squad A won
  db = recordDecision(db, matchId, 'bat', rules);
  const innings = db.innings.find((i) => i.match_id === matchId)!;
  const batting = squadMembers(db, innings.batting_squad_id);
  const bowling = squadMembers(db, innings.bowling_squad_id);
  return appendEvent(db, matchId, innings.id, 'innings_start', {
    strikerId: batting[0]!.id,
    nonStrikerId: batting[1]!.id,
    bowlerId: bowling[0]!.id,
  });
}

/** Score one ball the way the pad's commit does. */
function score(db: DB, inningsId: string, rules: RulesConfig, partial: Partial<DeliveryInput>): DB {
  const innings = db.innings.find((i) => i.id === inningsId)!;
  const board = scoreboard(db, innings, rules)!;
  const state = board.state;
  const seq = Math.max(0, ...db.deliveries.filter((d) => d.innings_id === inningsId).map((d) => d.seq),
    ...db.match_events.filter((e) => e.innings_id === inningsId).map((e) => e.seq ?? 0)) + 1;
  const input: DeliveryInput = { id: `ball-${seq}`, ...partial };
  const { result } = applyDelivery(state, input, rules);
  const row = toDeliveryRow(input, result, state, { inningsId, seq });
  return appendDelivery(db, { ...row, is_voided: false, created_at: '' });
}

describe('R1 / R39 — building the weekend squads', () => {
  it('R1 — search-add fills two squads from one pool', () => {
    const { db, squadA, squadB } = setUp();
    expect(squadMembers(db, squadA.id)).toHaveLength(3);
    expect(squadMembers(db, squadB.id)).toHaveLength(3);
  });

  it('R39 — adding a player to the other squad swaps him rather than duplicating', () => {
    const { db, squadA, squadB, pool } = setUp();
    const moved = addToSquad(db, squadB.id, pool[0]!.id);
    expect(squadMembers(moved, squadA.id).map((p) => p.id)).not.toContain(pool[0]!.id);
    expect(squadMembers(moved, squadB.id).map((p) => p.id)).toContain(pool[0]!.id);
    // R1a — the old membership row survives, stamped with removed_at.
    expect(moved.squad_players.filter((sp) => sp.player_id === pool[0]!.id)).toHaveLength(2);
  });

  it('R1a — removing a player keeps the row so his stats survive', () => {
    const { db, squadA, pool } = setUp();
    const after = removeFromSquad(db, squadA.id, pool[0]!.id);
    expect(squadMembers(after, squadA.id)).toHaveLength(2);
    expect(after.squad_players.some((sp) => sp.player_id === pool[0]!.id && sp.removed_at !== null)).toBe(true);
  });
});

describe('R3 / R2 — the toss', () => {
  it('R3 — the result is stored on the spin, before any call is made', () => {
    const { db, matchId } = setUp();
    const match = db.matches.find((m) => m.id === matchId)!;
    const spun = recordSpin(db, matchId, match.squad_a_id!, 'tails');
    const stored = spun.matches.find((m) => m.id === matchId)!;
    expect(stored.toss_result).toBe('tails');
    expect(stored.tossed_at).not.toBeNull();
    expect(stored.toss_call).toBeNull(); // the call comes later, mid-spin
    expect(stored.toss_winner_squad_id).toBeNull();
  });

  it('R3 — a wrong call hands the toss to the other side', () => {
    const { db, matchId, squadA, squadB } = setUp();
    let after = recordSpin(db, matchId, squadA.id, 'tails');
    after = recordCall(after, matchId, 'heads'); // called wrong
    expect(after.matches.find((m) => m.id === matchId)!.toss_winner_squad_id).toBe(squadB.id);
  });

  it('R2 — the decision freezes the effective config and opens innings 1', () => {
    const { db, matchId } = setUp({ threeDotOut: true });
    const rules = { ...DEFAULT_RULES, threeDotOut: true };
    const after = startInnings(db, matchId, rules);
    const match = after.matches.find((m) => m.id === matchId)!;
    expect(match.status).toBe('live');
    expect(match.effective_rules).toMatchObject({ threeDotOut: true });
    expect(matchRules(after, match).threeDotOut).toBe(true);
    expect(after.innings.filter((i) => i.match_id === matchId)).toHaveLength(1);
  });
});

describe('R23 / R7d — the pad scores an innings', () => {
  it('R23 — balls scored through the store replay to the right total', () => {
    const rules = { ...DEFAULT_RULES, oversPerInnings: 2 };
    const { db, matchId } = setUp({ oversPerInnings: 2 });
    let after = startInnings(db, matchId, rules);
    const innings = after.innings[0]!;

    after = score(after, innings.id, rules, { declaredRuns: 6, contact: 'direct' });
    after = score(after, innings.id, rules, { extra: 'wide' });
    after = score(after, innings.id, rules, { extra: 'noball' });
    after = score(after, innings.id, rules, { declaredRuns: 4, contact: 'direct' }); // free hit
    after = score(after, innings.id, rules, { physicalRuns: 1 });

    const board = scoreboard(after, innings, rules)!;
    expect(board.error).toBeNull();
    expect(board.state.runs).toBe(6 + 1 + 2 + 4 + 1);
    expect(board.state.legalBalls).toBe(3);
    expect(board.results).toHaveLength(5);
  });

  it('R7d — undo voids the last ball and the score recomputes', () => {
    const rules = { ...DEFAULT_RULES };
    const { db, matchId } = setUp();
    let after = startInnings(db, matchId, rules);
    const innings = after.innings[0]!;
    after = score(after, innings.id, rules, { declaredRuns: 6, contact: 'direct' });
    after = score(after, innings.id, rules, { declaredRuns: 4, contact: 'direct' });
    expect(scoreboard(after, innings, rules)!.state.runs).toBe(10);

    after = voidLastBall(after, innings.id);
    expect(scoreboard(after, innings, rules)!.state.runs).toBe(6);
    expect(after.deliveries).toHaveLength(2); // nothing was deleted
  });

  it('R20b — the engine clears the bowler at the over break and he cannot return', () => {
    const rules = { ...DEFAULT_RULES, ballsPerOver: 2, oversPerInnings: 2 };
    const { db, matchId } = setUp({ ballsPerOver: 2, oversPerInnings: 2 });
    let after = startInnings(db, matchId, rules);
    const innings = after.innings[0]!;
    const firstBowler = scoreboard(after, innings, rules)!.state.currentBowlerId;

    after = score(after, innings.id, rules, {});
    after = score(after, innings.id, rules, {});
    const board = scoreboard(after, innings, rules)!;
    expect(board.state.currentBowlerId).toBeNull();
    expect(board.state.lastOverBowlerId).toBe(firstBowler);
  });

  it('R24 / R25 — a short squad with last man on keeps batting alone', () => {
    const rules = { ...DEFAULT_RULES };
    const { db, matchId, squadA } = setUp({}, [2, 3]);
    let after = setLastMan(db, squadA.id, true);
    after = startInnings(after, matchId, rules);
    const innings = after.innings[0]!;
    const batting = squadMembers(after, innings.batting_squad_id);
    expect(batting).toHaveLength(2);

    after = score(after, innings.id, rules, { wicket: { type: 'bowled' } });
    const board = scoreboard(after, innings, rules)!;
    expect(board.state.lastManActive).toBe(true);
    expect(board.state.status).toBe('in_progress');
    expect(board.state.nonStrikerId).toBeNull();
  });

  it('R28 — the chase is created with the right target and sides swapped', () => {
    const rules = { ...DEFAULT_RULES, oversPerInnings: 1 };
    const { db, matchId } = setUp({ oversPerInnings: 1 });
    let after = startInnings(db, matchId, rules);
    const first = after.innings[0]!;
    for (let i = 0; i < 6; i += 1) {
      after = score(after, first.id, rules, { declaredRuns: 1, contact: 'pitched' });
    }
    const board = scoreboard(after, first, rules)!;
    expect(board.state.status).toBe('complete');
    // R20 — nobody declared an impact over, so the last over is one by
    // default. In a one-over innings that is the whole innings: 6 singles
    // doubled = 12, and R22 keeps the final ball at ×2, never ×4.
    expect(board.state.runs).toBe(12);

    after = startSecondInnings(after, matchId, board.state.runs);
    const second = after.innings.find((i) => i.seq === 2)!;
    expect(second.target).toBe(13);
    expect(second.batting_squad_id).toBe(first.bowling_squad_id);
    expect(after.innings.find((i) => i.seq === 1)!.status).toBe('complete');
  });
});

describe('test series — disposable, and only those', () => {
  it('a test series and every ball in it can be deleted; a real one cannot', () => {
    const rules = { ...DEFAULT_RULES };

    // A real series: delete does nothing at all.
    const real = setUp();
    let db = startInnings(real.db, real.matchId, rules);
    db = score(db, db.innings[0]!.id, rules, { declaredRuns: 6, contact: 'direct' });
    const afterReal = deleteSeries(db, real.seriesId);
    expect(afterReal.series).toHaveLength(1);
    expect(afterReal.deliveries).toHaveLength(1);
    expect(deleteMatch(db, real.matchId).matches).toHaveLength(1);

    // The same series marked as a test: everything goes.
    const asTest: DB = {
      ...db,
      series: db.series.map((s) => ({ ...s, is_test: true })),
    };
    const wiped = deleteSeries(asTest, real.seriesId);
    expect(wiped.series).toHaveLength(0);
    expect(wiped.matches).toHaveLength(0);
    expect(wiped.innings).toHaveLength(0);
    expect(wiped.deliveries).toHaveLength(0);
    expect(wiped.squads).toHaveLength(0);
    // The player pool is untouched — those are real people.
    expect(wiped.players.length).toBeGreaterThan(0);
  });

  it('marking a series as a test is what makes it deletable', () => {
    const rules = { ...DEFAULT_RULES };
    const { db, matchId, seriesId } = setUp();
    let after = startInnings(db, matchId, rules);
    after = score(after, after.innings[0]!.id, rules, { declaredRuns: 4, contact: 'direct' });

    // A live, real match resists deletion.
    expect(deleteMatch(after, matchId).matches).toHaveLength(1);

    // Flag it, and the same call clears it out completely.
    const flagged = setSeriesIsTest(after, seriesId, true);
    const gone = deleteSeries(flagged, seriesId);
    expect(gone.series).toHaveLength(0);
    expect(gone.matches).toHaveLength(0);
    expect(gone.deliveries).toHaveLength(0);
    expect(gone.players.length).toBeGreaterThan(0);
  });

  it('a real match can be abandoned instead, keeping its record', () => {
    const rules = { ...DEFAULT_RULES };
    const { db, matchId } = setUp();
    const after = abandonMatch(startInnings(db, matchId, rules), matchId);
    expect(after.matches[0]?.status).toBe('abandoned');
    expect(after.innings).toHaveLength(1);
  });

  it('renaming keeps the id, so nothing that points at it breaks', () => {
    const { db, seriesId, pool } = setUp();
    const renamed = renameSeries(renamePlayer(db, pool[0]!.id, 'Rahul K'), seriesId, 'Week 8');
    expect(renamed.players.find((p) => p.id === pool[0]!.id)?.name).toBe('Rahul K');
    expect(renamed.series.find((s) => s.id === seriesId)?.name).toBe('Week 8');
    expect(renamed.audit.some((a) => a.action === 'player_renamed')).toBe(true);
  });
});
