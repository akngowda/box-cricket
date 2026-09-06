/**
 * The scoring engine. Pure: `(state, input, rules) => { state, result }`.
 *
 * `applyDelivery` follows Part O of 01-RULES-SPEC.md step for step. The step
 * numbers appear as comments so the order can be audited against the spec.
 */

import { totalLegalBalls } from './rules';
import {
  EngineError,
  type BallPip,
  type BatsmanState,
  type BowlerState,
  type Contact,
  type DeclaredRuns,
  type DeliveryInput,
  type DeliveryResult,
  type InningsEndReason,
  type InningsState,
  type MatchEvent,
  type RulesConfig,
  type WicketType,
  type Zone,
} from './types';

// ---------------------------------------------------------------------------
// Construction and derived reads
// ---------------------------------------------------------------------------

export interface CreateInningsOptions {
  battingOrder: string[];
  bowlingSquad: string[];
  strikerId: string;
  nonStrikerId: string;
  bowlerId?: string;
  /** R28 — set for the second innings. */
  target?: number | null;
  /** R24 — allowed for this side by the effective config. */
  lastManEnabled?: boolean;
  /** R25a */
  deadrunnerId?: string | null;
}

export function createInnings(opts: CreateInningsOptions): InningsState {
  const batsmen: Record<string, BatsmanState> = {};
  for (const id of opts.battingOrder) batsmen[id] = newBatsman(id);

  const striker = batsmen[opts.strikerId];
  const nonStriker = batsmen[opts.nonStrikerId];
  if (!striker || !nonStriker) {
    throw new EngineError('Openers must be in the batting order', 'R1');
  }
  striker.hasBatted = true;
  nonStriker.hasBatted = true;

  const bowlers: Record<string, BowlerState> = {};
  if (opts.bowlerId) bowlers[opts.bowlerId] = newBowler(opts.bowlerId);

  return {
    battingOrder: [...opts.battingOrder],
    bowlingSquad: [...opts.bowlingSquad],
    nextBatsmanIndex: 2,
    strikerId: opts.strikerId,
    nonStrikerId: opts.nonStrikerId,
    currentBowlerId: opts.bowlerId ?? null,
    lastOverBowlerId: null,
    runs: 0,
    wickets: 0,
    legalBalls: 0,
    extras: { wides: 0, noBalls: 0, total: 0 },
    batsmen,
    bowlers,
    isFreeHit: false,
    impactOverNumber: null,
    lastManEnabled: opts.lastManEnabled ?? false,
    lastManActive: false,
    deadrunnerId: opts.deadrunnerId ?? null,
    target: opts.target ?? null,
    status: 'in_progress',
    endReason: null,
    fallOfWickets: [],
  };
}

function newBatsman(id: string): BatsmanState {
  return {
    id,
    runs: 0,
    ballsFaced: 0,
    dotStreak: 0,
    bodyHits: 0,
    ballHistory: [],
    nextDotDismisses: false,
    suddenDeath: false,
    zoneCounts: [0, 0, 0, 0],
    contactCounts: { pitched: 0, direct: 0 },
    isOut: false,
    outType: null,
    isRetiredHurt: false,
    hasBatted: false,
  };
}

function newBowler(id: string): BowlerState {
  return {
    id,
    legalBalls: 0,
    lastBowledAtBall: -Infinity,
    oversCompleted: 0,
    runsConceded: 0,
    wickets: 0,
    dotBalls: 0,
    wides: 0,
    noBalls: 0,
  };
}

/** 0-indexed over currently in progress. */
export function currentOver(state: InningsState, rules: RulesConfig): number {
  return Math.floor(state.legalBalls / rules.ballsPerOver);
}

/** Legal balls already bowled in the current over. */
export function ballsInCurrentOver(state: InningsState, rules: RulesConfig): number {
  return state.legalBalls % rules.ballsPerOver;
}

/**
 * R20b — a bowler must wait a full over's worth of legal balls after his last
 * delivery before he can bowl again. Measuring in balls rather than overs
 * makes it hold even when he came on mid-over as a replacement (R20c).
 */
export function ballsUntilEligible(
  state: InningsState,
  bowlerId: string,
  rules: RulesConfig,
): number {
  const b = state.bowlers[bowlerId];
  if (!b || b.lastBowledAtBall === -Infinity) return 0;
  return Math.max(0, rules.ballsPerOver - (state.legalBalls - b.lastBowledAtBall));
}

/**
 * R20a — the cap, allowing for the extra-over setting: when it is on, one
 * bowler (and only one) may go a single over beyond it.
 */
