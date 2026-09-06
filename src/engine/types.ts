/**
 * Box Cricket — engine types.
 *
 * Everything here is data only. The engine is a pure function over these
 * shapes: no I/O, no Date.now(), no randomness (02-ARCHITECTURE §1).
 *
 * Rule IDs (R4, R16b, ...) refer to 01-RULES-SPEC.md.
 */

/** R4 — cone-marked bands along the pitch, away from the batsman. */
export type Zone = 0 | 1 | 2 | 3;

/**
 * R5 — which declared row the scorer tapped. Stored for stats only; it never
 * changes the arithmetic (R8). `none` for a dot, a wide, a body hit, etc.
 */
export type Contact = 'pitched' | 'direct' | 'none';

/** R10 / R11 */
export type ExtraType = 'none' | 'wide' | 'noball';

/** R5 — the only values the declared pad can produce (0 comes from Dot, R7a). */
export type DeclaredRuns = 0 | 1 | 2 | 3 | 4 | 6;

/** R14 — the valid dismissal set. No LBW. */
export type WicketType =
  | 'bowled'
  | 'caught'
  | 'runout'
  | 'stumped'
  | 'hitwicket'
  | 'dotout'
  | 'bodyout'
  | 'retired_out'
  | 'retired_hurt';

/** R16b — how a carried dot streak resolves. */
export type DotCarryMode = 'reset' | 'carry' | 'sudden_death';

/** R16 — one pip per legal ball faced: green scored, red dot, blue body. */
export type BallPip = 'scored' | 'dot' | 'body';

/** R2 — the effective config, frozen at the toss. */
export interface RulesConfig {
  oversPerInnings: number;
  ballsPerOver: number;
  maxOversPerBowler: number;
  /** R11 */
  noBallRuns: number;
  /** R10 */
  wideRuns: number;
  /** R12 */
  freeHitAfterNoBall: boolean;
  /** R20 */
  impactOverAllowed: boolean;
  /** R21 */
  impactBallAllowed: boolean;
  /** R13 — default OFF: extras never double. */
  doubleExtrasOnImpact: boolean;
  /** R16 */
  threeDotOut: boolean;
  /** R17 — also gates the Body button (R17a). */
  threeBodyOut: boolean;
  /** R16b — only consulted when threeDotOut is on. */
  dotCarryMode: DotCarryMode;
  /** R3a */
  winnerChoosesNextMatch: boolean;
  /** R24 */
  lastManBothTeams: boolean;
  /** R24 */
  lastManWeakerTeamOnly: boolean;
  /** R25a */
  lastManHasDeadrunner: boolean;
  /** R30 */
  audioPerBall: boolean;
  /** R30 */
  audioPerOver: boolean;
  /** R16 / R17 — how many dots or body hits dismiss. Not user facing. */
  dotsToOut: number;
  bodyHitsToOut: number;
  /**
   * R20a — lets a single bowler go one over past the cap, for the weeks when
   * a side turns up short of bowlers. Only one bowler may use it.
   */
  allowOneExtraOverBowler: boolean;
}

/** A partial config as stored at one settings level (R0). */
export type RulesConfigOverride = Partial<RulesConfig>;

/** R14a / R26a — what the wicket sheet captures. */
export interface WicketInput {
  type: WicketType;
  /** Defaults to the striker for every type except a run out, where it is required. */
  playerOutId?: string;
  /** R33 — drives fielding stats. */
  fielderId?: string;
  /** Who walks in. Omit when nobody is left (all out / last man). */
  newBatsmanId?: string;
  /**
   * R26a — for a run out the scorer says whether the incoming batsman takes
   * strike. Never assumed. Applied after all automatic strike logic.
   */
  newBatsmanOnStrike?: boolean;
}

/** One tap-set of the scoring pad (R7c). */
export interface DeliveryInput {
  /** Client-generated UUID — idempotency key (02-ARCHITECTURE §4). */
  id: string;
  /** R5 — the single value tapped. Defaults to 0. */
  declaredRuns?: DeclaredRuns;
  /** R5 — which row it came from. */
  contact?: Contact;
  /** R7 — added to declared. Defaults to 0. */
  physicalRuns?: number;
  /** R10 / R11 */
  extra?: ExtraType;
  /** R17 — only settable when threeBodyOut is on (R17a). */
  isBodyHit?: boolean;
  /** R19 — informational; a top-net hit stays live and changes nothing. */
  isRoofHit?: boolean;
  /** Who bowled it. Falls back to state.currentBowlerId. */
  bowlerId?: string;
  /** R14 — omitted when no wicket fell. */
  wicket?: WicketInput;
  /** R26 — scorer overrides the automatic strike result for this ball. */
  manualStrikeSwitch?: boolean;
  /**
   * R16c — who comes in when the app records the dismissal itself (a third
   * dot or a third body hit). Without it the next man in the order walks in.
   */
  newBatsmanId?: string;
}

/** R33 — per-batsman running state. */
export interface BatsmanState {
  id: string;
  runs: number;
  /** Legal balls only. */
  ballsFaced: number;
  /** R16 — consecutive legal dots. */
  dotStreak: number;
  /** R17 — cumulative across the innings, not consecutive. */
  bodyHits: number;
  /** R16 — one entry per legal ball faced. */
  ballHistory: BallPip[];
  /** R16b Carry — the next dot he faces dismisses him. */
  nextDotDismisses: boolean;
  /** R16b Sudden death — any dot from here dismisses him, permanently. */
  suddenDeath: boolean;
  /** R33 — how many balls he put into each zone. */
  zoneCounts: [number, number, number, number];
  /** R5 — pitched vs direct split, for stats. */
  contactCounts: { pitched: number; direct: number };
  isOut: boolean;
  outType: WicketType | null;
  /** R27 — can return later in the same innings. */
  isRetiredHurt: boolean;
  hasBatted: boolean;
}

