'use client';

/**
 * Phase 8 — stats, and the rankings Phase 5 shows.
 *
 * Everything attaches to the player, never to the jersey: squads change every
 * week, so a team total would be meaningless. There is no points table.
 *
 * These read the delivery log's denormalised columns (team_runs, batsman_runs,
 * bowler_conceded), which the engine wrote — so a scorecard never disagrees
 * with the pad.
 */

import type { DeliveryRow } from '../src/db/database.types';
import { squadMembers, type DB } from './store';

export interface PlayerStats {
  playerId: string;
  name: string;
  matches: number;
  // batting
  runs: number;
  ballsFaced: number;
  outs: number;
  best: number;
  zones: [number, number, number, number];
  pitched: number;
  direct: number;
  dotOutsSuffered: number;
  bodyOutsSuffered: number;
  // bowling
  ballsBowled: number;
  conceded: number;
  wickets: number;
  dotBalls: number;
  extrasConceded: number;
  // fielding
  catches: number;
  runOuts: number;
  stumpings: number;
  // weeks
  matchesWon: number;
}

const CREDITED = new Set(['bowled', 'caught', 'stumped', 'dotout', 'bodyout']);

function blank(playerId: string, name: string): PlayerStats {
  return {
    playerId,
    name,
    matches: 0,
    runs: 0,
    ballsFaced: 0,
    outs: 0,
    best: 0,
    zones: [0, 0, 0, 0],
    pitched: 0,
    direct: 0,
    dotOutsSuffered: 0,
    bodyOutsSuffered: 0,
    ballsBowled: 0,
    conceded: 0,
    wickets: 0,
    dotBalls: 0,
    extrasConceded: 0,
    catches: 0,
    runOuts: 0,
    stumpings: 0,
    matchesWon: 0,
  };
}

export const average = (s: PlayerStats): number | null => (s.outs === 0 ? null : s.runs / s.outs);
export const strikeRate = (s: PlayerStats): number | null =>
  s.ballsFaced === 0 ? null : (s.runs / s.ballsFaced) * 100;
export const economy = (s: PlayerStats, ballsPerOver = 6): number | null =>
  s.ballsBowled === 0 ? null : s.conceded / (s.ballsBowled / ballsPerOver);

export const fmt = (n: number | null, dp = 1): string => (n === null ? '—' : n.toFixed(dp));
export const overs = (balls: number, perOver = 6): string =>
  `${Math.floor(balls / perOver)}.${balls % perOver}`;

/**
 * Aggregate every player's numbers. Pass a seriesId to scope it to one
 * weekend, or leave it out for the overall table.
 */
export function playerStats(db: DB, seriesId?: string): PlayerStats[] {
  const matches = db.matches.filter((m) => (seriesId ? m.series_id === seriesId : true));
  const matchIds = new Set(matches.map((m) => m.id));
  const inningsIds = new Set(db.innings.filter((i) => matchIds.has(i.match_id)).map((i) => i.id));

  const table = new Map<string, PlayerStats>();
  const get = (id: string): PlayerStats => {
    const existing = table.get(id);
    if (existing) return existing;
    const name = db.players.find((p) => p.id === id)?.name ?? 'Unknown';
    const fresh = blank(id, name);
    table.set(id, fresh);
    return fresh;
  };

  // Appearances and weeks won, from the squads themselves.
  for (const match of matches) {
    for (const squadId of [match.squad_a_id, match.squad_b_id]) {
      if (!squadId) continue;
      for (const p of squadMembers(db, squadId)) {
        const s = get(p.id);
        s.matches += 1;
        if (match.winner_squad_id === squadId) s.matchesWon += 1;
      }
    }
  }

  // Per-innings best score needs runs grouped by innings, not just totalled.
  const perInnings = new Map<string, number>();

  for (const d of db.deliveries) {
    if (d.is_voided || !inningsIds.has(d.innings_id)) continue;
    const legal = d.extra_type === 'none';

    // batting
    const bat = get(d.striker_id);
    bat.runs += d.batsman_runs;
    if (legal) bat.ballsFaced += 1;
    if (d.zone !== null && d.contact !== 'none') {
      bat.zones[d.zone as 0 | 1 | 2 | 3] += 1;
      if (d.contact === 'pitched') bat.pitched += 1;
      else bat.direct += 1;
    }
    const key = `${d.innings_id}:${d.striker_id}`;
    perInnings.set(key, (perInnings.get(key) ?? 0) + d.batsman_runs);

    // bowling
    const bowl = get(d.bowler_id);
    bowl.conceded += d.bowler_conceded;
    if (legal) {
      bowl.ballsBowled += 1;
      if (d.bowler_conceded === 0) bowl.dotBalls += 1;
    } else {
      bowl.extrasConceded += d.team_runs;
    }

    if (d.wicket_type && d.player_out_id) {
      const out = get(d.player_out_id);
      if (d.wicket_type !== 'retired_hurt') out.outs += 1;
      if (d.wicket_type === 'dotout') out.dotOutsSuffered += 1;
      if (d.wicket_type === 'bodyout') out.bodyOutsSuffered += 1;
      if (CREDITED.has(d.wicket_type)) bowl.wickets += 1;
      if (d.fielder_id) {
        const field = get(d.fielder_id);
        if (d.wicket_type === 'caught') field.catches += 1;
        if (d.wicket_type === 'runout') field.runOuts += 1;
        if (d.wicket_type === 'stumped') field.stumpings += 1;
      }
    }
  }

  for (const [key, runs] of perInnings) {
    const playerId = key.split(':')[1];
    if (!playerId) continue;
    const s = table.get(playerId);
    if (s && runs > s.best) s.best = runs;
  }

  return [...table.values()];
}