export function bowlerCapFor(state: InningsState, bowlerId: string, rules: RulesConfig): number {
  if (!rules.allowOneExtraOverBowler) return rules.maxOversPerBowler;
  const overCap = Object.values(state.bowlers).find(
    (b) => b.oversCompleted > rules.maxOversPerBowler,
  );
  // Whoever took the extra over keeps it; nobody else may.
  if (overCap) return overCap.id === bowlerId ? rules.maxOversPerBowler + 1 : rules.maxOversPerBowler;
  return rules.maxOversPerBowler + 1;
}

/** R20a + R20b — who may bowl next: the rest gap, and the per-bowler cap. */
export function eligibleBowlers(state: InningsState, rules: RulesConfig): string[] {
  return state.bowlingSquad.filter((id) => {
    if (ballsUntilEligible(state, id, rules) > 0) return false;
    const b = state.bowlers[id];
    return (b?.oversCompleted ?? 0) < bowlerCapFor(state, id, rules);
  });
}

/**
 * R20 — which over is the impact over.
 *
 * The batting captain declares one, once per innings. If he never does, the
 * last over of the innings is the impact over by default — the side does not
 * lose it by forgetting. Returns null when impact overs are switched off.
 */
export function impactOverOf(state: InningsState, rules: RulesConfig): number | null {
  if (!rules.impactOverAllowed) return null;
  return state.impactOverNumber ?? rules.oversPerInnings - 1;
}

/** True once the impact over is the fallback rather than a declaration. */
export function impactOverIsDefault(state: InningsState, rules: RulesConfig): boolean {
  return rules.impactOverAllowed && state.impactOverNumber === null;
}

/** R4 / R5 — the zone a declared value came from, given the row tapped. */
export function zoneFor(declared: DeclaredRuns, contact: Contact): Zone {
  if (declared === 0) return 0;
  if (contact === 'pitched') {
    if (declared === 1) return 1;
    if (declared === 2) return 2;
    if (declared === 3) return 3;
  }
  if (contact === 'direct') {
    if (declared === 2) return 1;
    if (declared === 4) return 2;
    if (declared === 6) return 3;
  }
  throw new EngineError(`declared ${declared} is not on the ${contact} row`, 'R5');
}

// ---------------------------------------------------------------------------
// Non-ball events (match_events)
// ---------------------------------------------------------------------------