export interface BowlerState {
  id: string;
  legalBalls: number;
  /**
   * The innings' legal-ball count when he last delivered. He cannot bowl
   * again until a full over's worth of legal balls have gone by (R20b).
   */
  lastBowledAtBall: number;
  oversCompleted: number;
  runsConceded: number;
  /** R18 — only credited dismissals. */
  wickets: number;
  dotBalls: number;
  wides: number;
  noBalls: number;
}

export interface FallOfWicket {
  wicketNumber: number;
  playerOutId: string;
  type: WicketType;
  runs: number;
  legalBalls: number;
  bowlerId: string | null;
  fielderId: string | null;
}

export type InningsEndReason = 'overs_complete' | 'all_out' | 'target_reached';

export interface InningsState {
  /** Batting order — a squad_players list. Extended by roster events (R1a). */
  battingOrder: string[];
  bowlingSquad: string[];
  /** Index of the next un-batted player in battingOrder. */
  nextBatsmanIndex: number;

  strikerId: string | null;
  nonStrikerId: string | null;
  currentBowlerId: string | null;
  /** R20b — hidden from the next over's picker. */
  lastOverBowlerId: string | null;

  runs: number;
  wickets: number;
  /** Legal balls only — overs are derived from this. */
  legalBalls: number;
  extras: { wides: number; noBalls: number; total: number };

  batsmen: Record<string, BatsmanState>;
  bowlers: Record<string, BowlerState>;

  /** R12 */
  isFreeHit: boolean;
  /** R20 — 0-indexed over number, or null if not declared. */
  impactOverNumber: number | null;

  /** R24 — allowed for this side by the effective config. */
  lastManEnabled: boolean;
  /** R25 — one batsman left, batting alone. */
  lastManActive: boolean;
  /**
   * R25a — the last man's partner. He does NOT run for the last man: he
   * stands at the non-striker's end, which means either of them can be run
   * out. The last man still faces every ball.
   */
  deadrunnerId: string | null;

  /** R28 — set when chasing. */
  target: number | null;
  status: 'in_progress' | 'complete';
  endReason: InningsEndReason | null;
  fallOfWickets: FallOfWicket[];
}

/** What one delivery did — everything the UI, commentary and DB row need. */
export interface DeliveryResult {
  /** R8 */
  batRuns: number;
  /** R22 — 1 or 2, never 4. */
  multiplier: number;
  /** R23 */
  extras: number;
  teamRuns: number;
  batsmanRuns: number;
  bowlerConceded: number;
  isLegalBall: boolean;
  /** R4 — derived from declared + contact, for stats. */
  zone: Zone | null;
  contact: Contact;
  isImpactOver: boolean;
  /** R21 */
  isImpactBall: boolean;
  /** R12 — was this ball itself a free hit. */
  wasFreeHit: boolean;
  strikeChanged: boolean;
  overCompleted: boolean;
  /** The dismissal actually recorded, explicit or automatic (R16c). */
  wicket: {
    type: WicketType;
    playerOutId: string;
    /** R16c — the app recorded it without the scorer opening the sheet. */
    automatic: boolean;
    /** R18 */
    bowlerCredited: boolean;
    fielderId: string | null;
  } | null;
  inningsEnded: boolean;
  endReason: InningsEndReason | null;
  /** R30 — the spoken line: the ball's runs, plus "out". Nothing else. */
  announcement: string;
  /** The written ball-by-ball line, which keeps the full detail (R34). */
  commentary: string;
  /** Denormalised over/ball this delivery was bowled in (0-indexed over). */
  overNo: number;
  ballNo: number;
}

/** 02-ARCHITECTURE §4 — the persisted delivery row, replayed by replay.ts. */
export interface StoredDelivery extends DeliveryInput {
  seq: number;
  isVoided?: boolean;
}

/** Non-ball state changes — match_events (02-ARCHITECTURE §4). */
export type MatchEvent =
  | { type: 'impact_over_declared'; overNo: number }
  | { type: 'impact_over_undone' }
  | { type: 'strike_switched_manually' }
  | { type: 'bowler_selected'; bowlerId: string }
  | { type: 'bowler_replaced_midover'; bowlerId: string }
  | { type: 'deadrunner_set'; playerId: string }
  | { type: 'squad_player_added'; playerId: string }
  | { type: 'squad_player_removed'; playerId: string }
  | { type: 'retired_hurt_returned'; playerId: string; onStrike: boolean }
  /**
   * The scorer put the wrong man at the crease. This swaps who is batting
   * from here on; runs already recorded stay with whoever they were credited
   * to, because the log is what happened, not what should have happened.
   */
  | { type: 'batsman_corrected'; outgoingId: string; incomingId: string }
  /**
   * R16 — set a batsman's dot streak by hand.
   *
   * The counter is derived from the log, so if the log is wrong the count is
   * wrong, and the batsman is dismissed for something he did not do. This is
   * the scorer overruling it: it is recorded as an event, so the correction is
   * itself part of the history rather than a silent edit.
   */
  | { type: 'dot_count_set'; playerId: string; dots: number };

export class EngineError extends Error {
  override readonly name = 'EngineError';
  constructor(
    message: string,
    /** The rule ID that rejected the input, e.g. "R7b". */
    readonly rule: string,
  ) {
    super(`[${rule}] ${message}`);
  }
}
