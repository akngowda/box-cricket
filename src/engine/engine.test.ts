/**
 * Engine tests. Every test name carries the rule IDs it covers, so coverage is
 * readable at a glance (03-BUILD-PROMPT, setup message).
 */

import { describe, expect, it } from 'vitest';
import {
  applyDelivery,
  applyEvent,
  ballsInCurrentOver,
  ballsUntilEligible,
  createInnings,
  currentOver,
  bowlerCapFor,
  eligibleBowlers,
  impactOverIsDefault,
  impactOverOf,
  overAnnouncement,
  zoneFor,
} from './engine';
import { DEFAULT_RULES, resolveConfig, totalLegalBalls } from './rules';
import { replayInnings, voidLastDelivery } from './replay';
import type {
  DeliveryInput,
  DeliveryResult,
  InningsState,
  RulesConfig,
  StoredDelivery,
} from './types';

// --- harness ---------------------------------------------------------------

const BAT = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'];
const BOWL = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8'];

function rules(over: Partial<RulesConfig> = {}): RulesConfig {
  return resolveConfig({}, {}, over);
}

function innings(over: Partial<Parameters<typeof createInnings>[0]> = {}): InningsState {
  return createInnings({
    battingOrder: BAT,
    bowlingSquad: BOWL,
    strikerId: 'b1',
    nonStrikerId: 'b2',
    bowlerId: 'o1',
    ...over,
  });
}

let ballId = 0;
function ball(input: Partial<DeliveryInput> = {}): DeliveryInput {
  ballId += 1;
  return { id: `d${ballId}`, ...input };
}

/** Bowl one ball and return both halves. */
function bowl(
  state: InningsState,
  input: Partial<DeliveryInput> = {},
  r: RulesConfig = DEFAULT_RULES,
): { state: InningsState; result: DeliveryResult } {
  return applyDelivery(state, ball(input), r);
}

/** Bowl a sequence, picking a legal new bowler at each over break (R20b). */
function bowlMany(
  start: InningsState,
  inputs: Array<Partial<DeliveryInput>>,
  r: RulesConfig = DEFAULT_RULES,
): { state: InningsState; results: DeliveryResult[] } {
  let state = start;
  const results: DeliveryResult[] = [];
  for (const input of inputs) {
    if (state.currentBowlerId === null && state.status === 'in_progress') {
      const next = eligibleBowlers(state, r)[0];
      if (next) state = applyEvent(state, { type: 'bowler_selected', bowlerId: next }, r);
    }
    const out = applyDelivery(state, ball(input), r);
    state = out.state;
    results.push(out.result);
  }
  return { state, results };
}

const SIX: Partial<DeliveryInput> = { declaredRuns: 6, contact: 'direct' };
const FOUR: Partial<DeliveryInput> = { declaredRuns: 4, contact: 'direct' };
const DOT: Partial<DeliveryInput> = {};

// --- R0 / R2: settings ------------------------------------------------------

describe('R0 / R2 — settings cascade and the effective config', () => {
  it('R2 — defaults match the effective-config table', () => {
    expect(DEFAULT_RULES.oversPerInnings).toBe(6);
    expect(DEFAULT_RULES.ballsPerOver).toBe(6);
    expect(DEFAULT_RULES.maxOversPerBowler).toBe(2);
    expect(DEFAULT_RULES.noBallRuns).toBe(2);
    expect(DEFAULT_RULES.wideRuns).toBe(1);
    expect(DEFAULT_RULES.doubleExtrasOnImpact).toBe(false);
    expect(DEFAULT_RULES.threeDotOut).toBe(false);
    expect(DEFAULT_RULES.threeBodyOut).toBe(false);
    expect(DEFAULT_RULES.dotCarryMode).toBe('carry');
  });

  it('R0 — general <- series <- match, key by key', () => {
    const cfg = resolveConfig(
      { oversPerInnings: 8, threeDotOut: true },
      { maxOversPerBowler: 3 },
      { oversPerInnings: 5 },
    );
    expect(cfg.oversPerInnings).toBe(5); // match wins
    expect(cfg.maxOversPerBowler).toBe(3); // series wins
    expect(cfg.threeDotOut).toBe(true); // general survives
    expect(cfg.wideRuns).toBe(1); // default survives
  });
});

// --- R4 / R5: zones and the two declared rows -------------------------------

describe('R4 / R5 — zones, pitched vs direct', () => {
  it('R5 — pitched row 1/2/3 maps to zones 1/2/3', () => {
    expect(zoneFor(1, 'pitched')).toBe(1);
    expect(zoneFor(2, 'pitched')).toBe(2);
    expect(zoneFor(3, 'pitched')).toBe(3);
  });

  it('R5 — direct row 2/4/6 maps to zones 1/2/3', () => {
    expect(zoneFor(2, 'direct')).toBe(1);
    expect(zoneFor(4, 'direct')).toBe(2);
    expect(zoneFor(6, 'direct')).toBe(3);
  });

  it('R5 — a value that is not on the tapped row is rejected', () => {
    expect(() => zoneFor(6, 'pitched')).toThrow(/R5/);
    expect(() => zoneFor(1, 'direct')).toThrow(/R5/);
  });

  it('R5 / R8 — contact is stored for stats and does not change the arithmetic', () => {
    const a = bowl(innings(), { declaredRuns: 2, contact: 'pitched' });
    const b = bowl(innings(), { declaredRuns: 2, contact: 'direct' });
    expect(a.result.teamRuns).toBe(2);
    expect(b.result.teamRuns).toBe(2);
    expect(a.result.zone).toBe(2);
    expect(b.result.zone).toBe(1);
    expect(a.state.batsmen.b1?.contactCounts).toEqual({ pitched: 1, direct: 0 });
    expect(b.state.batsmen.b1?.contactCounts).toEqual({ pitched: 0, direct: 1 });
  });
});

// --- Part N worked examples -------------------------------------------------