export function applyEvent(
  state: InningsState,
  event: MatchEvent,
  rules: RulesConfig,
): InningsState {
  const s = structuredClone(state);

  switch (event.type) {
    // R20 — declared by the batting captain before the over's first ball.
    case 'impact_over_declared': {
      if (!rules.impactOverAllowed) {
        throw new EngineError('Impact over is off in the effective config', 'R20');
      }
      if (s.impactOverNumber !== null) {
        throw new EngineError('Impact over already declared this innings', 'R20');
      }
      const over = currentOver(s, rules);
      const started = ballsInCurrentOver(s, rules) > 0;
      if (event.overNo < over || (event.overNo === over && started)) {
        throw new EngineError('Impact over locks once the over starts', 'R20');
      }
      s.impactOverNumber = event.overNo;
      return s;
    }

    /**
     * R20e — the declaration can be taken back only while the over is fresh.
     *
     * Once a ball has been bowled it is settled: the runs on it were doubled
     * or they were not, and moving the declaration afterwards would rewrite
     * what already happened. Undoing those balls makes the over fresh again,
     * and then it can be taken back — which is the honest way round, because
     * the log is what decides.
     */
    case 'impact_over_undone': {
      if (s.impactOverNumber === null) return s;
      const over = currentOver(s, rules);
      if (ballsInCurrentOver(s, rules) > 0) {
        throw new EngineError('An over is under way — undo its balls first', 'R20e');
      }
      if (s.impactOverNumber < over) {
        throw new EngineError('That impact over has already been bowled', 'R20e');
      }
      s.impactOverNumber = null;
      return s;
    }

    // R26 — the scorer can swap the striker at any time.
    case 'strike_switched_manually': {
      if (s.lastManActive) return s;
      swapStrike(s);
      return s;
    }

    // R20d / R20c — pick, or replace mid-over.
    case 'bowler_selected':
    case 'bowler_replaced_midover': {
      const b = s.bowlers[event.bowlerId] ?? newBowler(event.bowlerId);
      s.bowlers[event.bowlerId] = b;
      if (!s.bowlingSquad.includes(event.bowlerId)) {
        throw new EngineError('Bowler is not in the bowling squad', 'R20d');
      }
      if (b.oversCompleted >= bowlerCapFor(s, event.bowlerId, rules)) {
        throw new EngineError('Bowler has used his over allowance', 'R20a');
      }
      const wait = ballsUntilEligible(s, event.bowlerId, rules);
      if (wait > 0) {
        throw new EngineError(`Bowler needs ${wait} more legal ball(s) of rest`, 'R20b');
      }
      s.currentBowlerId = event.bowlerId;
      return s;
    }

    // R25a — he stands at the non-striker's end rather than running.
    case 'deadrunner_set':
      s.deadrunnerId = event.playerId;
      if (s.lastManActive) s.nonStrikerId = event.playerId;
      return s;

    // R1a — a player can be added to a squad at any time; he joins the bottom.
    case 'squad_player_added': {
      if (!s.batsmen[event.playerId]) {
        s.batsmen[event.playerId] = newBatsman(event.playerId);
        s.battingOrder.push(event.playerId);
      }
      if (!s.bowlingSquad.includes(event.playerId)) {
        // Batting-side adds do not join the bowling squad; the caller decides.
      }
      return s;
    }

    // R1a — removal keeps his stats; he simply cannot come in again.
    case 'squad_player_removed': {
      const b = s.batsmen[event.playerId];
      if (b && !b.hasBatted) {
        s.battingOrder = s.battingOrder.filter((id) => id !== event.playerId);
        s.nextBatsmanIndex = Math.min(s.nextBatsmanIndex, s.battingOrder.length);
      }
      return s;
    }

    // Correcting a mis-tapped batsman: swap who is at the crease.
    case 'batsman_corrected': {
      const incoming = s.batsmen[event.incomingId];
      if (!incoming) throw new EngineError('That player is not in the batting order', 'R1');
      if (incoming.isOut) throw new EngineError('An out batsman never bats again', 'R27');
      if (s.strikerId !== event.outgoingId && s.nonStrikerId !== event.outgoingId) {
        throw new EngineError('That batsman is not at the crease', 'R26');
      }
      incoming.hasBatted = true;

      // The man being taken off was put in by mistake. If he never faced a
      // ball he has not batted at all, so let him come in again later — the
      // old behaviour quietly removed him from every future list.
      const outgoing = s.batsmen[event.outgoingId];
      if (outgoing && outgoing.ballsFaced === 0 && outgoing.runs === 0 && !outgoing.isOut) {
        outgoing.hasBatted = false;
      }

      if (s.strikerId === event.outgoingId) s.strikerId = event.incomingId;
      else s.nonStrikerId = event.incomingId;
      return s;
    }

    // R16 — the scorer corrects a dot count the log got wrong.
    case 'dot_count_set': {
      const b = s.batsmen[event.playerId];
      if (!b) throw new EngineError('That player is not in the batting order', 'R1');
      const dots = Math.max(0, Math.min(rules.dotsToOut - 1, Math.floor(event.dots)));
      b.dotStreak = dots;
      // Setting it below the threshold also lifts a carried or sudden-death
      // flag, otherwise the next dot would still dismiss him.
      if (dots < rules.dotsToOut - 1) {
        b.nextDotDismisses = false;
        b.suddenDeath = false;
      }
      return s;
    }

    // R27 — a retired-hurt batsman resumes from where he left off.
    case 'retired_hurt_returned': {
      const b = s.batsmen[event.playerId];
      if (!b || !b.isRetiredHurt) {
        throw new EngineError('That player is not retired hurt', 'R27');
      }
      if (s.strikerId !== null && s.nonStrikerId !== null) {
        throw new EngineError('Both ends are occupied', 'R27');
      }
      b.isRetiredHurt = false;
      if (s.strikerId === null) s.strikerId = event.playerId;
      else s.nonStrikerId = event.playerId;
      if (event.onStrike && s.strikerId !== event.playerId) swapStrike(s);
      return s;
    }

    default: {
      const never: never = event;
      throw new EngineError(`Unknown event ${JSON.stringify(never)}`, 'R0');
    }
  }
}

function swapStrike(s: InningsState): void {
  const t = s.strikerId;
  s.strikerId = s.nonStrikerId;
  s.nonStrikerId = t;
}

// ---------------------------------------------------------------------------
// R7b — input interlocks, enforced again here so a bad row can never be stored
// ---------------------------------------------------------------------------

const RUNS_ALLOWED_WITH: ReadonlySet<WicketType> = new Set<WicketType>(['runout']);
/** R18 — dismissals the bowler is credited with. */
const BOWLER_CREDITED: ReadonlySet<WicketType> = new Set<WicketType>([
  'bowled',
  'caught',
  'stumped',
  'hitwicket',
  'dotout',
  'bodyout',
]);
/** R12 — a run out is the only way out on a free hit. */
const FREE_HIT_DISMISSALS: ReadonlySet<WicketType> = new Set<WicketType>(['runout']);

