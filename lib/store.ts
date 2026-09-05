'use client';

/**
 * The local store.
 *
 * Rows are shaped exactly like the Postgres tables in
 * supabase/migrations/0001_init.sql, so Phase 5 swaps this file for the
 * Supabase client without touching a screen. Until then everything lives in
 * localStorage: the app runs on a phone with no backend and no login.
 *
 * The one rule that carries over from the architecture: `deliveries` is
 * append-only. Nothing here ever edits a scored ball — undo sets is_voided.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type {
  AppSettingsRow,
  DeliveryRow,
  InningsRow,
  JerseyRow,
  MatchEventRow,
  MatchEventType,
  MatchRow,
  PlayerRow,
  SeriesRow,
  SquadPlayerRow,
  SquadRow,
} from '../src/db/database.types';
import type { RulesConfigOverride } from '../src/engine/types';
import { currentEmail, normalise, SUPER_ADMIN } from './auth';

/**
 * Who did what, and when. In Supabase this becomes an `audit_log` table
 * written by the same statements that make the change; here it is a plain
 * append-only array. Deliveries and match_events already carry created_by,
 * so this covers everything that is NOT a ball: the pool, squads, series,
 * matches, the toss, and admin changes.
 */
export interface AuditRow {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  detail: string;
}

export interface DB {
  /** Emails the super admin has granted admin rights to. */
  admins: string[];
  audit: AuditRow[];
  players: PlayerRow[];
  jerseys: JerseyRow[];
  series: SeriesRow[];
  squads: SquadRow[];
  squad_players: SquadPlayerRow[];
  matches: MatchRow[];
  innings: InningsRow[];
  deliveries: DeliveryRow[];
  match_events: MatchEventRow[];
  app_settings: AppSettingsRow[];
}

const KEY = 'box-cricket.v1';

const EMPTY: DB = {
  admins: [],
  audit: [],
  players: [],
  jerseys: [],
  series: [],
  squads: [],
  squad_players: [],
  matches: [],
  innings: [],
  deliveries: [],
  match_events: [],
  app_settings: [],
};

const now = (): string => new Date().toISOString();

/** The signed-in email, for stamping rows outside React. */
const actor = (): string | null => currentEmail();

/** Append one line to the activity log. Every mutation below goes through it. */
export function logActivity(db: DB, action: string, detail: string): DB {
  return {
    ...db,
    audit: [...(db.audit ?? []), { id: uid(), at: now(), actor: actor(), action, detail }],
  };
}

/** Newest first, for the activity screen. */
export function activity(db: DB, limit = 200): AuditRow[] {
  return [...(db.audit ?? [])].reverse().slice(0, limit);
}

// --- admins -----------------------------------------------------------------

/** Only the super admin may call these; the UI is what enforces it. */
export function addAdmin(db: DB, email: string): DB {
  const e = normalise(email);
  const admins = db.admins ?? [];
  if (e === SUPER_ADMIN || admins.map(normalise).includes(e)) return db;
  return logActivity({ ...db, admins: [...admins, e] }, 'admin_added', e);
}

export function removeAdmin(db: DB, email: string): DB {
  const e = normalise(email);
  if (e === SUPER_ADMIN) return db; // the super admin cannot be removed
  return logActivity(
    { ...db, admins: (db.admins ?? []).filter((a) => normalise(a) !== e) },
    'admin_removed',
    e,
  );
}
export const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

// --- persistence ------------------------------------------------------------

let cache: DB | null = null;
const listeners = new Set<() => void>();

function read(): DB {
  if (cache) return cache;
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    cache = raw ? { ...EMPTY, ...(JSON.parse(raw) as DB) } : seed();
  } catch {
    cache = seed();
  }
  return cache;
}