describe('Part N — the worked examples', () => {
  it('N1 (R5/R9) — simple six: declared 6, physical 0 → 6, no strike change', () => {
    const { state, result } = bowl(innings(), SIX);
    expect(result.teamRuns).toBe(6);
    expect(result.strikeChanged).toBe(false);
    expect(state.strikerId).toBe('b1');
  });

  it('N2 (R8/R9) — six and a run → 7, strike changes', () => {
    const { state, result } = bowl(innings(), { ...SIX, physicalRuns: 1 });
    expect(result.teamRuns).toBe(7);
    expect(result.strikeChanged).toBe(true);
    expect(state.strikerId).toBe('b2');
  });

  it('N3 (R5/R7) — nothing tapped, physical 1 only → 1, strike changes', () => {
    const { result } = bowl(innings(), { physicalRuns: 1 });
    expect(result.batRuns).toBe(1);
    expect(result.teamRuns).toBe(1);
    expect(result.strikeChanged).toBe(true);
  });

  it('N4 (R9) — even physical: 4 + 2 → 6, no strike change', () => {
    const { result } = bowl(innings(), { ...FOUR, physicalRuns: 2 });
    expect(result.teamRuns).toBe(6);
    expect(result.strikeChanged).toBe(false);
  });

  it('N5 (R20/R9) — impact over: (6+1)×2 = 14, strike changes on raw physical 1', () => {
    let s = innings();
    s = applyEvent(s, { type: 'impact_over_declared', overNo: 0 }, DEFAULT_RULES);
    const { result } = bowl(s, { ...SIX, physicalRuns: 1 });
    expect(result.multiplier).toBe(2);
    expect(result.teamRuns).toBe(14);
    expect(result.strikeChanged).toBe(true);
  });

  it('N6 (R11/R13) — impact over + no-ball, extras NOT doubled: bat 4 + extras 2 = 6', () => {
    let s = innings();
    s = applyEvent(s, { type: 'impact_over_declared', overNo: 0 }, DEFAULT_RULES);
    const { state, result } = bowl(s, {
      extra: 'noball',
      declaredRuns: 2,
      contact: 'pitched',
    });
    expect(result.batsmanRuns).toBe(4);
    expect(result.extras).toBe(2);
    expect(result.teamRuns).toBe(6);
    expect(state.isFreeHit).toBe(true); // R12
  });

  it('N7 (R13) — same ball with double-extras ON: bat 4 + extras 4 = 8', () => {
    const r = rules({ doubleExtrasOnImpact: true });
    let s = innings();
    s = applyEvent(s, { type: 'impact_over_declared', overNo: 0 }, r);
    const { result } = bowl(s, { extra: 'noball', declaredRuns: 2, contact: 'pitched' }, r);
    expect(result.batsmanRuns).toBe(4);
    expect(result.extras).toBe(4);
    expect(result.teamRuns).toBe(8);
  });

  it('N8 (R21) — impact ball: declared 4 + physical 1 → 10', () => {
    const r = DEFAULT_RULES;
    // 35 legal balls already bowled → the 36th is the impact ball.
    const filler = Array.from({ length: 35 }, () => DOT);
    const { state } = bowlMany(innings(), filler, r);
    expect(state.legalBalls).toBe(totalLegalBalls(r) - 1);
    const { result } = bowl(
      state.currentBowlerId
        ? state
        : applyEvent(state, { type: 'bowler_selected', bowlerId: eligibleBowlers(state, r)[0] as string }, r),
      { ...FOUR, physicalRuns: 1 },
      r,
    );
    expect(result.isImpactBall).toBe(true);
    expect(result.teamRuns).toBe(10);
  });

  it('N9 (R22) — impact ball inside the impact over: 6 → 12, never 24', () => {
    const r = DEFAULT_RULES;
    let s = bowlMany(innings(), Array.from({ length: 30 }, () => DOT), r).state;
    s = applyEvent(s, { type: 'impact_over_declared', overNo: 5 }, r);
    const next = eligibleBowlers(s, r)[0] as string;
    s = applyEvent(s, { type: 'bowler_selected', bowlerId: next }, r);
    s = bowlMany(s, Array.from({ length: 5 }, () => DOT), r).state;
    const { result } = bowl(s, SIX, r);
    expect(result.isImpactOver).toBe(true);
    expect(result.isImpactBall).toBe(true);
    expect(result.multiplier).toBe(2);
    expect(result.teamRuns).toBe(12);
  });

  it('N10 (R16/R16c/R18) — third straight dot is an automatic Dot Out, bowler credited', () => {
    const r = rules({ threeDotOut: true });
    const s = bowlMany(innings(), [DOT, DOT], r).state;
    expect(s.batsmen.b1?.dotStreak).toBe(2);
    const { state, result } = bowl(s, DOT, r);
    expect(result.wicket).toEqual({
      type: 'dotout',
      playerOutId: 'b1',
      automatic: true,
      bowlerCredited: true,
      fielderId: null,
    });
    expect(state.wickets).toBe(1);
    expect(state.bowlers.o1?.wickets).toBe(1);
    expect(state.strikerId).toBe('b3');
  });

  it('N11 (R10/R16) — a wide during a streak leaves the counter untouched', () => {
    const r = rules({ threeDotOut: true });
    let s = bowlMany(innings(), [DOT, DOT], r).state;
    const out = bowl(s, { extra: 'wide' }, r);
    s = out.state;
    expect(out.result.wicket).toBeNull();
    expect(out.result.isLegalBall).toBe(false);
    expect(s.batsmen.b1?.dotStreak).toBe(2);
    expect(s.legalBalls).toBe(2);
  });

  it('N11a (R16a/R16b) — Carry: non-striker run out on the deciding ball, streak stays at 2', () => {
    const r = rules({ threeDotOut: true, dotCarryMode: 'carry' });
    let s = bowlMany(innings(), [DOT, DOT], r).state;
    const out = bowl(
      s,
      {
        physicalRuns: 1,
        wicket: { type: 'runout', playerOutId: 'b2', newBatsmanId: 'b3', newBatsmanOnStrike: false },
      },
      r,
    );
    s = out.state;
    expect(out.result.wicket?.type).toBe('runout');
    expect(s.batsmen.b1?.isOut).toBe(false);
    expect(s.batsmen.b1?.dotStreak).toBe(2);
    expect(s.batsmen.b1?.nextDotDismisses).toBe(true);

    // The next dot he faces ends him.
    if (s.strikerId !== 'b1') s = applyEvent(s, { type: 'strike_switched_manually' }, r);
    const next = bowl(s, DOT, r);
    expect(next.result.wicket?.type).toBe('dotout');
    expect(next.result.wicket?.automatic).toBe(true);
  });

  it('N11b (R16b) — Reset: the run-out ball wipes the streak to 0', () => {
    const r = rules({ threeDotOut: true, dotCarryMode: 'reset' });
    const s = bowlMany(innings(), [DOT, DOT], r).state;
    const out = bowl(
      s,
      {
        physicalRuns: 1,
        wicket: { type: 'runout', playerOutId: 'b2', newBatsmanId: 'b3', newBatsmanOnStrike: false },
      },
      r,
    );
    expect(out.state.batsmen.b1?.dotStreak).toBe(0);
    expect(out.state.batsmen.b1?.nextDotDismisses).toBe(false);
  });

  it('N11c (R16b) — Sudden death: any dot from here dismisses him, even after scoring', () => {
    const r = rules({ threeDotOut: true, dotCarryMode: 'sudden_death' });
    let s = bowlMany(innings(), [DOT, DOT], r).state;
    s = bowl(
      s,
      {
        physicalRuns: 1,
        wicket: { type: 'runout', playerOutId: 'b2', newBatsmanId: 'b3', newBatsmanOnStrike: false },
      },
      r,
    ).state;
    expect(s.batsmen.b1?.suddenDeath).toBe(true);

    if (s.strikerId !== 'b1') s = applyEvent(s, { type: 'strike_switched_manually' }, r);
    s = bowl(s, FOUR, r).state; // scoring resets the counter but not sudden death
    expect(s.batsmen.b1?.dotStreak).toBe(0);
    expect(s.batsmen.b1?.suddenDeath).toBe(true);
    const out = bowl(s, DOT, r);
    expect(out.result.wicket?.type).toBe('dotout');
  });

  it('N11d (R19) — a top-net hit stays live and is scored by where it ends up', () => {
    const r = rules({ threeDotOut: true });
    const { state, result } = bowl(innings(), { ...FOUR, isRoofHit: true }, r);
    expect(result.teamRuns).toBe(4);
    expect(result.isLegalBall).toBe(true);
    expect(state.batsmen.b1?.dotStreak).toBe(0);
  });

  it('N11e (R16) — a missed no-ball on 2 dots neither increments nor resets', () => {
    const r = rules({ threeDotOut: true });
    let s = bowlMany(innings(), [DOT, DOT], r).state;
    s = bowl(s, { extra: 'noball' }, r).state;
    expect(s.batsmen.b1?.dotStreak).toBe(2);
    expect(s.legalBalls).toBe(2);
    // The re-bowled legal delivery is the one that counts. It is a free hit, so
    // the counter still does not move (R12).
    const freeHit = bowl(s, DOT, r);
    expect(freeHit.result.wasFreeHit).toBe(true);
    expect(freeHit.state.batsmen.b1?.dotStreak).toBe(2);
    expect(freeHit.result.wicket).toBeNull();
  });

  it('N12 (R17/R16) — body before dot: on 1 dot and 2 body hits, a body hit is Body Out', () => {
    const r = rules({ threeDotOut: true, threeBodyOut: true });
    let s = innings();
    s = bowl(s, { isBodyHit: true }, r).state; // body 1, dot 1
    s = bowl(s, FOUR, r).state; // dot streak back to 0
    s = bowl(s, { isBodyHit: true }, r).state; // body 2, dot 1
    expect(s.batsmen.b1?.bodyHits).toBe(2);
    expect(s.batsmen.b1?.dotStreak).toBe(1);
    const out = bowl(s, { isBodyHit: true }, r);
    expect(out.result.wicket?.type).toBe('bodyout');
    expect(out.result.wicket?.automatic).toBe(true);
    expect(out.result.wicket?.bowlerCredited).toBe(true);
  });

  it('N13 (R25) — last man: a physical run on the last ball of the over does not rotate him', () => {
    const r = DEFAULT_RULES;
    let s = createInnings({
      battingOrder: ['b1', 'b2'],
      bowlingSquad: BOWL,
      strikerId: 'b1',
      nonStrikerId: 'b2',
      bowlerId: 'o1',
      lastManEnabled: true,
    });
    s = bowl(s, { wicket: { type: 'bowled' }, physicalRuns: 0 }, r).state;
    expect(s.lastManActive).toBe(true);
    expect(s.strikerId).toBe('b2');
    expect(s.nonStrikerId).toBeNull();

    const { state, results } = bowlMany(s, [DOT, DOT, DOT, DOT, { physicalRuns: 1 }], r);
    expect(results[4]?.overCompleted).toBe(true);
    expect(results[4]?.strikeChanged).toBe(false);
    expect(state.strikerId).toBe('b2');
    expect(state.runs).toBe(1);
  });

  it('N14 (R12) — bowled on a free hit is not out, and the runs count', () => {
    const r = DEFAULT_RULES;
    let s = bowl(innings(), { extra: 'noball' }, r).state;
    expect(s.isFreeHit).toBe(true);
    expect(() => applyDelivery(s, ball({ wicket: { type: 'bowled' } }), r)).toThrow(/R12/);
    const out = bowl(s, FOUR, r);
    expect(out.result.teamRuns).toBe(4);
    expect(out.state.isFreeHit).toBe(false);
  });

  it('N15 (R26a) — after a run out the scorer decides who is on strike; never assumed', () => {
    const r = DEFAULT_RULES;
    // They cross once, the striker is run out at the far end, and the scorer
    // confirms the non-striker keeps strike.
    const { state } = bowl(
      innings(),
      {
        physicalRuns: 1,
        wicket: {
          type: 'runout',
          playerOutId: 'b1',
          fielderId: 'o4',
          newBatsmanId: 'b3',
          newBatsmanOnStrike: false,
        },
      },
      r,
    );
    expect(state.strikerId).toBe('b2');
    expect(state.nonStrikerId).toBe('b3');
    expect(state.batsmen.b1?.isOut).toBe(true);
    expect(state.bowlers.o1?.wickets).toBe(0); // R18 — no credit for a run out
  });
});