function validate(state: InningsState, input: DeliveryInput, rules: RulesConfig): void {
  const declared = input.declaredRuns ?? 0;
  const physical = input.physicalRuns ?? 0;
  const extra = input.extra ?? 'none';
  const body = input.isBodyHit ?? false;
  const wicket = input.wicket;

  if (physical < 0 || physical > 9 || !Number.isInteger(physical)) {
    throw new EngineError('Physical runs must be a single digit under 10', 'R7');
  }
  if (declared !== 0) zoneFor(declared, input.contact ?? 'none'); // throws if the row is wrong

  // R10 — a wide has no zone, no physical runs and no body. He can still be
  // stumped, and he can still knock his own stumps over reaching for it.
  if (extra === 'wide') {
    if (declared !== 0 || physical !== 0) {
      throw new EngineError('A wide carries no runs off the bat', 'R10');
    }
    if (body) throw new EngineError('Body cannot be marked on a wide', 'R7b');
    if (wicket && wicket.type !== 'stumped' && wicket.type !== 'hitwicket') {
      throw new EngineError('Only stumped or hit wicket are possible on a wide', 'R10');
    }
  }

  // R11 / R14a — a no-ball is live for runs, but only a run out can dismiss.
  if (extra === 'noball') {
    if (body) throw new EngineError('Body does not count on a no-ball', 'R17');
    if (wicket && wicket.type !== 'runout') {
      throw new EngineError('Only a run out is possible on a no-ball', 'R11');
    }
  }

  // R7b — Body forces a dot: no runs, no extras.
  if (body) {
    if (!rules.threeBodyOut) {
      throw new EngineError('The body rule is off in the effective config', 'R17a');
    }
    if (declared !== 0 || physical !== 0) {
      throw new EngineError('A body hit is 0 off the bat', 'R7b');
    }
    if (wicket) {
      throw new EngineError('A body hit is a dead ball; no manual wicket', 'R7b');
    }
  }

  if (wicket) {
    // R14a — every dismissal but a run out scores 0 off the bat.
    if (!RUNS_ALLOWED_WITH.has(wicket.type) && (declared !== 0 || physical !== 0)) {
      throw new EngineError(`${wicket.type} cannot carry runs`, 'R14a');
    }
    // R12 — free hit: a run out is the only dismissal.
    if (state.isFreeHit && !FREE_HIT_DISMISSALS.has(wicket.type)) {
      throw new EngineError(`${wicket.type} is not out on a free hit`, 'R12');
    }
    if (wicket.type === 'runout' && !wicket.playerOutId) {
      throw new EngineError('A run out must say who was out', 'R26a');
    }
    // R16c — the 3-dot and 3-body dismissals are recorded by the app, not typed.
    if (wicket.type === 'dotout' || wicket.type === 'bodyout') {
      throw new EngineError(`${wicket.type} is recorded automatically`, 'R16c');
    }
  }
}

// ---------------------------------------------------------------------------
// applyDelivery — Part O, step by step
// ---------------------------------------------------------------------------

export interface ApplyResult {
  state: InningsState;
  result: DeliveryResult;
}