export type RankKey = 'runs' | 'average' | 'wickets' | 'strikeRate' | 'economy' | 'fielding' | 'won';

export function rank(stats: PlayerStats[], key: RankKey): PlayerStats[] {
  const list = [...stats];
  switch (key) {
    case 'runs':
      return list.filter((s) => s.ballsFaced > 0).sort((a, b) => b.runs - a.runs);
    // An average needs at least one dismissal, otherwise it is not a number.
    case 'average':
      return list
        .filter((s) => s.outs > 0)
        .sort((a, b) => (average(b) ?? 0) - (average(a) ?? 0));
    case 'wickets':
      return list
        .filter((s) => s.ballsBowled > 0)
        .sort((a, b) => b.wickets - a.wickets || (economy(a) ?? 99) - (economy(b) ?? 99));
    case 'strikeRate':
      // A handful of balls should not top the table.
      return list
        .filter((s) => s.ballsFaced >= 6)
        .sort((a, b) => (strikeRate(b) ?? 0) - (strikeRate(a) ?? 0));
    case 'economy':
      return list
        .filter((s) => s.ballsBowled >= 6)
        .sort((a, b) => (economy(a) ?? 99) - (economy(b) ?? 99));
    case 'fielding':
      return list
        .map((s) => s)
        .filter((s) => s.catches + s.runOuts + s.stumpings > 0)
        .sort(
          (a, b) =>
            b.catches + b.runOuts + b.stumpings - (a.catches + a.runOuts + a.stumpings),
        );
    case 'won':
      return list.filter((s) => s.matches > 0).sort((a, b) => b.matchesWon - a.matchesWon);
  }
}

/** The series scoreline — wins per squad, and whether it is already decided. */
export function seriesState(db: DB, seriesId: string) {
  const series = db.series.find((s) => s.id === seriesId);
  const squads = db.squads.filter((s) => s.series_id === seriesId);
  const matches = db.matches.filter((m) => m.series_id === seriesId);
  const played = matches.filter((m) => m.status === 'completed');

  const wins = new Map<string, number>();
  let ties = 0;
  for (const m of played) {
    if (m.winner_squad_id) wins.set(m.winner_squad_id, (wins.get(m.winner_squad_id) ?? 0) + 1);
    else ties += 1;
  }

  const planned = series?.planned_matches ?? 0;
  const remaining = Math.max(0, planned - played.length);
  const table = squads.map((s) => ({ squadId: s.id, wins: wins.get(s.id) ?? 0 }));
  const sorted = [...table].sort((a, b) => b.wins - a.wins);
  const leader = sorted[0];
  const chaser = sorted[1];
  const decided =
    leader !== undefined && chaser !== undefined && leader.wins > chaser.wins + remaining;

  return { series, squads, matches, played: played.length, planned, remaining, table, ties, decided, leader };
}

/** Ball-by-ball, newest first, for the commentary feed. */
export function inningsDeliveries(db: DB, inningsId: string): DeliveryRow[] {
  return db.deliveries
    .filter((d) => d.innings_id === inningsId && !d.is_voided)
    .sort((a, b) => a.seq - b.seq);
}