// --- R7 / R7b: input model and interlocks -----------------------------------

describe('R7 / R7b — pad inputs and interlocks', () => {
  it('R7 — physical runs default to 0 and cap at a single digit', () => {
    expect(bowl(innings(), SIX).result.batRuns).toBe(6);
    expect(() => applyDelivery(innings(), ball({ physicalRuns: 10 }), DEFAULT_RULES)).toThrow(/R7/);
  });

  it('R10 — a wide carries no runs off the bat and only allows a stumping', () => {
    expect(() =>
      applyDelivery(innings(), ball({ extra: 'wide', physicalRuns: 1 }), DEFAULT_RULES),
    ).toThrow(/R10/);
    expect(() =>
      applyDelivery(
        innings(),
        ball({ extra: 'wide', wicket: { type: 'caught' } }),
        DEFAULT_RULES,
      ),
    ).toThrow(/R10/);
    const out = bowl(innings(), {
      extra: 'wide',
      wicket: { type: 'stumped', newBatsmanId: 'b3' },
    });
    expect(out.result.teamRuns).toBe(1);
    expect(out.result.isLegalBall).toBe(false);
    expect(out.state.bowlers.o1?.wickets).toBe(1);
  });

  it('R11 / R14a — a run out is the only dismissal on a no-ball, and it carries runs', () => {
    expect(() =>
      applyDelivery(innings(), ball({ extra: 'noball', wicket: { type: 'bowled' } }), DEFAULT_RULES),
    ).toThrow(/R11/);
    const out = bowl(innings(), {
      extra: 'noball',
      declaredRuns: 2,
      contact: 'direct',
      physicalRuns: 1,
      wicket: { type: 'runout', playerOutId: 'b2', newBatsmanId: 'b3', newBatsmanOnStrike: false },
    });
    expect(out.result.teamRuns).toBe(5); // 2 no-ball + 2 declared + 1 physical
    expect(out.result.isLegalBall).toBe(false);
    expect(out.state.isFreeHit).toBe(true);
  });

  it('R14a — every dismissal but a run out scores 0 off the bat', () => {
    for (const type of ['bowled', 'caught', 'stumped'] as const) {
      expect(() =>
        applyDelivery(innings(), ball({ declaredRuns: 4, contact: 'direct', wicket: { type } }), DEFAULT_RULES),
      ).toThrow(/R14a/);
    }
  });

  it('R16c — dot out and body out cannot be entered by hand', () => {
    expect(() =>
      applyDelivery(innings(), ball({ wicket: { type: 'dotout' } }), DEFAULT_RULES),
    ).toThrow(/R16c/);
  });

  it('R17a — the body marker is rejected when the body rule is off', () => {
    expect(() => applyDelivery(innings(), ball({ isBodyHit: true }), DEFAULT_RULES)).toThrow(/R17a/);
  });

  it('R17 / R7b — a body hit is 0 off the bat and never on a no-ball', () => {
    const r = rules({ threeBodyOut: true });
    expect(() =>
      applyDelivery(innings(), ball({ isBodyHit: true, declaredRuns: 4, contact: 'direct' }), r),
    ).toThrow(/R7b/);
    expect(() =>
      applyDelivery(innings(), ball({ isBodyHit: true, extra: 'noball' }), r),
    ).toThrow(/R17/);
  });
});