export function applyDelivery(
  state: InningsState,
  input: DeliveryInput,
  rules: RulesConfig,
): ApplyResult {
  if (state.status === 'complete') {
    throw new EngineError('The innings is already complete', 'R28');
  }

  const s = structuredClone(state);
  validate(s, input, rules);

  // ---- Step 1: read the input. Declared and physical both default to 0. ----
  const declared: DeclaredRuns = input.declaredRuns ?? 0;
  const physical = input.physicalRuns ?? 0;
  const extra = input.extra ?? 'none';
  const contact: Contact = declared === 0 ? 'none' : (input.contact ?? 'none');
  const isBody = input.isBodyHit ?? false;

  const strikerId = s.strikerId;
  if (strikerId === null) throw new EngineError('No striker at the crease', 'R26');
  const bowlerId = input.bowlerId ?? s.currentBowlerId;
  if (bowlerId === null) throw new EngineError('No bowler selected', 'R20d');
  s.currentBowlerId = bowlerId;
  if (!s.bowlers[bowlerId]) s.bowlers[bowlerId] = newBowler(bowlerId);

  const wasFreeHit = s.isFreeHit;
  const overNo = currentOver(s, rules);
  const ballNo = ballsInCurrentOver(s, rules) + 1;

  // ---- Step 2: is it a legal ball? (R23) ----
  const isLegalBall = extra === 'none';

  // ---- Step 3: impact ball — decided at commit time, legal balls only (R21).
  const isImpactBall =
    rules.impactBallAllowed && isLegalBall && s.legalBalls === totalLegalBalls(rules) - 1;

  // R20 — impact over applies to every ball bowled in the declared over, and
  // if the batting side never declared one, the last over becomes it by
  // default, so the innings always gets its impact over.
  const isImpactOver = rules.impactOverAllowed && impactOverOf(s, rules) === overNo;

  // ---- Step 4: multipliers never stack (R22). ----
  const multiplier = isImpactOver || isImpactBall ? 2 : 1;

  // ---- Step 5: runs (R8, R23), credited to batsman, bowler and team. ----
  const batRuns = declared + physical;
  const extrasRaw = extra === 'noball' ? rules.noBallRuns : extra === 'wide' ? rules.wideRuns : 0;
  // R13 — extras double only if the setting is on. Default off.
  const extras = rules.doubleExtrasOnImpact ? extrasRaw * multiplier : extrasRaw;
  const teamRuns = batRuns * multiplier + extras;
  const batsmanRuns = batRuns * multiplier;
  const bowlerConceded = teamRuns;

  const striker = s.batsmen[strikerId];
  if (!striker) throw new EngineError('Striker is not in the batting order', 'R1');
  const bowler = s.bowlers[bowlerId] as BowlerState;

  s.runs += teamRuns;
  striker.runs += batsmanRuns;
  bowler.runsConceded += bowlerConceded;

  const zone = contact === 'none' ? (declared === 0 && isLegalBall && !isBody ? 0 : null)
    : zoneFor(declared, contact);
  if (contact !== 'none' && zone !== null) {
    striker.zoneCounts[zone] += 1;
    striker.contactCounts[contact] += 1;
  }

  if (extra === 'wide') {
    s.extras.wides += extras;
    bowler.wides += 1;
  } else if (extra === 'noball') {
    s.extras.noBalls += extras;
    bowler.noBalls += 1;
  }
  s.extras.total = s.extras.wides + s.extras.noBalls;

  // ---- Step 6: if legal, the ball counts. ----
  if (isLegalBall) {
    s.legalBalls += 1;
    striker.ballsFaced += 1;
    bowler.legalBalls += 1;
    bowler.lastBowledAtBall = s.legalBalls; // R20b — the rest clock starts here
    if (bowlerConceded === 0) bowler.dotBalls += 1;

    // R16 — one pip per legal ball faced: blue body, green scored, red dot.
    const pip: BallPip = isBody ? 'body' : batRuns > 0 ? 'scored' : 'dot';
    striker.ballHistory.push(pip);
  }

  const overCompleted = isLegalBall && s.legalBalls % rules.ballsPerOver === 0;

  // ---- Step 7: apply the explicit wicket. ----
  let dismissal: DeliveryResult['wicket'] = null;
  let newBatsmanTookGuard = false;

  if (input.wicket) {
    const w = input.wicket;
    const playerOutId = w.playerOutId ?? strikerId;
    dismissal = {
      type: w.type,
      playerOutId,
      automatic: false,
      bowlerCredited: BOWLER_CREDITED.has(w.type),
      fielderId: w.fielderId ?? null,
    };
    newBatsmanTookGuard = applyDismissal(s, dismissal, bowlerId, w.newBatsmanId);
  }

  // ---- Step 8: automatic dismissals — body before dot (Part O). ----
  // Counters only move on a legal, non-free-hit ball with no wicket (R12, R16, R17).
  if (!dismissal && isLegalBall && !wasFreeHit) {
    if (isBody) {
      striker.bodyHits += 1;
      if (rules.threeBodyOut && striker.bodyHits >= rules.bodyHitsToOut) {
        // R16c — recorded automatically, bowler credited (R18).
        dismissal = {
          type: 'bodyout',
          playerOutId: strikerId,
          automatic: true,
          bowlerCredited: true,
          fielderId: null,
        };
        newBatsmanTookGuard = applyDismissal(s, dismissal, bowlerId, input.newBatsmanId);
      }
    }

    if (!dismissal) {
      if (batRuns > 0) {
        // R16 — any run scored resets the streak and clears a carried flag.
        striker.dotStreak = 0;
        striker.nextDotDismisses = false;
      } else {
        // A body hit is 0 off the bat, so it is also a dot (R17).
        striker.dotStreak += 1;
        const out =
          rules.threeDotOut &&
          (striker.suddenDeath ||
            striker.nextDotDismisses ||
            striker.dotStreak >= rules.dotsToOut);
        if (out) {
          dismissal = {
            type: 'dotout',
            playerOutId: strikerId,
            automatic: true,
            bowlerCredited: true,
            fielderId: null,
          };
          newBatsmanTookGuard = applyDismissal(s, dismissal, bowlerId, input.newBatsmanId);
        }
      }
    }
  } else if (
    // R16a — a run out on the striker's out-defining dot is not itself a dot.
    // The streak carries, and R16b decides what happens to it.
    dismissal &&
    dismissal.type === 'runout' &&
    dismissal.playerOutId !== strikerId &&
    isLegalBall &&
    !wasFreeHit &&
    rules.threeDotOut &&
    striker.dotStreak === rules.dotsToOut - 1
  ) {
    switch (rules.dotCarryMode) {
      case 'reset':
        striker.dotStreak = 0;
        break;
      case 'carry':
        striker.nextDotDismisses = true;
        break;
      case 'sudden_death':
        striker.suddenDeath = true;
        break;
    }
  }

  // ---- Step 9: strike change (R9), disabled for the last man (R25). ----
  let strikeChanged = false;
  if (!s.lastManActive && s.strikerId !== null && s.nonStrikerId !== null) {
    // XOR of odd physical runs and end of over, on the raw count (never doubled).
    let change = (physical % 2 === 1) !== overCompleted;
    if (input.manualStrikeSwitch) change = !change; // R26
    if (change) {
      swapStrike(s);
      strikeChanged = true;
    }
  }

  // R26a — for a run out the scorer says which end the new batsman takes.
  // Applied last so it beats every automatic rule. Never assumed.
  if (newBatsmanTookGuard && input.wicket?.newBatsmanOnStrike !== undefined) {
    const newId = input.wicket.newBatsmanId ?? null;
    if (newId !== null && s.nonStrikerId !== null) {
      const isOnStrike = s.strikerId === newId;
      if (isOnStrike !== input.wicket.newBatsmanOnStrike) {
        swapStrike(s);
        strikeChanged = !strikeChanged;
      }
    }
  }

  // ---- Step 10: over complete — rotate the bowler (R20b). ----
  if (overCompleted) {
    bowler.oversCompleted += 1;
    s.lastOverBowlerId = bowlerId;
    s.currentBowlerId = null; // the scorer must pick, and cannot pick him (R20b)
  }

  // R12 — free hit bookkeeping. A wide/no-ball on a free hit carries it over.
  if (extra === 'noball') s.isFreeHit = rules.freeHitAfterNoBall;
  else if (isLegalBall) s.isFreeHit = false;

  // ---- Step 11: has the innings ended? (R28) ----
  if (s.status !== 'complete') {
    if (s.target !== null && s.runs >= s.target) endInnings(s, 'target_reached');
    else if (s.legalBalls >= totalLegalBalls(rules)) endInnings(s, 'overs_complete');
  }

  // ---- Step 12: the line to speak (R30). ----
  const result: DeliveryResult = {
    batRuns,
    multiplier,
    extras,
    teamRuns,
    batsmanRuns,
    bowlerConceded,
    isLegalBall,
    zone,
    contact,
    isImpactOver,
    isImpactBall,
    wasFreeHit,
    strikeChanged,
    overCompleted,
    wicket: dismissal,
    inningsEnded: s.status === 'complete',
    endReason: s.endReason,
    announcement: '',
    commentary: '',
    overNo,
    ballNo,
  };
  result.announcement = announce(
    result,
    extra,
    isBody,
    dismissal ? dismissal.playerOutId === strikerId : null,
  );
  result.commentary = describeBall(result, extra, declared, physical, isBody);
  return { state: s, result };
}

