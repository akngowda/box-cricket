/**
 * R0 / R2 — the effective config and how the three settings levels merge.
 *
 * Settings cascade general -> series -> match and freeze at the toss. The
 * engine only ever receives the frozen result; it never reads settings tables
 * (02-ARCHITECTURE §4, "Settings resolution").
 */

import type { RulesConfig, RulesConfigOverride } from './types';

/** R2 — the defaults column of the effective-config table. */
export const DEFAULT_RULES: RulesConfig = {
  oversPerInnings: 6,
  ballsPerOver: 6,
  maxOversPerBowler: 2,
  noBallRuns: 2,
  wideRuns: 1,
  freeHitAfterNoBall: true,
  impactOverAllowed: true,
  impactBallAllowed: true,
  doubleExtrasOnImpact: false,
  threeDotOut: false,
  threeBodyOut: false,
  dotCarryMode: 'carry',
  winnerChoosesNextMatch: true,
  lastManBothTeams: false,
  lastManWeakerTeamOnly: false,
  lastManHasDeadrunner: true,
  audioPerBall: false,
  audioPerOver: false,
  dotsToOut: 3,
  bodyHitsToOut: 3,
  allowOneExtraOverBowler: false,
};

/**
 * R0 — merge the three levels. Later levels win key by key; an absent key
 * inherits. The admin never sees two levels at once, but the values cascade.
 */
export function resolveConfig(
  general: RulesConfigOverride = {},
  series: RulesConfigOverride = {},
  match: RulesConfigOverride = {},
): RulesConfig {
  return {
    ...DEFAULT_RULES,
    ...stripUndefined(general),
    ...stripUndefined(series),
    ...stripUndefined(match),
  };
}

function stripUndefined(o: RulesConfigOverride): RulesConfigOverride {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out as RulesConfigOverride;
}

/** Total legal deliveries in a full innings. */
export function totalLegalBalls(rules: RulesConfig): number {
  return rules.oversPerInnings * rules.ballsPerOver;
}