// --- R9: strike -------------------------------------------------------------

describe('R9 — strike change', () => {
  it('R9 — declared runs never change strike, however large', () => {
    expect(bowl(innings(), SIX).result.strikeChanged).toBe(false);
    expect(bowl(innings(), { declaredRuns: 3, contact: 'pitched' }).result.strikeChanged).toBe(false);
  });

  it('R9 — odd physical XOR end of over', () => {
    const r = DEFAULT_RULES;
    const { state, results } = bowlMany(innings(), [DOT, DOT, DOT, DOT, DOT, { physicalRuns: 1 }], r);
    // Last ball of the over with an odd physical run: both fire, so no swap.
    expect(results[5]?.overCompleted).toBe(true);
    expect(results[5]?.strikeChanged).toBe(false);
    expect(state.strikerId).toBe('b1');
  });

  it('R9 — end of over alone swaps strike', () => {
    const { state, results } = bowlMany(innings(), [DOT, DOT, DOT, DOT, DOT, DOT]);
    expect(results[5]?.strikeChanged).toBe(true);
    expect(state.strikerId).toBe('b2');
  });

  it('R9 — the doubled total never affects strike; the raw physical count does', () => {
    let s = innings();
    s = applyEvent(s, { type: 'impact_over_declared', overNo: 0 }, DEFAULT_RULES);
    const { result } = bowl(s, { ...FOUR, physicalRuns: 1 });
    expect(result.batsmanRuns).toBe(10);
    expect(result.strikeChanged).toBe(true);
  });

  it('R26 — the scorer can override the automatic result on the ball', () => {
    const { result, state } = bowl(innings(), { ...SIX, manualStrikeSwitch: true });
    expect(result.strikeChanged).toBe(true);
    expect(state.strikerId).toBe('b2');
  });
});

// --- R20 / R21 / R22: multipliers ------------------------------------------

describe('R20 / R20e / R21 / R22 — impact over and impact ball', () => {
  it('R20 — the declaration is once per innings and locks once the over starts', () => {
    const r = DEFAULT_RULES;
    let s = applyEvent(innings(), { type: 'impact_over_declared', overNo: 0 }, r);
    expect(() => applyEvent(s, { type: 'impact_over_declared', overNo: 2 }, r)).toThrow(/R20/);
    s = bowl(s, DOT, r).state;
    expect(() => applyEvent(s, { type: 'impact_over_undone' }, r)).toThrow(/R20e/);
  });

  it('R20 — with nothing declared, the last over is the impact over by default', () => {
    const r = DEFAULT_RULES;
    expect(impactOverOf(innings(), r)).toBe(r.oversPerInnings - 1);
    expect(impactOverIsDefault(innings(), r)).toBe(true);

    // Five quiet overs, then every ball of the last one doubles.
    let s = bowlMany(innings(), Array.from({ length: 30 }, () => DOT), r).state;
    s = applyEvent(s, { type: 'bowler_selected', bowlerId: eligibleBowlers(s, r)[0] as string }, r);
    const first = bowl(s, SIX, r);
    expect(first.result.isImpactOver).toBe(true);
    expect(first.result.teamRuns).toBe(12);
  });

  it('R20 — a declared impact over means the last over is NOT one', () => {
    const r = DEFAULT_RULES;
    let s = applyEvent(innings(), { type: 'impact_over_declared', overNo: 0 }, r);
    expect(impactOverIsDefault(s, r)).toBe(false);
    expect(impactOverOf(s, r)).toBe(0);
    expect(bowl(s, SIX, r).result.teamRuns).toBe(12); // over 0 doubles

    // Bowl on until one legal ball remains in the innings.
    s = bowlMany(s, Array.from({ length: 35 }, () => DOT), r).state;
    s = applyEvent(s, { type: 'bowler_selected', bowlerId: eligibleBowlers(s, r)[0] as string }, r);
    const last = bowl(s, SIX, r);
    expect(last.result.isImpactOver).toBe(false);
    // Still 12, but only because it is the impact ball — never 24 (R22).
    expect(last.result.isImpactBall).toBe(true);
    expect(last.result.teamRuns).toBe(12);
  });

  it('R20 — with impact overs switched off, nothing falls back', () => {
    const r = rules({ impactOverAllowed: false, impactBallAllowed: false });
    expect(impactOverOf(innings(), r)).toBeNull();
    let s = bowlMany(innings(), Array.from({ length: 30 }, () => DOT), r).state;
    s = applyEvent(s, { type: 'bowler_selected', bowlerId: eligibleBowlers(s, r)[0] as string }, r);
    expect(bowl(s, SIX, r).result.teamRuns).toBe(6);
  });

  it('R20e — undoing a declaration hands the impact over back to the last over', () => {
    const r = DEFAULT_RULES;
    let s = applyEvent(innings(), { type: 'impact_over_declared', overNo: 2 }, r);
    expect(impactOverOf(s, r)).toBe(2);
    s = applyEvent(s, { type: 'impact_over_undone' }, r);
    expect(impactOverOf(s, r)).toBe(r.oversPerInnings - 1);
  });

  it('R20e — undo before the over starts, then re-declare it later', () => {
    const r = DEFAULT_RULES;
    let s = applyEvent(innings(), { type: 'impact_over_declared', overNo: 3 }, r);
    s = applyEvent(s, { type: 'impact_over_undone' }, r);
    expect(s.impactOverNumber).toBeNull();
    s = applyEvent(s, { type: 'impact_over_declared', overNo: 4 }, r);
    expect(s.impactOverNumber).toBe(4);
  });

  it('R21 — a wide on the last ball pushes the impact ball to the next legal one', () => {
    const r = DEFAULT_RULES;
    const s = bowlMany(innings(), Array.from({ length: 35 }, () => DOT), r).state;
    const wide = bowl(s, { extra: 'wide' }, r);
    expect(wide.result.isImpactBall).toBe(false); // not legal, so never the impact ball
    const last = bowl(wide.state, SIX, r);
    expect(last.result.isImpactBall).toBe(true);
    expect(last.result.teamRuns).toBe(12);
  });

  it('R22 — the multiplier is capped at 2', () => {
    const r = DEFAULT_RULES;
    let s = bowlMany(innings(), Array.from({ length: 30 }, () => DOT), r).state;
    s = applyEvent(s, { type: 'impact_over_declared', overNo: 5 }, r);
    s = applyEvent(s, { type: 'bowler_selected', bowlerId: eligibleBowlers(s, r)[0] as string }, r);
    const { results } = bowlMany(s, Array.from({ length: 6 }, () => SIX), r);
    expect(results.every((x) => x.multiplier === 2)).toBe(true);
    expect(results[5]?.teamRuns).toBe(12);
  });
});