/**
 * Records a dismissal and brings the next man in.
 * Returns true when a new batsman actually took guard.
 */
function applyDismissal(
  s: InningsState,
  dismissal: NonNullable<DeliveryResult['wicket']>,
  bowlerId: string,
  explicitNewBatsmanId: string | undefined,
): boolean {
  // R25a — the deadrunner standing at the non-striker's end can be run out.
  // He is not a batsman, so nothing is credited to him; it is simply the last
  // wicket, because the last man has nobody left to stand with him.
  if (s.lastManActive && dismissal.playerOutId === s.deadrunnerId) {
    s.wickets += 1;
    s.fallOfWickets.push({
      wicketNumber: s.wickets,
      playerOutId: dismissal.playerOutId,
      type: dismissal.type,
      runs: s.runs,
      legalBalls: s.legalBalls,
      bowlerId: null,
      fielderId: dismissal.fielderId,
    });
    s.nonStrikerId = null;
    endInnings(s, 'all_out');
    return false;
  }

  const out = s.batsmen[dismissal.playerOutId];
  if (!out) throw new EngineError('That player is not in the batting order', 'R1');
  if (out.isOut) throw new EngineError('That player is already out', 'R27');

  // R27 — retired hurt is not a wicket and he can come back; retired out is a
  // wicket with no bowler credit, and he never bats again.
  const countsAsWicket = dismissal.type !== 'retired_hurt';
  if (dismissal.type === 'retired_hurt') {
    out.isRetiredHurt = true;
  } else {
    out.isOut = true;
    out.outType = dismissal.type;
  }
  // R16 — the streak dies with him, and on retirement.
  out.dotStreak = 0;
  out.nextDotDismisses = false;

  if (countsAsWicket) {
    s.wickets += 1;
    s.fallOfWickets.push({
      wicketNumber: s.wickets,
      playerOutId: dismissal.playerOutId,
      type: dismissal.type,
      runs: s.runs,
      legalBalls: s.legalBalls,
      bowlerId: dismissal.bowlerCredited ? bowlerId : null,
      fielderId: dismissal.fielderId,
    });
  }
  // R18
  if (dismissal.bowlerCredited) {
    const b = s.bowlers[bowlerId];
    if (b) b.wickets += 1;
  }

  const wasStriker = s.strikerId === dismissal.playerOutId;
  if (wasStriker) s.strikerId = null;
  else s.nonStrikerId = null;

  // Who walks in: the scorer's pick, else the next man in the order who has
  // not batted. A retired-hurt man is NOT auto-recalled (R27).
  //
  // This used to keep a moving pointer into the batting order and jump it to
  // whoever the scorer picked. Picking someone from lower down — which is
  // normal, and likelier now the lists are alphabetical — left everyone above
  // him unreachable, so a side of nine could be "all out" with men still to
  // bat. Availability is a property of the batsman, so it is read off him.
  const nextAvailable = (): string | null =>
    s.battingOrder.find((id) => {
      const b = s.batsmen[id];
      return b !== undefined && !b.isOut && !b.hasBatted;
    }) ?? null;

  let incoming: string | null = null;
  if (explicitNewBatsmanId) {
    const b = s.batsmen[explicitNewBatsmanId];
    if (!b) throw new EngineError('New batsman is not in the batting order', 'R1');
    if (b.isOut) throw new EngineError('An out batsman never bats again', 'R27');
    incoming = explicitNewBatsmanId;
    b.isRetiredHurt = false;
  } else {
    incoming = nextAvailable();
  }

  if (incoming) {
    const b = s.batsmen[incoming] as BatsmanState;
    b.hasBatted = true;
    // Kept only so the shape of the state is unchanged; nothing reads it to
    // decide who bats next any more.
    s.nextBatsmanIndex = s.battingOrder.filter((id) => s.batsmen[id]?.hasBatted).length;
    if (wasStriker) s.strikerId = incoming;
    else s.nonStrikerId = incoming;
    return true;
  }

  // R25 — nobody left to come in. If last man is allowed for this side, the
  // remaining batsman bats alone and faces every ball. Otherwise, all out.
  const remaining = wasStriker ? s.nonStrikerId : s.strikerId;
  if (s.lastManEnabled && !s.lastManActive && remaining !== null) {
    // R25 — the last man faces every ball. R25a: the deadrunner does not run
    // for him, he stands at the non-striker's end, so a run out is on at both
    // ends. Until one is named, that end simply stands empty.
    s.lastManActive = true;
    s.strikerId = remaining;
    s.nonStrikerId = s.deadrunnerId;
    return false;
  }

  endInnings(s, 'all_out');
  return false;
}