function write(next: DB): void {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* a full disk must never lose the ball being scored in memory */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useDB(): DB {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function useMutate(): (fn: (db: DB) => DB) => void {
  return useCallback((fn) => write(fn(structuredClone(read()))), []);
}

/** Replace the whole local mirror — used by the sync layer after a pull. */
export function replaceAll(next: DB): void {
  write(next);
}

/** The current local state, readable outside React. */
export function snapshot(): DB {
  return read();
}

export function resetAll(): void {
  cache = seed();
  write(cache);
}

/** A pool and two jerseys, so the app is usable the moment it opens. */
function seed(): DB {
  const names = [
    'Rahul', 'Kiran', 'Vinay', 'Suresh', 'Anil', 'Deepak', 'Arjun', 'Sameer',
    'Vikram', 'Naveen', 'Rohit', 'Manoj', 'Imran', 'Ravi', 'Ajay', 'Farhan',
  ];
  const db: DB = {
    ...EMPTY,
    players: names.map((name) => ({
      id: uid(),
      name,
      nickname: null,
      photo_url: null,
      batting_hand: null,
      bowling_style: null,
      is_active: true,
      deleted_at: null,
      created_at: now(),
      created_by: null,
    })),
    jerseys: [
      { id: uid(), name: 'BLR Bulls', short_name: 'BLR', colour_hex: '#ffb627', logo_url: null, deleted_at: null, created_at: now() },
      { id: uid(), name: 'ATX Kings', short_name: 'ATX', colour_hex: '#5ed3a3', logo_url: null, deleted_at: null, created_at: now() },
      { id: uid(), name: 'Turf Titans', short_name: 'TUR', colour_hex: '#ff5c45', logo_url: null, deleted_at: null, created_at: now() },
    ],
  };
  return db;
}

// --- R0: settings -----------------------------------------------------------

/** The single general row (R0) — seeded once, then stands alone. */
export function generalSettings(db: DB): RulesConfigOverride {
  const row = db.app_settings.find((s) => s.scope === 'general');
  return (row?.config as RulesConfigOverride) ?? {};
}

export function saveGeneralSettings(db: DB, config: RulesConfigOverride): DB {
  const rest = db.app_settings.filter((s) => s.scope !== 'general');
  return logActivity({
    ...db,
    app_settings: [
      ...rest,
      { id: uid(), scope: 'general', scope_id: null, config: config as never, updated_at: now() },
    ],
  }, 'settings_changed', 'general settings');
}

// --- players and jerseys ----------------------------------------------------

export function addPlayer(db: DB, name: string): DB {
  return logActivity({
    ...db,
    players: [
      ...db.players,
      {
        id: uid(),
        name: name.trim(),
        nickname: null,
        photo_url: null,
        batting_hand: null,
        bowling_style: null,
        is_active: true,
        deleted_at: null,
        created_at: now(),
        created_by: actor(),
      },
    ],
  }, 'player_added', name.trim());
}

/** R35a — soft delete once he has stats, hard delete if he never played. */
export function deletePlayer(db: DB, playerId: string): DB {
  const played = db.deliveries.some(
    (d) => d.striker_id === playerId || d.bowler_id === playerId || d.player_out_id === playerId,
  );
  const name = db.players.find((p) => p.id === playerId)?.name ?? playerId;
  if (played) {
    return logActivity(
      {
        ...db,
        players: db.players.map((p) => (p.id === playerId ? { ...p, deleted_at: now(), is_active: false } : p)),
      },
      'player_hidden',
      `${name} (has stats, kept for old scorecards)`,
    );
  }
  return logActivity(
    {
      ...db,
      players: db.players.filter((p) => p.id !== playerId),
      squad_players: db.squad_players.filter((sp) => sp.player_id !== playerId),
    },
    'player_deleted',
    name,
  );
}

export function addJersey(db: DB, name: string, colour: string): DB {
  return logActivity({
    ...db,
    jerseys: [
      ...db.jerseys,
      {
        id: uid(),
        name: name.trim(),
        short_name: name.trim().slice(0, 3).toUpperCase(),
        colour_hex: colour,
        logo_url: null,
        deleted_at: null,
        created_at: now(),
      },
    ],
  }, 'team_created', name.trim());
}

// --- series and squads (R1, R3b) -------------------------------------------

export function createSeries(
  db: DB,
  name: string,
  plannedMatches: number,
  rules: RulesConfigOverride,
  jerseyA: string,
  jerseyB: string,
  isTest = false,
): { db: DB; seriesId: string } {
  const seriesId = uid();
  const squadA: SquadRow = { id: uid(), series_id: seriesId, jersey_id: jerseyA, name_override: null, last_man_enabled: false, created_at: now() };
  const squadB: SquadRow = { id: uid(), series_id: seriesId, jersey_id: jerseyB, name_override: null, last_man_enabled: false, created_at: now() };
  return {
    seriesId,
    db: logActivity({
      ...db,
      series: [
        ...db.series,
        {
          id: seriesId,
          name: name.trim(),
          season: null,
          planned_matches: plannedMatches,
          status: 'setup',
          is_test: isTest,
          rules_config: rules as never,
          created_at: now(),
          closed_at: null,
          deleted_at: null,
        },
      ],
      squads: [...db.squads, squadA, squadB],
    }, 'series_created', `${name.trim()} — ${plannedMatches} matches${isTest ? ' (test)' : ''}`),
  };
}

/** R29 / decision 20 — increase only. */
export function extendSeries(db: DB, seriesId: string, planned: number): DB {
  const before = db.series.find((s) => s.id === seriesId)?.planned_matches ?? 0;
  const after = Math.max(before, planned);
  if (after === before) return db;
  return logActivity(
    {
      ...db,
      series: db.series.map((s) =>
        s.id === seriesId ? { ...s, planned_matches: after } : s,
      ),
    },
    'series_extended',
    `${db.series.find((s) => s.id === seriesId)?.name ?? ''}: ${before} to ${after} matches`,
  );
}

/** R39 — one player, one squad per series. Adding to the other side swaps him. */
export function addToSquad(db: DB, squadId: string, playerId: string): DB {
  const squad = db.squads.find((s) => s.id === squadId);
  if (!squad) return db;
  const cleared = db.squad_players.map((sp) =>
    sp.series_id === squad.series_id && sp.player_id === playerId && sp.removed_at === null
      ? { ...sp, removed_at: now() }
      : sp,
  );
  return logActivity({
    ...db,
    squad_players: [
      ...cleared,
      {
        id: uid(),
        squad_id: squadId,
        series_id: squad.series_id,
        player_id: playerId,
        added_at: now(),
        added_by: actor(),
        removed_at: null,
        is_captain: false,
        is_deadrunner_for: null,
      },
    ],
  }, 'squad_player_added', `${db.players.find((p) => p.id === playerId)?.name ?? playerId} to ${squadNameOf(db, squadId)}`);
}

function squadNameOf(db: DB, squadId: string): string {
  const squad = db.squads.find((s) => s.id === squadId);
  return squad?.name_override ?? db.jerseys.find((j) => j.id === squad?.jersey_id)?.name ?? 'squad';
}

/** R1a — removal keeps his stats; the row is never deleted. */
export function removeFromSquad(db: DB, squadId: string, playerId: string): DB {
  return logActivity(
    {
      ...db,
      squad_players: db.squad_players.map((sp) =>
        sp.squad_id === squadId && sp.player_id === playerId && sp.removed_at === null
          ? { ...sp, removed_at: now() }
          : sp,
      ),
    },
    'squad_player_removed',
    `${db.players.find((p) => p.id === playerId)?.name ?? playerId} from ${squadNameOf(db, squadId)}`,
  );
}

export function squadMembers(db: DB, squadId: string): PlayerRow[] {
  const ids = db.squad_players
    .filter((sp) => sp.squad_id === squadId && sp.removed_at === null)
    .map((sp) => sp.player_id);
  return ids
    .map((id) => db.players.find((p) => p.id === id))
    .filter((p): p is PlayerRow => p !== undefined);
}

export function squadName(db: DB, squadId: string | null): string {
  const squad = db.squads.find((s) => s.id === squadId);
  if (!squad) return '—';
  if (squad.name_override) return squad.name_override;
  return db.jerseys.find((j) => j.id === squad.jersey_id)?.name ?? '—';
}

export function squadCode(db: DB, squadId: string | null): string {
  const squad = db.squads.find((s) => s.id === squadId);
  const jersey = db.jerseys.find((j) => j.id === squad?.jersey_id);
  return jersey?.short_name ?? jersey?.name.slice(0, 3).toUpperCase() ?? '—';
}

export function playerName(db: DB, id: string | null | undefined): string {
  if (!id) return '—';
  return db.players.find((p) => p.id === id)?.name ?? '—';
}

// --- matches ----------------------------------------------------------------

export function createMatch(
  db: DB,
  seriesId: string,
  rulesOverride: RulesConfigOverride,
  venue: string,
): { db: DB; matchId: string } {
  const squads = db.squads.filter((s) => s.series_id === seriesId);
  const played = db.matches.filter((m) => m.series_id === seriesId).length;
  const matchId = uid();
  return {
    matchId,
    db: logActivity({
      ...db,
      matches: [
        ...db.matches,
        {
          id: matchId,
          series_id: seriesId,
          match_no: played + 1,
          match_date: now().slice(0, 10),
          venue: venue || null,
          squad_a_id: squads[0]?.id ?? null,
          squad_b_id: squads[1]?.id ?? null,
          overs: (rulesOverride.oversPerInnings as number) ?? 6,
          rules_override: rulesOverride as never,
          effective_rules: null,
          status: 'scheduled',
          toss_calling_squad_id: null,
          toss_call: null,
          toss_result: null,
          toss_winner_squad_id: null,
          toss_decision: null,
          tossed_at: null,
          result_text: null,
          winner_squad_id: null,
          scorer_id: null,
          created_at: now(),
        },
      ],
    }, 'match_created', `match ${played + 1} of ${db.series.find((s) => s.id === seriesId)?.name ?? ''}`),
  };
}

/**
 * R3 — the result is generated and stored the instant Spin is pressed, before
 * the animation ends, so closing the app cannot change it.
 */
export function recordSpin(
  db: DB,
  matchId: string,
  callingSquadId: string,
  result: 'heads' | 'tails',
): DB {
  return logActivity({
    ...db,
    matches: db.matches.map((m) =>
      m.id === matchId
        ? { ...m, toss_calling_squad_id: callingSquadId, toss_result: result, tossed_at: now() }
        : m,
    ),
  }, 'toss_spun', `${squadNameOf(db, callingSquadId)} spun — ${result}`);
}

/** The opposing captain calls while the coin is still in the air. */
export function recordCall(db: DB, matchId: string, call: 'heads' | 'tails'): DB {
  const match = db.matches.find((m) => m.id === matchId);
  if (!match || !match.toss_result || !match.toss_calling_squad_id) return db;
  const caller = match.toss_calling_squad_id;
  const other = match.squad_a_id === caller ? match.squad_b_id : match.squad_a_id;
  const winner = call === match.toss_result ? caller : other;
  return logActivity(
    {
      ...db,
      matches: db.matches.map((m) =>
        m.id === matchId ? { ...m, toss_call: call, toss_winner_squad_id: winner } : m,
      ),
    },
    'toss_called',
    `called ${call} — ${winner ? squadNameOf(db, winner) : 'nobody'} won the toss`,
  );
}

/** R3a — from match 2 on, the previous winner picks instead of tossing. */
export function recordWinnerChoice(db: DB, matchId: string, winnerSquadId: string): DB {
  return {
    ...db,
    matches: db.matches.map((m) =>
      m.id === matchId ? { ...m, toss_winner_squad_id: winnerSquadId, tossed_at: now() } : m,
    ),
  };
}

/** R24 — even out the wickets when one side is short. */
export function setLastMan(db: DB, squadId: string, on: boolean): DB {
  return logActivity(
    { ...db, squads: db.squads.map((s) => (s.id === squadId ? { ...s, last_man_enabled: on } : s)) },
    on ? 'last_man_enabled' : 'last_man_disabled',
    squadNameOf(db, squadId),
  );
}

/** R2 — the decision freezes the effective config and opens the match. */
export function recordDecision(
  db: DB,
  matchId: string,
  decision: 'bat' | 'bowl',
  effectiveRules: object,
): DB {
  const match = db.matches.find((m) => m.id === matchId);
  if (!match || !match.toss_winner_squad_id) return db;
  const winner = match.toss_winner_squad_id;
  const other = match.squad_a_id === winner ? match.squad_b_id : match.squad_a_id;
  const batting = decision === 'bat' ? winner : other;
  const bowling = decision === 'bat' ? other : winner;
  if (!batting || !bowling) return db;

  return logActivity({
    ...db,
    matches: db.matches.map((m) =>
      m.id === matchId
        ? { ...m, toss_decision: decision, effective_rules: effectiveRules as never, status: 'live' }
        : m,
    ),
    innings: [
      ...db.innings,
      {
        id: uid(),
        match_id: matchId,
        seq: 1,
        batting_squad_id: batting,
        bowling_squad_id: bowling,
        target: null,
        status: 'in_progress',
        end_reason: null,
        impact_over_number: null,
        last_man_active: false,
        deadrunner_id: null,
        created_at: now(),
      },
    ],
  }, 'toss_decision', `${squadNameOf(db, winner)} chose to ${decision} — rules frozen`);
}

/** R28 — the chase starts with a target of the first innings plus one. */
export function startSecondInnings(db: DB, matchId: string, firstInningsRuns: number): DB {
  const first = db.innings.find((i) => i.match_id === matchId && i.seq === 1);
  if (!first || db.innings.some((i) => i.match_id === matchId && i.seq === 2)) return db;
  return {
    ...db,
    innings: [
      ...db.innings.map((i) => (i.id === first.id ? { ...i, status: 'complete' as const } : i)),
      {
        id: uid(),
        match_id: matchId,
        seq: 2,
        batting_squad_id: first.bowling_squad_id,
        bowling_squad_id: first.batting_squad_id,
        target: firstInningsRuns + 1,
        status: 'in_progress',
        end_reason: null,
        impact_over_number: null,
        last_man_active: false,
        deadrunner_id: null,
        created_at: now(),
      },
    ],
  };
}

/** Only a test series may be deleted; a real one is permanent. */
export function isTestSeries(db: DB, seriesId: string | null | undefined): boolean {
  return db.series.find((s) => s.id === seriesId)?.is_test === true;
}

export function matchIsDeletable(db: DB, matchId: string): boolean {
  const match = db.matches.find((m) => m.id === matchId);
  return match ? isTestSeries(db, match.series_id) : false;
}

/**
 * Delete a test match outright — the innings, every ball, every event. This
 * exists so trying the app out does not leave debris in the real record. A
 * match in a real series cannot be deleted at all.
 */
export function deleteMatch(db: DB, matchId: string): DB {
  if (!matchIsDeletable(db, matchId)) return db;
  const inningsIds = db.innings.filter((i) => i.match_id === matchId).map((i) => i.id);
  const label = `match ${db.matches.find((m) => m.id === matchId)?.match_no ?? ''}`;
  return logActivity(
    {
      ...db,
      matches: db.matches.filter((m) => m.id !== matchId),
      innings: db.innings.filter((i) => i.match_id !== matchId),
      deliveries: db.deliveries.filter((d) => !inningsIds.includes(d.innings_id)),
      match_events: db.match_events.filter((e) => e.match_id !== matchId),
    },
    'test_match_deleted',
    label,
  );
}

/** Delete a test series and everything under it. Permanent, by design. */
export function deleteSeries(db: DB, seriesId: string): DB {
  if (!isTestSeries(db, seriesId)) return db;
  const matchIds = db.matches.filter((m) => m.series_id === seriesId).map((m) => m.id);
  const inningsIds = db.innings.filter((i) => matchIds.includes(i.match_id)).map((i) => i.id);
  const name = db.series.find((s) => s.id === seriesId)?.name ?? '';
  return logActivity(
    {
      ...db,
      series: db.series.filter((s) => s.id !== seriesId),
      squads: db.squads.filter((q) => q.series_id !== seriesId),
      squad_players: db.squad_players.filter((sp) => sp.series_id !== seriesId),
      matches: db.matches.filter((m) => m.series_id !== seriesId),
      innings: db.innings.filter((i) => !inningsIds.includes(i.id)),
      deliveries: db.deliveries.filter((d) => !inningsIds.includes(d.innings_id)),
      match_events: db.match_events.filter((e) => !matchIds.includes(e.match_id)),
    },
    'test_series_deleted',
    name,
  );
}

/** Clear out every test series at once, to start a clean season. */
export function deleteAllTestSeries(db: DB): DB {
  let next = db;
  for (const s of db.series.filter((x) => x.is_test)) next = deleteSeries(next, s.id);
  return next;
}

// --- renaming (admin only; the UI is what gates it) -------------------------

export function renamePlayer(db: DB, playerId: string, name: string): DB {
  const from = db.players.find((p) => p.id === playerId)?.name ?? '';
  return logActivity(
    { ...db, players: db.players.map((p) => (p.id === playerId ? { ...p, name: name.trim() } : p)) },
    'player_renamed',
    `${from} to ${name.trim()}`,
  );
}

export function renameJersey(db: DB, jerseyId: string, name: string): DB {
  const from = db.jerseys.find((j) => j.id === jerseyId)?.name ?? '';
  return logActivity(
    {
      ...db,
      jerseys: db.jerseys.map((j) =>
        j.id === jerseyId
          ? { ...j, name: name.trim(), short_name: name.trim().slice(0, 3).toUpperCase() }
          : j,
      ),
    },
    'team_renamed',
    `${from} to ${name.trim()}`,
  );
}

export function renameSeries(db: DB, seriesId: string, name: string): DB {
  const from = db.series.find((s) => s.id === seriesId)?.name ?? '';
  return logActivity(
    { ...db, series: db.series.map((s) => (s.id === seriesId ? { ...s, name: name.trim() } : s)) },
    'series_renamed',
    `${from} to ${name.trim()}`,
  );
}

/**
 * Abandon a real match: rained off, ran out of light, never finished. It keeps
 * its place and its balls — the record of a weekend is not edited, only
 * annotated — but it stops counting as live or as a result.
 */
export function abandonMatch(db: DB, matchId: string): DB {
  return logActivity(
    {
      ...db,
      matches: db.matches.map((m) =>
        m.id === matchId ? { ...m, status: 'abandoned', result_text: 'Abandoned' } : m,
      ),
    },
    'match_abandoned',
    `match ${db.matches.find((m) => m.id === matchId)?.match_no ?? ''}`,
  );
}

export function completeMatch(db: DB, matchId: string, winnerSquadId: string | null, text: string): DB {
  return logActivity(
    {
      ...db,
      matches: db.matches.map((m) =>
        m.id === matchId ? { ...m, status: 'completed', winner_squad_id: winnerSquadId, result_text: text } : m,
      ),
    },
    'match_completed',
    text,
  );
}

// --- the event log ----------------------------------------------------------

/** The next sequence number in an innings — deliveries and events share it. */
export function nextSeq(db: DB, inningsId: string): number {
  const a = db.deliveries.filter((d) => d.innings_id === inningsId).map((d) => d.seq);
  const b = db.match_events.filter((e) => e.innings_id === inningsId).map((e) => e.seq ?? 0);
  return Math.max(0, ...a, ...b) + 1;
}

export function appendDelivery(db: DB, row: DeliveryRow): DB {
  // Idempotent by primary key, exactly like the real insert (§4).
  if (db.deliveries.some((d) => d.id === row.id)) return db;
  return { ...db, deliveries: [...db.deliveries, { ...row, created_by: row.created_by ?? actor() }] };
}

/** R7d — undo voids, never deletes. */
export function voidLastBall(db: DB, inningsId: string): DB {
  const live = db.deliveries
    .filter((d) => d.innings_id === inningsId && !d.is_voided)
    .sort((a, b) => a.seq - b.seq);
  const last = live[live.length - 1];
  if (!last) return db;
  return logActivity(
    {
      ...db,
      deliveries: db.deliveries.map((d) => (d.id === last.id ? { ...d, is_voided: true } : d)),
    },
    'ball_voided',
    `over ${last.over_no}.${last.ball_no}, ${last.team_runs} run${last.team_runs === 1 ? '' : 's'}`,
  );
}

export function appendEvent(
  db: DB,
  matchId: string,
  inningsId: string | null,
  type: MatchEventType,
  payload: object,
): DB {
  return {
    ...db,
    match_events: [
      ...db.match_events,
      {
        id: uid(),
        match_id: matchId,
        innings_id: inningsId,
        seq: inningsId ? nextSeq(db, inningsId) : null,
        type,
        payload: payload as never,
        created_at: now(),
        created_by: actor(),
      },
    ],
  };
}