// --- R20a / R20b / R20c / R20d: bowlers ------------------------------------

describe('R20a–R20d — bowler rotation', () => {
  it('R20b — a bowler must rest a full over of legal balls before bowling again', () => {
    const r = DEFAULT_RULES;
    let s = bowlMany(innings(), Array.from({ length: 6 }, () => DOT), r).state;
    expect(s.currentBowlerId).toBeNull();
    expect(ballsUntilEligible(s, 'o1', r)).toBe(6);
    expect(eligibleBowlers(s, r)).not.toContain('o1');
    expect(() => applyEvent(s, { type: 'bowler_selected', bowlerId: 'o1' }, r)).toThrow(/R20b/);

    // One over later he has served his rest and is available again.
    s = bowlMany(s, Array.from({ length: 6 }, () => DOT), r).state;
    expect(ballsUntilEligible(s, 'o1', r)).toBe(0);
    expect(eligibleBowlers(s, r)).toContain('o1');
  });

  it('R20b / R20c — the rest is counted in balls, so a mid-over stint still counts', () => {
    const r = DEFAULT_RULES;
    // o2 comes on after three balls, so his rest clock starts mid-over.
    let s = bowlMany(innings(), [DOT, DOT, DOT], r).state;
    s = applyEvent(s, { type: 'bowler_replaced_midover', bowlerId: 'o2' }, r);
    s = bowlMany(s, [DOT, DOT, DOT], r).state; // o2 finishes the over
    expect(ballsUntilEligible(s, 'o2', r)).toBe(6);
    // o1 stopped three balls earlier, so he is three balls closer to eligible.
    expect(ballsUntilEligible(s, 'o1', r)).toBe(3);
  });

  it('R20a — the per-bowler cap comes from the effective config', () => {
    const r = rules({ maxOversPerBowler: 1 });
    let s = bowlMany(innings(), Array.from({ length: 6 }, () => DOT), r).state;
    expect(eligibleBowlers(s, r)).not.toContain('o1');
    s = applyEvent(s, { type: 'bowler_selected', bowlerId: 'o2' }, r);
    s = bowlMany(s, Array.from({ length: 6 }, () => DOT), r).state;
    expect(() => applyEvent(s, { type: 'bowler_selected', bowlerId: 'o1' }, r)).toThrow(/R20a/);
  });

  it('R20c — a mid-over replacement finishes the over; balls already bowled stay with the original', () => {
    const r = DEFAULT_RULES;
    let s = bowlMany(innings(), [DOT, DOT, DOT], r).state;
    s = applyEvent(s, { type: 'bowler_replaced_midover', bowlerId: 'o2' }, r);
    s = bowlMany(s, [{ ...FOUR }, DOT, DOT], r).state;
    expect(s.bowlers.o1?.legalBalls).toBe(3);
    expect(s.bowlers.o2?.legalBalls).toBe(3);
    expect(s.bowlers.o2?.runsConceded).toBe(4);
    expect(s.bowlers.o2?.oversCompleted).toBe(1);
    expect(s.bowlers.o1?.oversCompleted).toBe(0);
  });

  it('R20d — the bowler can be swapped freely before the first ball of the over', () => {
    const r = DEFAULT_RULES;
    const s = applyEvent(innings(), { type: 'bowler_selected', bowlerId: 'o3' }, r);
    expect(s.currentBowlerId).toBe('o3');
  });
});

// --- R24 / R25: last man ----------------------------------------------------

describe('R24 / R25 / R25a — last man', () => {
  it('R25a — the deadrunner stands at the non-striker end and can be run out', () => {
    const r = DEFAULT_RULES;
    let s = createInnings({
      battingOrder: ['b1', 'b2'],
      bowlingSquad: BOWL,
      strikerId: 'b1',
      nonStrikerId: 'b2',
      bowlerId: 'o1',
      lastManEnabled: true,
      deadrunnerId: 'b1',
    });
    s = bowl(s, { wicket: { type: 'bowled', playerOutId: 'b1' } }, r).state;
    expect(s.lastManActive).toBe(true);
    expect(s.strikerId).toBe('b2');
    // He does not run for the last man — he occupies the other end.
    expect(s.nonStrikerId).toBe('b1');

    // The last man still faces every ball: no rotation on an odd run.
    const ran = bowl(s, { physicalRuns: 1 }, r);
    expect(ran.result.strikeChanged).toBe(false);
    expect(ran.state.strikerId).toBe('b2');
    expect(ran.state.runs).toBe(1);

    // Running out the deadrunner ends the innings — nobody is left to stand.
    const out = bowl(ran.state, {
      physicalRuns: 1,
      wicket: { type: 'runout', playerOutId: 'b1', fielderId: 'o4' },
    }, r);
    expect(out.state.status).toBe('complete');
    expect(out.state.endReason).toBe('all_out');
    expect(out.state.nonStrikerId).toBeNull();
    expect(out.state.bowlers.o1?.wickets).toBe(1); // only the bowled, not the run out
  });

  it('R25a — naming the deadrunner later puts him straight at the other end', () => {
    const r = DEFAULT_RULES;
    let s = createInnings({
      battingOrder: ['b1', 'b2'],
      bowlingSquad: BOWL,
      strikerId: 'b1',
      nonStrikerId: 'b2',
      bowlerId: 'o1',
      lastManEnabled: true,
    });
    s = bowl(s, { wicket: { type: 'bowled', playerOutId: 'b1' } }, r).state;
    expect(s.nonStrikerId).toBeNull();
    s = applyEvent(s, { type: 'deadrunner_set', playerId: 'b1' }, r);
    expect(s.nonStrikerId).toBe('b1');
  });

  it('R25 — a last-man innings: he faces every ball and ends it when he is out', () => {
    const r = DEFAULT_RULES;
    let s = createInnings({
      battingOrder: ['b1', 'b2', 'b3'],
      bowlingSquad: BOWL,
      strikerId: 'b1',
      nonStrikerId: 'b2',
      bowlerId: 'o1',
      lastManEnabled: true,
      deadrunnerId: 'b1',
    });
    s = bowl(s, { wicket: { type: 'bowled', newBatsmanId: 'b3' } }, r).state;
    expect(s.lastManActive).toBe(false);
    s = bowl(s, { wicket: { type: 'bowled' } }, r).state;
    expect(s.lastManActive).toBe(true);
    expect(s.wickets).toBe(2);
    expect(s.status).toBe('in_progress');
    expect(s.deadrunnerId).toBe('b1'); // R25a

    const out = bowl(s, { wicket: { type: 'caught', fielderId: 'o5' } }, r);
    expect(out.state.status).toBe('complete');
    expect(out.state.endReason).toBe('all_out');
  });

  it('R24 / R28 — without last man the innings ends at squad size minus one', () => {
    const r = DEFAULT_RULES;
    let s = createInnings({
      battingOrder: ['b1', 'b2', 'b3'],
      bowlingSquad: BOWL,
      strikerId: 'b1',
      nonStrikerId: 'b2',
      bowlerId: 'o1',
    });
    s = bowl(s, { wicket: { type: 'bowled', newBatsmanId: 'b3' } }, r).state;
    s = bowl(s, { wicket: { type: 'bowled' } }, r).state;
    expect(s.wickets).toBe(2);
    expect(s.status).toBe('complete');
    expect(s.endReason).toBe('all_out');
  });
});