function endInnings(s: InningsState, reason: InningsEndReason): void {
  s.status = 'complete';
  s.endReason = reason;
}

// ---------------------------------------------------------------------------
// R30 — audio. Short, and the same string every time for the same ball.
// ---------------------------------------------------------------------------

const WORDS: Record<number, string> = {
  0: 'no run',
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'eleven',
  12: 'twelve',
  13: 'thirteen',
  14: 'fourteen',
  15: 'fifteen',
  16: 'sixteen',
  17: 'seventeen',
  18: 'eighteen',
  19: 'nineteen',
  20: 'twenty',
};

function say(n: number): string {
  return WORDS[n] ?? String(n);
}

const WICKET_WORDS: Record<WicketType, string> = {
  bowled: 'bowled',
  caught: 'caught',
  runout: 'run out',
  stumped: 'stumped',
  hitwicket: 'hit wicket',
  dotout: 'dot out',
  bodyout: 'body out',
  retired_out: 'retired out',
  retired_hurt: 'retired hurt',
};

/** "no run" / "one run" / "four runs" — what a commentator would say. */
function runsPhrase(n: number): string {
  if (n === 0) return 'dot ball';
  return `${say(n)} ${n === 1 ? 'run' : 'runs'}`;
}

/**
 * The per-ball audio line.
 *
 * It says what happened, the way it would be called out on the turf: the runs
 * with their unit, the kind of extra, and for a wicket the manner of dismissal
 * instead of a number — because "no run" is not what anyone shouts when the
 * stumps go over. A run out is the one dismissal that carries runs, so it gets
 * both, and it names which end went.
 */
