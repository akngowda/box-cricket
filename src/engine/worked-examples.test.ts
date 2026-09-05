/**
 * Part N — every worked example in one table, expected vs actual.
 *
 * `npm test` prints this. It is the verification artifact for Phase 1: if a
 * rule change breaks an example, the row shows it before any UI exists.
 */

import { describe, expect, it } from 'vitest';
import { applyDelivery, applyEvent, createInnings, eligibleBowlers } from './engine';
import { DEFAULT_RULES, resolveConfig, totalLegalBalls } from './rules';
import type { DeliveryInput, InningsState, RulesConfig } from './types';

const BAT = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'];
const BOWL = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'];

let n = 0;
const id = (): string => `wx${(n += 1)}`;

function start(over: Partial<Parameters<typeof createInnings>[0]> = {}): InningsState {
  return createInnings({
    battingOrder: BAT,
    bowlingSquad: BOWL,
    strikerId: 'b1',
    nonStrikerId: 'b2',
    bowlerId: 'o1',
    ...over,
  });
}

/** Bowl one ball; returns the runs it produced. */
function one(
  s: InningsState,
  input: Partial<DeliveryInput>,
  r: RulesConfig = DEFAULT_RULES,
): { state: InningsState; runs: number; note: string } {
  const out = applyDelivery(s, { id: id(), ...input }, r);
  return {
    state: out.state,
    runs: out.result.teamRuns,
    note: out.result.wicket ? `OUT ${out.result.wicket.type}` : out.result.strikeChanged ? 'strike changes' : '',
  };
}

/** Bowl filler dots, picking a fresh bowler at each over break (R20b). */
function fill(s: InningsState, count: number, r: RulesConfig): InningsState {
  let state = s;
  for (let i = 0; i < count; i += 1) {
    if (state.currentBowlerId === null) {
      const next = eligibleBowlers(state, r)[0] as string;
      state = applyEvent(state, { type: 'bowler_selected', bowlerId: next }, r);
    }
    state = applyDelivery(state, { id: id() }, r).state;
  }
  return state;
}

interface Row {
  example: string;
  rules: string;
  what: string;
  expected: number;
  run: () => { runs: number; note: string };
}

const impactOver = (s: InningsState, r: RulesConfig = DEFAULT_RULES): InningsState =>
  applyEvent(s, { type: 'impact_over_declared', overNo: 0 }, r);

