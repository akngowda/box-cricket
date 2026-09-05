'use client';

/**
 * Store rows -> engine timeline -> scoreboard.
 *
 * §1 of the architecture: the score is always derived by replaying the log.
 * Nothing in the app reads a stored total.
 */

import { replayTimeline, type TimelineEntry } from '../src/engine/replay';
import { resolveConfig } from '../src/engine/rules';
import { toStoredDelivery } from '../src/db/mappers';
import type { CreateInningsOptions } from '../src/engine/engine';
import type { DeliveryResult, InningsState, MatchEvent, RulesConfig, RulesConfigOverride } from '../src/engine/types';
import type { InningsRow, MatchRow } from '../src/db/database.types';
import { squadMembers, type DB } from './store';

/** R2 — the config frozen at the toss, or the cascade so far if not yet tossed. */
export function matchRules(db: DB, match: MatchRow): RulesConfig {
  if (match.effective_rules) return resolveConfig({}, {}, match.effective_rules as RulesConfigOverride);
  const series = db.series.find((s) => s.id === match.series_id);
  const general = db.app_settings.find((s) => s.scope === 'general')?.config ?? {};
  return resolveConfig(
    general as RulesConfigOverride,
    (series?.rules_config ?? {}) as RulesConfigOverride,
    match.rules_override as RulesConfigOverride,
  );
}

/** The openers and the first bowler, recorded as an innings_start event. */
export function openingOf(
  db: DB,
  inningsId: string,
): { strikerId: string; nonStrikerId: string; bowlerId: string } | null {
  const ev = db.match_events.find((e) => e.innings_id === inningsId && e.type === 'innings_start');
  if (!ev) return null;
  const p = ev.payload as { strikerId?: string; nonStrikerId?: string; bowlerId?: string };
  if (!p.strikerId || !p.nonStrikerId || !p.bowlerId) return null;
  return { strikerId: p.strikerId, nonStrikerId: p.nonStrikerId, bowlerId: p.bowlerId };
}

export function inningsInit(db: DB, innings: InningsRow): CreateInningsOptions | null {
  const opening = openingOf(db, innings.id);
  if (!opening) return null;
  const squad = db.squads.find((s) => s.id === innings.batting_squad_id);
  const batting = squadMembers(db, innings.batting_squad_id).map((p) => p.id);
  const bowling = squadMembers(db, innings.bowling_squad_id).map((p) => p.id);

  // The openers lead the order; everyone else follows in squad order (R1a
  // appends anyone added later to the bottom).
  const rest = batting.filter((id) => id !== opening.strikerId && id !== opening.nonStrikerId);
  return {
    battingOrder: [opening.strikerId, opening.nonStrikerId, ...rest],
    bowlingSquad: bowling,
    strikerId: opening.strikerId,
    nonStrikerId: opening.nonStrikerId,
    bowlerId: opening.bowlerId,
    target: innings.target,
    lastManEnabled: squad?.last_man_enabled ?? false,
    deadrunnerId: innings.deadrunner_id,
  };
}

/** Deliveries and match_events, interleaved by seq, as the engine wants them. */
export function inningsTimeline(db: DB, inningsId: string): TimelineEntry[] {
  const balls: TimelineEntry[] = db.deliveries
    .filter((d) => d.innings_id === inningsId)
    .map((d) => ({ kind: 'delivery', delivery: toStoredDelivery(d) }));

  const events: TimelineEntry[] = [];
  for (const row of db.match_events) {
    if (row.innings_id !== inningsId || row.seq === null) continue;
    const event = toEngineEvent(row.type, row.payload as Record<string, unknown>);
    if (event) events.push({ kind: 'event', seq: row.seq, event });
  }
  return [...balls, ...events];
}

function toEngineEvent(type: string, payload: Record<string, unknown>): MatchEvent | null {
  switch (type) {
    case 'bowler_selected':
      return typeof payload.bowlerId === 'string' ? { type: 'bowler_selected', bowlerId: payload.bowlerId } : null;
    case 'bowler_replaced_midover':
      return typeof payload.bowlerId === 'string'
        ? { type: 'bowler_replaced_midover', bowlerId: payload.bowlerId }
        : null;
    case 'impact_over_declared':
      return typeof payload.overNo === 'number' ? { type: 'impact_over_declared', overNo: payload.overNo } : null;
    case 'impact_over_undone':
      return { type: 'impact_over_undone' };
    case 'strike_switched_manually':
      return { type: 'strike_switched_manually' };
    case 'deadrunner_set':
      return typeof payload.playerId === 'string' ? { type: 'deadrunner_set', playerId: payload.playerId } : null;
    case 'squad_player_added':
      return typeof payload.playerId === 'string' ? { type: 'squad_player_added', playerId: payload.playerId } : null;
    case 'batsman_corrected':
      return typeof payload.outgoingId === 'string' && typeof payload.incomingId === 'string'
        ? { type: 'batsman_corrected', outgoingId: payload.outgoingId, incomingId: payload.incomingId }
        : null;
    case 'retired_hurt_returned':
      return typeof payload.playerId === 'string'
        ? { type: 'retired_hurt_returned', playerId: payload.playerId, onStrike: payload.onStrike === true }
        : null;
    default:
      // innings_start / innings_end and friends are bookkeeping, not engine input.
      return null;
  }
}

export interface Scoreboard {
  state: InningsState;
  results: DeliveryResult[];
  error: string | null;
}

export function scoreboard(db: DB, innings: InningsRow, rules: RulesConfig): Scoreboard | null {
  const init = inningsInit(db, innings);
  if (!init) return null;
  try {
    const out = replayTimeline(inningsTimeline(db, innings.id), rules, init);
    return { state: out.state, results: out.results, error: null };
  } catch (err) {
    return { state: null as never, results: [], error: (err as Error).message };
  }
}

/** Both innings of a match, in order, for scorecards and results. */
export function matchInnings(db: DB, matchId: string): InningsRow[] {
  return db.innings.filter((i) => i.match_id === matchId).sort((a, b) => a.seq - b.seq);
}