function announce(
  r: DeliveryResult,
  extra: 'none' | 'wide' | 'noball',
  isBody: boolean,
  outWasStriker: boolean | null,
): string {
  const parts: string[] = [];
  const w = r.wicket;

  if (extra === 'wide') parts.push('wide ball');
  else if (extra === 'noball') parts.push('no ball');

  // A dismissal that cannot carry runs is announced on its own.
  if (w && w.type !== 'runout') {
    switch (w.type) {
      case 'dotout':
        parts.push('three consecutive dots, batsman out');
        break;
      case 'bodyout':
        parts.push('three body hits in the innings, batsman out');
        break;
      case 'bowled':
        parts.push('batsman bowled out');
        break;
      case 'caught':
        parts.push('batsman caught out');
        break;
      case 'stumped':
        parts.push('batsman stumped out');
        break;
      case 'hitwicket':
        parts.push('batsman hit wicket');
        break;
      case 'retired_out':
        parts.push('batsman retired out');
        break;
      case 'retired_hurt':
        parts.push('batsman retired hurt');
        break;
    }
    return parts.join(', ');
  }

  if (isBody) {
    parts.push('body hit');
    return parts.join(', ');
  }

  // Only the bat runs double. A wide in an impact over is still just a wide,
  // so calling it "doubled" would be wrong as well as confusing.
  if (r.multiplier === 2 && r.batRuns > 0) parts.push('doubled');
  parts.push(runsPhrase(r.teamRuns));

  // R14a — the only dismissal that comes with runs.
  if (w?.type === 'runout') {
    parts.push(outWasStriker === false ? 'non striker run out' : 'batsman run out');
  }
  return parts.join(', ');
}

/**
 * Spoken at the end of every over: the score, and when a side is chasing, what
 * is still needed. That is the number everyone on the sideline is doing in
 * their head anyway.
 */
export function overAnnouncement(
  state: InningsState,
  overNo: number,
  rules?: RulesConfig,
  strikerRuns?: { name: string; runs: number },
): string {
  const parts = [`End of over ${overNo + 1}`, `${state.runs} for ${state.wickets}`];

  if (state.target !== null && rules) {
    const needed = state.target - state.runs;
    const ballsLeft = totalLegalBalls(rules) - state.legalBalls;
    if (needed > 0 && ballsLeft > 0) {
      parts.push(
        `needs ${needed} ${needed === 1 ? 'run' : 'runs'} from ${ballsLeft} ${
          ballsLeft === 1 ? 'ball' : 'balls'
        }`,
      );
    }
  }

  if (strikerRuns) parts.push(`${strikerRuns.name} ${strikerRuns.runs}`);
  return parts.join(', ');
}

/** Spoken once, when the match is settled. */
export function resultAnnouncement(text: string): string {
  return text;
}

/** The written commentary line — this one keeps the detail. */
function describeBall(
  r: DeliveryResult,
  extra: 'none' | 'wide' | 'noball',
  declared: DeclaredRuns,
  physical: number,
  isBody: boolean,
): string {
  const parts: string[] = [];

  if (extra === 'wide') parts.push(`wide, ${say(r.extras)}`);
  else if (extra === 'noball') parts.push(`no ball, ${say(r.extras)}`);

  if (isBody) parts.push('body hit');
  else if (declared > 0) parts.push(`zone ${r.zone} ${r.contact}, ${say(declared)}`);
  else if (extra === 'none' && physical === 0) parts.push('dot ball');

  if (physical > 0) parts.push(`${say(physical)} ran`);
  if (r.multiplier === 2) parts.push(r.isImpactBall ? 'impact ball ×2' : 'impact over ×2');
  if (r.teamRuns > 0) parts.push(`${say(r.teamRuns)}`);
  if (r.wicket) {
    parts.push(
      r.wicket.automatic
        ? `OUT — ${WICKET_WORDS[r.wicket.type]} (auto)`
        : `OUT — ${WICKET_WORDS[r.wicket.type]}`,
    );
  }
  if (r.overCompleted) parts.push('end of over');
  return parts.join(', ');
}
