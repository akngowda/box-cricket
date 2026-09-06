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

/**
 * Clear this device completely. Not a reseed: starting fresh means an empty
 * pool, ready for the real names. The demo pool only appears on a browser
 * that has never opened the app.
 *
 * Clear the database first (supabase/reset-data.sql), or the next sync simply
 * pulls everything back down.
 */
export function resetAll(): void {
  cache = { ...EMPTY };
  write(cache);
  try {
    // Otherwise the next sync would treat the freshly pulled rows as deletions.
    window.localStorage.removeItem('box-cricket.synced');
  } catch {
    /* ignore */
  }
}

/**
 * A device with nothing on it starts empty.
 *
 * There used to be a demo pool here — sixteen invented players and three
 * invented teams — from before there was a database. It made a fresh device
 * look alive, but once syncing existed it did real damage: clearing a device
 * recreated the fake pool, and the next sync pushed it into the scorebook. A
 * clean database would refill itself with strangers. Real names come from the
 * pool screen, or down from the scorebook.
 */
function seed(): DB {
  return { ...EMPTY };
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

/**
 * Is this name already taken?
 *
 * Two players called the same thing is not a cosmetic problem: every picker in
 * the app shows names, so the scorer cannot tell which one he is choosing, and
 * a wicket gets credited to the wrong man.
 */
export function playerNameTaken(db: DB, name: string, exceptId?: string): boolean {
  const wanted = name.trim().toLowerCase();
  return db.players.some(
    (p) => p.id !== exceptId && p.deleted_at === null && p.name.trim().toLowerCase() === wanted,
  );
}

export function addPlayer(db: DB, name: string): DB {
  if (name.trim() === '' || playerNameTaken(db, name)) return db;
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
        short_name: null,
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

/** Repair or change which team a squad wears. */
export function setSquadJersey(db: DB, squadId: string, jerseyId: string): DB {
  return logActivity(
    { ...db, squads: db.squads.map((q) => (q.id === squadId ? { ...q, jersey_id: jerseyId } : q)) },
    'squad_team_set',
    db.jerseys.find((j) => j.id === jerseyId)?.name ?? jerseyId,
  );
}

export function squadMembers(db: DB, squadId: string): PlayerRow[] {
  const ids = db.squad_players
    .filter((sp) => sp.squad_id === squadId && sp.removed_at === null)
    .map((sp) => sp.player_id);
  return ids
    .map((id) => db.players.find((p) => p.id === id))
    .filter((p): p is PlayerRow => p !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function squadName(db: DB, squadId: string | null): string {
  const squad = db.squads.find((s) => s.id === squadId);
  if (!squad) return '—';
  if (squad.name_override) return squad.name_override;
  // A squad whose team is missing says so, rather than showing a bare dash.
  return db.jerseys.find((j) => j.id === squad.jersey_id)?.name ?? 'No team set';
}

/**
 * A short code for a team, for the places a full name will not fit.
 *
 * Chopping the first three letters gave "Team Akarsh" -> "TEA", which tells
 * you nothing and reads like a typo. Multi-word names become initials, and a
 * single word keeps its first three letters.
 */
export function squadCode(db: DB, squadId: string | null): string {
  const squad = db.squads.find((s) => s.id === squadId);
  const jersey = db.jerseys.find((j) => j.id === squad?.jersey_id);
  if (!jersey) return '—';

  const words = jersey.name.trim().split(/\s+/).filter(Boolean);
  // "Team X" is really just X — the word "team" carries no information.
  const meaningful = words.filter((w) => w.toLowerCase() !== 'team');
  const parts = meaningful.length > 0 ? meaningful : words;

  if (parts.length > 1) return parts.map((w) => w[0] ?? '').join('').toUpperCase().slice(0, 4);
  return (parts[0] ?? jersey.name).slice(0, 3).toUpperCase();
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

  // toss_calling_squad_id holds the side that SPINS the coin. The other side
  // calls it, so the call belongs to them — and a correct call wins them the
  // toss. This was the wrong way round: a correct call handed the toss to the
  // spinner, so the side that called right lost it.
  const spinner = match.toss_calling_squad_id;
  const callingSide = match.squad_a_id === spinner ? match.squad_b_id : match.squad_a_id;
  const winner = call === match.toss_result ? callingSide : spinner;
  return logActivity(
    {
      ...db,
      matches: db.matches.map((m) =>
        m.id === matchId ? { ...m, toss_call: call, toss_winner_squad_id: winner } : m,
      ),
    },
    'toss_called',
    `${squadNameOf(db, callingSide ?? '')} called ${call}, it was ${match.toss_result} — ${
      winner ? squadNameOf(db, winner) : 'nobody'
    } won the toss`,
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

/**
 * Test series are private to admins.
 *
 * Trying the app out should not put a fake scoreline in front of the group, so
 * anything marked as a test is filtered out of every public screen. Admins see
 * everything, with the series badged as a test.
 */
export function visibleSeries(db: DB, isAdmin: boolean): DB['series'] {
  return db.series.filter((s) => s.deleted_at === null && (isAdmin || !s.is_test));
}

export function visibleMatches(db: DB, isAdmin: boolean): DB['matches'] {
  const allowed = new Set(visibleSeries(db, isAdmin).map((s) => s.id));
  return db.matches.filter((m) => allowed.has(m.series_id));
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

/**
 * Mark an existing series as a test — or take the mark off.
 *
 * Series created before the flag existed count as real, so this is the way to
 * dispose of practice data without a trip to the SQL editor. Marking a series
 * as a test is itself logged, because it is what makes deleting it possible.
 */
export function setSeriesIsTest(db: DB, seriesId: string, isTest: boolean): DB {
  const name = db.series.find((s) => s.id === seriesId)?.name ?? '';
  return logActivity(
    { ...db, series: db.series.map((s) => (s.id === seriesId ? { ...s, is_test: isTest } : s)) },
    isTest ? 'series_marked_test' : 'series_marked_real',
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
  if (name.trim() === '' || playerNameTaken(db, name, playerId)) return db;
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

/**
 * Step back out of a chase that should not have started yet.
 *
 * Closing an innings is a decision like any other, and it is usually where a
 * wrong total gets noticed. If the second innings has not been scored on, this
 * takes it away and re-opens the first, so undo can carry on back through its
 * balls. Once the chase has begun it stays — those balls are real.
 */
export function reopenPreviousInnings(db: DB, matchId: string): DB {
  const second = db.innings.find((i) => i.match_id === matchId && i.seq === 2);
  const first = db.innings.find((i) => i.match_id === matchId && i.seq === 1);
  if (!second || !first) return db;
  if (db.deliveries.some((d) => d.innings_id === second.id && !d.is_voided)) return db;

  return logActivity(
    {
      ...db,
      innings: db.innings
        .filter((i) => i.id !== second.id)
        .map((i) => (i.id === first.id ? { ...i, status: 'in_progress' as const, end_reason: null } : i)),
      deliveries: db.deliveries.filter((d) => d.innings_id !== second.id),
      match_events: db.match_events.filter((e) => e.innings_id !== second.id),
      matches: db.matches.map((m) =>
        m.id === matchId ? { ...m, status: 'live' as const, result_text: null, winner_squad_id: null } : m,
      ),
    },
    'innings_reopened',
    'went back into the first innings',
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

/**
 * R7d — undo voids the last ball, and takes back what was decided after it.
 *
 * A bowler change, an impact-over declaration and the like are instructions
 * recorded at a point in the log. Undoing a ball but leaving them in place was
 * wrong: the bowler you picked for the NEXT over stayed picked, so he became
 * the bowler of the re-scored ball, and was then resting when his over came
 * round. Stepping back past an instruction has to take the instruction with
 * it. The ball itself is only marked voided — nothing is erased.
 */
export function voidLastBall(db: DB, inningsId: string): DB {
  const live = db.deliveries
    .filter((d) => d.innings_id === inningsId && !d.is_voided)
    .sort((a, b) => a.seq - b.seq);
  const last = live[live.length - 1];
  if (!last) return db;

  // Instructions made after this ball no longer describe where we are.
  const undone = db.match_events.filter(
    (e) =>
      e.innings_id === inningsId &&
      e.seq !== null &&
      e.seq > last.seq &&
      e.type !== 'innings_start',
  );

  return logActivity(
    {
      ...db,
      deliveries: db.deliveries.map((d) => (d.id === last.id ? { ...d, is_voided: true } : d)),
      match_events: db.match_events.filter((e) => !undone.some((u) => u.id === e.id)),
    },
    'ball_voided',
    `over ${last.over_no}.${last.ball_no}, ${last.team_runs} run${last.team_runs === 1 ? '' : 's'}` +
      (undone.length > 0 ? ` (and ${undone.length} later change${undone.length === 1 ? '' : 's'})` : ''),
  );
}

/**
 * Void or restore any ball, not only the last one.
 *
 * Mistakes surface an over later, when the scorer looks up and the total is
 * wrong. The log is append-only, so nothing is erased: the ball is marked
 * voided and the innings replays without it, and un-voiding puts it back.
 * Everything downstream — the bowler's figures, who faced what — is re-derived
 * from the log, so the correction lands on the right players by itself.
 */
export function setBallVoided(db: DB, deliveryId: string, voided: boolean): DB {
  const ball = db.deliveries.find((d) => d.id === deliveryId);
  if (!ball) return db;
  return logActivity(
    {
      ...db,
      deliveries: db.deliveries.map((d) => (d.id === deliveryId ? { ...d, is_voided: voided } : d)),
    },
    voided ? 'ball_voided' : 'ball_restored',
    `over ${ball.over_no}.${ball.ball_no}, ${ball.team_runs} run${ball.team_runs === 1 ? '' : 's'}`,
  );
}

/**
 * Change what a ball was worth, in place.
 *
 * Safer than voiding and re-scoring, because the ball keeps its position in
 * the over, so the same bowler and the same batsman keep it. Only the runs
 * change. Everything after is replayed, so if the correction changes the
 * strike — an odd number of runs where there had been none — the rest of the
 * innings re-derives accordingly, which is the honest answer.
 */
export function amendBall(
  db: DB,
  deliveryId: string,
  patch: { declared_runs: number; contact: 'pitched' | 'direct' | 'none'; physical_runs: number },
): DB {
  const ball = db.deliveries.find((d) => d.id === deliveryId);
  if (!ball) return db;
  return logActivity(
    {
      ...db,
      deliveries: db.deliveries.map((d) =>
        d.id === deliveryId
          ? {
              ...d,
              declared_runs: patch.declared_runs,
              contact: patch.contact,
              physical_runs: patch.physical_runs,
              // The stored totals are recomputed on replay; keep the row
              // honest in the meantime.
              zone: patch.declared_runs === 0 ? 0 : d.zone,
            }
          : d,
      ),
    },
    'ball_amended',
    `over ${ball.over_no}.${ball.ball_no}`,
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