// --- R27: retirement --------------------------------------------------------

describe('R27 — retirement', () => {
  it('R27 — retired out is a wicket with no bowler credit; he never bats again', () => {
    const { state } = bowl(innings(), {
      wicket: { type: 'retired_out', playerOutId: 'b1', newBatsmanId: 'b3' },
    });
    expect(state.wickets).toBe(1);
    expect(state.bowlers.o1?.wickets).toBe(0);
    expect(state.batsmen.b1?.isOut).toBe(true);
  });

  it('R27 — retired hurt is not a wicket, and he can resume from where he left off', () => {
    const r = DEFAULT_RULES;
    // Only three in the squad, so once b3 is out there is nobody left to come
    // in and the end stays empty for the returning batsman.
    let s = bowl(innings({ battingOrder: ['b1', 'b2', 'b3'] }), { ...FOUR }, r).state;
    s = bowl(s, { wicket: { type: 'retired_hurt', playerOutId: 'b1', newBatsmanId: 'b3' } }, r).state;
    expect(s.wickets).toBe(0);
    expect(s.batsmen.b1?.isRetiredHurt).toBe(true);
    expect(s.batsmen.b1?.runs).toBe(4);

    s = bowl(s, { wicket: { type: 'bowled', playerOutId: 'b3' } }, r).state;
    expect(s.strikerId).toBeNull();
    s = applyEvent(s, { type: 'retired_hurt_returned', playerId: 'b1', onStrike: true }, r);
    expect(s.strikerId).toBe('b1');
    expect(s.batsmen.b1?.runs).toBe(4);
  });
});

// --- R1a: roster changes ----------------------------------------------------

describe('R1a — roster changes at any time', () => {
  it('R1a — a player added mid-innings joins the bottom of the order', () => {
    const r = DEFAULT_RULES;
    let s = createInnings({
      battingOrder: ['b1', 'b2', 'b3'],
      bowlingSquad: BOWL,
      strikerId: 'b1',
      nonStrikerId: 'b2',
      bowlerId: 'o1',
    });
    s = applyEvent(s, { type: 'squad_player_added', playerId: 'b9' }, r);
    expect(s.battingOrder.at(-1)).toBe('b9');
    s = bowl(s, { wicket: { type: 'bowled' } }, r).state;
    s = bowl(s, { wicket: { type: 'bowled' } }, r).state;
    expect(s.strikerId).toBe('b9');
    expect(s.status).toBe('in_progress');
  });

  it('R1a — a removed player keeps the stats he already made', () => {
    const r = DEFAULT_RULES;
    let s = bowl(innings(), { ...SIX }, r).state;
    s = applyEvent(s, { type: 'squad_player_removed', playerId: 'b1' }, r);
    expect(s.batsmen.b1?.runs).toBe(6);
  });
});

// --- R28 / R23: whole-innings arithmetic -----------------------------------

describe('R23 / R28 — a full innings', () => {
  it('R23 / R28 — six overs of mixed extras: the ball count comes out exactly right', () => {
    // Multipliers off — this one is about counting balls, not doubling runs.
    const r = rules({ impactOverAllowed: false, impactBallAllowed: false });
    const script: Array<Partial<DeliveryInput>> = [];
    for (let over = 0; over < 6; over += 1) {
      script.push({ extra: 'wide' }); // does not count
      script.push({ ...SIX });
      script.push({ extra: 'noball' }); // does not count
      script.push({ ...FOUR }); // free hit
      script.push({ physicalRuns: 1 });
      script.push({ declaredRuns: 2, contact: 'pitched' });
      script.push(DOT);
      script.push({ declaredRuns: 3, contact: 'pitched' });
    }
    const { state } = bowlMany(innings(), script, r);

    expect(state.legalBalls).toBe(36);
    expect(state.status).toBe('complete');
    expect(state.endReason).toBe('overs_complete');
    // Per over: 1 wide + 2 no-ball extras = 3; bat 6+4+1+2+0+3 = 16.
    expect(state.runs).toBe(6 * (3 + 16));
    expect(state.extras.total).toBe(18);
    expect(state.extras.wides).toBe(6);
    expect(state.extras.noBalls).toBe(12);
  });

  it('R28 — the chase ends the moment the target is passed', () => {
    const r = DEFAULT_RULES;
    const s = innings({ target: 10 });
    const { state } = bowlMany(s, [SIX, FOUR], r);
    expect(state.runs).toBe(10);
    expect(state.status).toBe('complete');
    expect(state.endReason).toBe('target_reached');
    expect(state.legalBalls).toBe(2);
  });

  it('R12 — a free hit that is itself a no-ball carries the free hit over', () => {
    const r = DEFAULT_RULES;
    let s = bowl(innings(), { extra: 'noball' }, r).state;
    expect(s.isFreeHit).toBe(true);
    const second = bowl(s, { extra: 'noball' }, r);
    expect(second.result.wasFreeHit).toBe(true);
    s = second.state;
    expect(s.isFreeHit).toBe(true);
    const third = bowl(s, { extra: 'wide' }, r);
    expect(third.result.wasFreeHit).toBe(true);
    expect(third.state.isFreeHit).toBe(true); // a wide carries it too
    const legal = bowl(third.state, FOUR, r);
    expect(legal.result.wasFreeHit).toBe(true);
    expect(legal.state.isFreeHit).toBe(false);
    expect(s.legalBalls).toBe(0);
  });
});

// --- R7d: undo and replay ---------------------------------------------------

describe('R7d — undo voids the last ball and the innings replays', () => {
  it('R7d — the voided ball stops contributing but the row survives', () => {
    const r = DEFAULT_RULES;
    const log: StoredDelivery[] = [
      { id: 'a', seq: 1, declaredRuns: 6, contact: 'direct' },
      { id: 'b', seq: 2, declaredRuns: 4, contact: 'direct' },
      { id: 'c', seq: 3, physicalRuns: 1 },
    ];
    const init = {
      battingOrder: BAT,
      bowlingSquad: BOWL,
      strikerId: 'b1',
      nonStrikerId: 'b2',
      bowlerId: 'o1',
    };
    const before = replayInnings(log, r, init);
    expect(before.state.runs).toBe(11);
    expect(before.results).toHaveLength(3);

    const undone = voidLastDelivery(log);
    const after = replayInnings(undone, r, init);
    expect(after.state.runs).toBe(10);
    expect(after.state.strikerId).toBe('b1');
    expect(undone).toHaveLength(3);
    expect(undone[2]?.isVoided).toBe(true);
  });

  it('R7d — replay is deterministic: the same log gives the same state', () => {
    const r = rules({ threeDotOut: true });
    const log: StoredDelivery[] = [
      { id: 'a', seq: 1 },
      { id: 'b', seq: 2 },
      { id: 'c', seq: 3 },
    ];
    const init = {
      battingOrder: BAT,
      bowlingSquad: BOWL,
      strikerId: 'b1',
      nonStrikerId: 'b2',
      bowlerId: 'o1',
    };
    const a = replayInnings(log, r, init);
    const b = replayInnings(log, r, init);
    expect(a.state).toEqual(b.state);
    expect(a.state.wickets).toBe(1);
    expect(a.results[2]?.wicket?.type).toBe('dotout');
  });
});

