/**
 * The bridge between the event log and the engine.
 *
 * The denormalised columns on `deliveries` (team_runs, batsman_runs,
 * bowler_conceded, zone, impact flags) exist so a viewer can read a scorecard
 * without replaying anything. They must never be typed by hand: they come from
 * the engine's DeliveryResult, here, in one place.
 */

import type {
  DeclaredRuns,
  DeliveryInput,
  DeliveryResult,
  InningsState,
  RulesConfig,
  RulesConfigOverride,
  StoredDelivery,
} from '../engine/types';
import { resolveConfig } from '../engine/rules';
import type { DeliveryInsert, DeliveryRow, Json } from './database.types';

/** Context the row needs that the engine does not carry. */
export interface DeliveryRowContext {
  inningsId: string;
  seq: number;
  createdBy?: string | null;
}

/**
 * Build the row to insert from the input the scorer tapped, the engine's
 * verdict on it, and the state the ball was bowled at.
 */
export function toDeliveryRow(
  input: DeliveryInput,
  result: DeliveryResult,
  stateBefore: InningsState,
  ctx: DeliveryRowContext,
): DeliveryInsert {
  const strikerId = stateBefore.strikerId;
  const bowlerId = input.bowlerId ?? stateBefore.currentBowlerId;
  if (strikerId === null || bowlerId === null) {
    throw new Error('a delivery needs a striker and a bowler');
  }
  return {
    id: input.id,
    innings_id: ctx.inningsId,
    seq: ctx.seq,
    over_no: result.overNo,
    ball_no: result.ballNo,
    bowler_id: bowlerId,
    striker_id: strikerId,
    non_striker_id: stateBefore.nonStrikerId,
    zone: result.zone,
    contact: result.contact,
    declared_runs: input.declaredRuns ?? 0,
    physical_runs: input.physicalRuns ?? 0,
    extra_type: input.extra ?? 'none',
    is_body_hit: input.isBodyHit ?? false,
    is_roof_hit: input.isRoofHit ?? false,
    is_free_hit: result.wasFreeHit,
    impact_over: result.isImpactOver,
    impact_ball: result.isImpactBall,
    wicket_type: result.wicket?.type ?? null,
    player_out_id: result.wicket?.playerOutId ?? null,
    fielder_id: result.wicket?.fielderId ?? null,
    team_runs: result.teamRuns,
    batsman_runs: result.batsmanRuns,
    bowler_conceded: result.bowlerConceded,
    created_by: ctx.createdBy ?? null,
  };
}

/** Turn a stored row back into engine input, for replay (R7d, §1). */
export function toStoredDelivery(row: DeliveryRow): StoredDelivery {
  const stored: StoredDelivery = {
    id: row.id,
    seq: row.seq,
    isVoided: row.is_voided,
    declaredRuns: row.declared_runs as DeclaredRuns,
    contact: row.contact,
    physicalRuns: row.physical_runs,
    extra: row.extra_type,
    isBodyHit: row.is_body_hit,
    isRoofHit: row.is_roof_hit,
    bowlerId: row.bowler_id,
  };
  // R16c — automatic dismissals are re-derived by the engine on replay, so
  // they must not be fed back in as explicit wickets.
  if (row.wicket_type && row.wicket_type !== 'dotout' && row.wicket_type !== 'bodyout') {
    stored.wicket = {
      type: row.wicket_type,
      ...(row.player_out_id ? { playerOutId: row.player_out_id } : {}),
      ...(row.fielder_id ? { fielderId: row.fielder_id } : {}),
    };
  }
  return stored;
}

/**
 * R0 / R2 — read the frozen effective config off the match row. Before the
 * toss there is nothing frozen, so the caller resolves the cascade instead.
 */
export function rulesFromMatch(effectiveRules: Json | null): RulesConfig | null {
  if (effectiveRules === null || typeof effectiveRules !== 'object' || Array.isArray(effectiveRules)) {
    return null;
  }
  return resolveConfig({}, {}, effectiveRules as RulesConfigOverride);
}

/** The value to freeze into matches.effective_rules at the toss. */
export function freezeRules(
  general: Json,
  series: Json,
  match: Json,
): RulesConfig {
  return resolveConfig(asOverride(general), asOverride(series), asOverride(match));
}

function asOverride(v: Json): RulesConfigOverride {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as RulesConfigOverride) : {};
}