const ROWS: Row[] = [
  {
    example: 'N1',
    rules: 'R5 R9',
    what: 'declared 6, physical 0',
    expected: 6,
    run: () => one(start(), { declaredRuns: 6, contact: 'direct' }),
  },
  {
    example: 'N2',
    rules: 'R8 R9',
    what: 'declared 6 + 1 run',
    expected: 7,
    run: () => one(start(), { declaredRuns: 6, contact: 'direct', physicalRuns: 1 }),
  },
  {
    example: 'N3',
    rules: 'R5 R7',
    what: 'nothing tapped, physical 1',
    expected: 1,
    run: () => one(start(), { physicalRuns: 1 }),
  },
  {
    example: 'N4',
    rules: 'R9',
    what: 'declared 4 + 2 runs (even)',
    expected: 6,
    run: () => one(start(), { declaredRuns: 4, contact: 'direct', physicalRuns: 2 }),
  },
  {
    example: 'N5',
    rules: 'R20 R9',
    what: 'impact over, 6 + 1',
    expected: 14,
    run: () => one(impactOver(start()), { declaredRuns: 6, contact: 'direct', physicalRuns: 1 }),
  },
  {
    example: 'N6',
    rules: 'R11 R13',
    what: 'impact over, no-ball, declared 2, extras not doubled',
    expected: 6,
    run: () => one(impactOver(start()), { extra: 'noball', declaredRuns: 2, contact: 'pitched' }),
  },
  {
    example: 'N7',
    rules: 'R13',
    what: 'same, double-extras ON',
    expected: 8,
    run: () => {
      const r = resolveConfig({}, {}, { doubleExtrasOnImpact: true });
      return one(impactOver(start(), r), { extra: 'noball', declaredRuns: 2, contact: 'pitched' }, r);
    },
  },
  {
    example: 'N8',
    rules: 'R21',
    what: 'impact ball, declared 4 + 1',
    expected: 10,
    run: () => {
      const r = DEFAULT_RULES;
      const s = fill(start(), totalLegalBalls(r) - 1, r);
      return one(s, { declaredRuns: 4, contact: 'direct', physicalRuns: 1 }, r);
    },
  },
  {
    example: 'N9',
    rules: 'R22',
    what: 'impact ball inside the impact over, declared 6',
    expected: 12,
    run: () => {
      const r = DEFAULT_RULES;
      let s = fill(start(), 30, r);
      s = applyEvent(s, { type: 'impact_over_declared', overNo: 5 }, r);
      s = applyEvent(s, { type: 'bowler_selected', bowlerId: eligibleBowlers(s, r)[0] as string }, r);
      s = fill(s, 5, r);
      return one(s, { declaredRuns: 6, contact: 'direct' }, r);
    },
  },
  {
    example: 'N10',
    rules: 'R16 R16c R18',
    what: 'third straight dot',
    expected: 0,
    run: () => {
      const r = resolveConfig({}, {}, { threeDotOut: true });
      const s = fill(start(), 2, r);
      return one(s, {}, r);
    },
  },
  {
    example: 'N11',
    rules: 'R10 R16',
    what: 'wide during a 2-dot streak',
    expected: 1,
    run: () => {
      const r = resolveConfig({}, {}, { threeDotOut: true });
      const s = fill(start(), 2, r);
      const out = one(s, { extra: 'wide' }, r);
      return { runs: out.runs, note: `streak stays ${out.state.batsmen.b1?.dotStreak}` };
    },
  },
  {
    example: 'N11a',
    rules: 'R16a R16b',
    what: 'Carry: non-striker run out on the deciding ball',
    expected: 1,
    run: () => {
      const r = resolveConfig({}, {}, { threeDotOut: true, dotCarryMode: 'carry' });
      const s = fill(start(), 2, r);
      const out = one(
        s,
        {
          physicalRuns: 1,
          wicket: { type: 'runout', playerOutId: 'b2', newBatsmanId: 'b3', newBatsmanOnStrike: false },
        },
        r,
      );
      return { runs: out.runs, note: `next dot dismisses: ${out.state.batsmen.b1?.nextDotDismisses}` };
    },
  },
  {
    example: 'N11b',
    rules: 'R16b',
    what: 'Reset: same ball, streak wiped',
    expected: 1,
    run: () => {
      const r = resolveConfig({}, {}, { threeDotOut: true, dotCarryMode: 'reset' });
      const s = fill(start(), 2, r);
      const out = one(
        s,
        {
          physicalRuns: 1,
          wicket: { type: 'runout', playerOutId: 'b2', newBatsmanId: 'b3', newBatsmanOnStrike: false },
        },
        r,
      );
      return { runs: out.runs, note: `streak ${out.state.batsmen.b1?.dotStreak}` };
    },
  },
  {
    example: 'N11c',
    rules: 'R16b',
    what: 'Sudden death: same ball',
    expected: 1,
    run: () => {
      const r = resolveConfig({}, {}, { threeDotOut: true, dotCarryMode: 'sudden_death' });
      const s = fill(start(), 2, r);
      const out = one(
        s,
        {
          physicalRuns: 1,
          wicket: { type: 'runout', playerOutId: 'b2', newBatsmanId: 'b3', newBatsmanOnStrike: false },
        },
        r,
      );
      return { runs: out.runs, note: `sudden death: ${out.state.batsmen.b1?.suddenDeath}` };
    },
  },
  {
    example: 'N11d',
    rules: 'R19',
    what: 'top-net hit, ends up in zone 2 direct',
    expected: 4,
    run: () => one(start(), { declaredRuns: 4, contact: 'direct', isRoofHit: true }),
  },
  {
    example: 'N11e',
    rules: 'R16',
    what: 'missed no-ball on 2 dots',
    expected: 2,
    run: () => {
      const r = resolveConfig({}, {}, { threeDotOut: true });
      const s = fill(start(), 2, r);
      const out = one(s, { extra: 'noball' }, r);
      return { runs: out.runs, note: `streak stays ${out.state.batsmen.b1?.dotStreak}` };
    },
  },
  {
    example: 'N12',
    rules: 'R17 R16',
    what: 'third body hit, body before dot',
    expected: 0,
    run: () => {
      const r = resolveConfig({}, {}, { threeDotOut: true, threeBodyOut: true });
      let s = one(start(), { isBodyHit: true }, r).state;
      s = one(s, { declaredRuns: 4, contact: 'direct' }, r).state;
      s = one(s, { isBodyHit: true }, r).state;
      return one(s, { isBodyHit: true }, r);
    },
  },
  {
    example: 'N13',
    rules: 'R25',
    what: 'last man, physical 1 on the last ball of the over',
    expected: 1,
    run: () => {
      const r = DEFAULT_RULES;
      let s = start({ battingOrder: ['b1', 'b2'], lastManEnabled: true });
      s = one(s, { wicket: { type: 'bowled' } }, r).state;
      s = fill(s, 4, r);
      const out = one(s, { physicalRuns: 1 }, r);
      return { runs: out.runs, note: `strike stays with ${out.state.strikerId}` };
    },
  },
  {
    example: 'N14',
    rules: 'R12',
    what: 'free hit, declared 4 (bowled would not be out)',
    expected: 4,
    run: () => {
      const r = DEFAULT_RULES;
      const s = one(start(), { extra: 'noball' }, r).state;
      return one(s, { declaredRuns: 4, contact: 'direct' }, r);
    },
  },
  {
    example: 'N15',
    rules: 'R26a',
    what: 'run out, new batsman does NOT take strike',
    expected: 1,
    run: () => {
      const out = one(start(), {
        physicalRuns: 1,
        wicket: {
          type: 'runout',
          playerOutId: 'b1',
          fielderId: 'o4',
          newBatsmanId: 'b3',
          newBatsmanOnStrike: false,
        },
      });
      return { runs: out.runs, note: `on strike: ${out.state.strikerId}` };
    },
  },
];

describe('Part N — worked examples, expected vs actual', () => {
  const table: Array<Record<string, string | number>> = [];

  for (const row of ROWS) {
    it(`${row.example} (${row.rules}) — ${row.what} → ${row.expected}`, () => {
      const { runs, note } = row.run();
      table.push({
        '#': row.example,
        rules: row.rules,
        ball: row.what,
        expected: row.expected,
        actual: runs,
        ok: runs === row.expected ? 'PASS' : 'FAIL',
        note,
      });
      expect(runs).toBe(row.expected);
    });
  }

  it('prints the table', () => {
    expect(table).toHaveLength(ROWS.length);
    // eslint-disable-next-line no-console
    console.table(table);
  });
});