// --- R16 pips, R30 audio, derived reads ------------------------------------

describe('R16 / R30 — ball history and audio', () => {
  it('R16 — the pip row shows green scored, red dot, blue body, one per legal ball', () => {
    const r = rules({ threeBodyOut: true });
    let s = innings();
    s = bowl(s, FOUR, r).state;
    s = bowl(s, DOT, r).state;
    s = bowl(s, { isBodyHit: true }, r).state;
    s = bowl(s, { extra: 'wide' }, r).state; // no pip — not a legal ball
    expect(s.batsmen.b1?.ballHistory).toEqual(['scored', 'dot', 'body']);
  });

  it('R30 — runs are spoken with their unit, never as a bare number', () => {
    expect(bowl(innings(), { ...SIX, physicalRuns: 1 }).result.announcement).toBe('seven runs');
    expect(bowl(innings(), { declaredRuns: 1, contact: 'pitched' }).result.announcement).toBe('one run');
    expect(bowl(innings(), DOT).result.announcement).toBe('dot ball');
    expect(bowl(innings(), { ...FOUR, physicalRuns: 2 }).result.announcement).toBe('six runs');
  });

  it('R30 — a wide, a no ball and a body hit are named', () => {
    const r = rules({ threeBodyOut: true });
    expect(bowl(innings(), { extra: 'wide' }).result.announcement).toBe('wide ball, one run');
    expect(bowl(innings(), { extra: 'noball', declaredRuns: 1, contact: 'pitched' }).result.announcement).toBe(
      'no ball, three runs',
    );
    expect(bowl(innings(), { isBodyHit: true }, r).result.announcement).toBe('body hit');
  });

  it('R30 — an impact ball says "doubled" and reads the doubled total', () => {
    const r = DEFAULT_RULES;
    const s = applyEvent(innings(), { type: 'impact_over_declared', overNo: 0 }, r);
    expect(bowl(s, { ...SIX, physicalRuns: 1 }, r).result.announcement).toBe('doubled, fourteen runs');
    expect(bowl(s, DOT, r).result.announcement).toBe('dot ball');
  });

  it('R30 — a dismissal is called by its manner, with no runs read out', () => {
    const r = rules({ threeDotOut: true, threeBodyOut: true });
    const streak = bowlMany(innings(), [DOT, DOT], r).state;
    expect(bowl(streak, DOT, r).result.announcement).toBe('three consecutive dots, batsman out');

    expect(
      bowl(innings(), { wicket: { type: 'bowled', newBatsmanId: 'b3' } }).result.announcement,
    ).toBe('batsman bowled out');
    expect(
      bowl(innings(), { wicket: { type: 'caught', fielderId: 'o3', newBatsmanId: 'b3' } }).result
        .announcement,
    ).toBe('batsman caught out');
    expect(
      bowl(innings(), { extra: 'wide', wicket: { type: 'stumped', newBatsmanId: 'b3' } }).result
        .announcement,
    ).toBe('wide ball, batsman stumped out');

    // Three body hits, announced as such.
    let b = bowl(innings(), { isBodyHit: true }, r).state;
    b = bowl(b, { isBodyHit: true }, r).state;
    expect(bowl(b, { isBodyHit: true }, r).result.announcement).toBe(
      'three body hits in the innings, batsman out',
    );
  });

  it('R30 — a run out carries the runs and names which end went', () => {
    const striker = bowl(innings(), {
      physicalRuns: 2,
      wicket: { type: 'runout', playerOutId: 'b1', newBatsmanId: 'b3', newBatsmanOnStrike: false },
    });
    expect(striker.result.announcement).toBe('two runs, batsman run out');

    const nonStriker = bowl(innings(), {
      declaredRuns: 1,
      contact: 'pitched',
      wicket: { type: 'runout', playerOutId: 'b2', newBatsmanId: 'b3', newBatsmanOnStrike: false },
    });
    expect(nonStriker.result.announcement).toBe('one run, non striker run out');

    // On a no ball too: the extra is named, the runs still count.
    const offNoBall = bowl(innings(), {
      extra: 'noball',
      physicalRuns: 1,
      wicket: { type: 'runout', playerOutId: 'b2', newBatsmanId: 'b3', newBatsmanOnStrike: false },
    });
    expect(offNoBall.result.announcement).toBe('no ball, three runs, non striker run out');
  });

  it('R34 — the written commentary keeps the detail the audio drops', () => {
    const { result } = bowl(innings(), { ...SIX, physicalRuns: 1 });
    expect(result.commentary).toBe('zone 3 direct, six, one ran, seven');
    expect(bowl(innings(), { extra: 'wide' }).result.commentary).toBe('wide, one, one');
  });

  it('R30 — the over announcement carries the team score', () => {
    const { state } = bowlMany(innings(), [SIX, DOT, DOT, DOT, DOT, DOT]);
    expect(overAnnouncement(state, 0)).toBe('End of over 1, 6 for 0');
    expect(overAnnouncement(state, 0, DEFAULT_RULES, { name: 'Rahul', runs: 6 })).toBe(
      'End of over 1, 6 for 0, Rahul 6',
    );
  });

  it('R23 — over and ball numbers are derived from the legal ball count', () => {
    const r = DEFAULT_RULES;
    const s = bowlMany(innings(), [DOT, DOT, { extra: 'wide' }, DOT], r).state;
    expect(currentOver(s, r)).toBe(0);
    expect(ballsInCurrentOver(s, r)).toBe(3);
  });
});

describe('R30 — audio at the end of an over and the end of a match', () => {
  it('a chase is told what it still needs, in runs and balls', () => {
    const r = rules({ oversPerInnings: 2 });
    const chase = innings({ target: 30 });
    const { state } = bowlMany(chase, Array.from({ length: 6 }, () => ({ declaredRuns: 1, contact: 'pitched' as const })), r);
    expect(overAnnouncement(state, 0, r)).toBe('End of over 1, 6 for 0, needs 24 runs from 6 balls');
  });

  it('a first innings is just the score — there is nothing to chase yet', () => {
    const r = rules({ oversPerInnings: 2 });
    const { state } = bowlMany(innings(), Array.from({ length: 6 }, () => DOT), r);
    expect(overAnnouncement(state, 0, r)).toBe('End of over 1, 0 for 0');
  });

  it('a wide in an impact over is not called "doubled" — only bat runs double', () => {
    const r = DEFAULT_RULES;
    const s = applyEvent(innings(), { type: 'impact_over_declared', overNo: 0 }, r);
    expect(bowl(s, { extra: 'wide' }, r).result.announcement).toBe('wide ball, one run');
    // The bat still doubles on the same over.
    expect(bowl(s, SIX, r).result.announcement).toBe('doubled, twelve runs');
  });
});

describe('R26 — correcting a mis-tapped batsman', () => {
  it('the man taken off can come in again later if he never faced a ball', () => {
    const r = DEFAULT_RULES;
    // b3 walks in by mistake; b4 should have.
    let s = bowl(innings(), { wicket: { type: 'bowled', newBatsmanId: 'b3' } }, r).state;
    expect(s.strikerId).toBe('b3');

    s = applyEvent(s, { type: 'batsman_corrected', outgoingId: 'b3', incomingId: 'b4' }, r);
    expect(s.strikerId).toBe('b4');
    // b3 never faced a ball, so he is still to bat.
    expect(s.batsmen.b3?.hasBatted).toBe(false);

    // And he is genuinely available at the next wicket.
    const next = bowl(s, { wicket: { type: 'bowled', newBatsmanId: 'b3' } }, r);
    expect(next.state.strikerId).toBe('b3');
  });

  it('a man who has faced a ball keeps his innings when swapped off', () => {
    const r = DEFAULT_RULES;
    let s = bowl(innings(), { declaredRuns: 4, contact: 'direct' }, r).state;
    s = applyEvent(s, { type: 'batsman_corrected', outgoingId: 'b1', incomingId: 'b3' }, r);
    expect(s.batsmen.b1?.hasBatted).toBe(true);
    expect(s.batsmen.b1?.runs).toBe(4);
  });
});

describe('R28 — a side is only all out when nobody is left', () => {
  it('picking a batsman from lower down the order does not strand the men above him', () => {
    const r = DEFAULT_RULES;
    const nine = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9'];
    let s = createInnings({
      battingOrder: nine,
      bowlingSquad: BOWL,
      strikerId: 'b1',
      nonStrikerId: 'b2',
      bowlerId: 'o1',
    });

    // The scorer sends in the last man in the order first.
    s = bowl(s, { wicket: { type: 'bowled', playerOutId: 'b1', newBatsmanId: 'b9' } }, r).state;
    expect(s.strikerId).toBe('b9');
    expect(s.status).toBe('in_progress');

    // Everyone in between must still be available.
    for (const next of ['b3', 'b4', 'b5', 'b6', 'b7']) {
      s = bowlMany(s, [{ wicket: { type: 'bowled', newBatsmanId: next } }], r).state;
      expect(s.status).toBe('in_progress');
    }

    // Seven down, two at the crease: still batting.
    expect(s.wickets).toBe(6);
    s = bowlMany(s, [{ wicket: { type: 'bowled', newBatsmanId: 'b8' } }], r).state;
    expect(s.wickets).toBe(7);
    expect(s.status).toBe('in_progress');

    // The eighth wicket is the last: nine players, eight out, nobody to come.
    s = bowlMany(s, [{ wicket: { type: 'bowled' } }], r).state;
    expect(s.wickets).toBe(8);
    expect(s.status).toBe('complete');
    expect(s.endReason).toBe('all_out');
  });

  it('with nobody named, the next man in the order walks in', () => {
    const r = DEFAULT_RULES;
    const s = bowl(innings(), { wicket: { type: 'bowled' } }, r).state;
    expect(s.strikerId).toBe('b3');
  });
});

describe('R24 / R28 — how many wickets a side of nine has', () => {
  const nine = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9'];

  const allOutAfter = (lastManEnabled: boolean): number => {
    const r = DEFAULT_RULES;
    let s = createInnings({
      battingOrder: nine,
      bowlingSquad: BOWL,
      strikerId: 'b1',
      nonStrikerId: 'b2',
      bowlerId: 'o1',
      lastManEnabled,
    });
    let balls = 0;
    while (s.status === 'in_progress' && balls < 60) {
      s = bowlMany(s, [{ wicket: { type: 'bowled' } }], r).state;
      balls += 1;
    }
    return s.wickets;
  };

  it('nine batsmen and no last man: eight wickets', () => {
    expect(allOutAfter(false)).toBe(8);
  });

  it('nine batsmen with last man on: nine wickets', () => {
    expect(allOutAfter(true)).toBe(9);
  });
});

describe('R20 — undoing balls gives the bowler his over back', () => {
  it('a bowler part-way through an over is still the bowler after an undo', () => {
    const r = DEFAULT_RULES;
    const init = {
      battingOrder: BAT,
      bowlingSquad: BOWL,
      strikerId: 'b1',
      nonStrikerId: 'b2',
      bowlerId: 'o1',
    };
    // o1 bowls a full over.
    const log: StoredDelivery[] = Array.from({ length: 6 }, (_, i) => ({
      id: `x${i}`,
      seq: i + 1,
      bowlerId: 'o1',
    }));

    const done = replayInnings(log, r, init).state;
    expect(done.bowlers.o1?.oversCompleted).toBe(1);
    // Having just bowled, he must rest before the next over.
    expect(ballsUntilEligible(done, 'o1', r)).toBe(r.ballsPerOver);

    // Undo the last ball: the over is no longer complete, and it is still his.
    const undone = replayInnings(voidLastDelivery(log), r, init).state;
    expect(undone.legalBalls).toBe(5);
    expect(undone.bowlers.o1?.oversCompleted).toBe(0);
    expect(undone.currentBowlerId).toBe('o1');
    // And his allowance is intact — this is what "already bowled his overs"
    // was wrongly reporting.
    expect(bowlerCapFor(undone, 'o1', r)).toBe(r.maxOversPerBowler);
    expect(undone.bowlers.o1?.oversCompleted).toBeLessThan(r.maxOversPerBowler);
  });
})

describe('R16 — correcting a dot count by hand', () => {
  it('a batsman wrongly on two dots can be put back, and is not then dismissed', () => {
    const r = rules({ threeDotOut: true });
    let s = bowlMany(innings(), [DOT, DOT], r).state;
    expect(s.batsmen.b1?.dotStreak).toBe(2);

    // The scorer says that is wrong: he has faced one dot, not two.
    s = applyEvent(s, { type: 'dot_count_set', playerId: 'b1', dots: 1 }, r);
    expect(s.batsmen.b1?.dotStreak).toBe(1);

    // The next dot is his second, not his third — so he survives.
    const next = bowl(s, DOT, r);
    expect(next.result.wicket).toBeNull();
    expect(next.state.batsmen.b1?.dotStreak).toBe(2);
  });

  it('clearing the count also lifts a carried "next dot dismisses"', () => {
    const r = rules({ threeDotOut: true, dotCarryMode: 'carry' });
    let s = bowlMany(innings(), [DOT, DOT], r).state;
    s = bowl(s, {
      physicalRuns: 1,
      wicket: { type: 'runout', playerOutId: 'b2', newBatsmanId: 'b3', newBatsmanOnStrike: false },
    }, r).state;
    expect(s.batsmen.b1?.nextDotDismisses).toBe(true);

    s = applyEvent(s, { type: 'dot_count_set', playerId: 'b1', dots: 0 }, r);
    expect(s.batsmen.b1?.nextDotDismisses).toBe(false);
    if (s.strikerId !== 'b1') s = applyEvent(s, { type: 'strike_switched_manually' }, r);
    expect(bowl(s, DOT, r).result.wicket).toBeNull();
  });
})
