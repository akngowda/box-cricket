/**
 * Database types, matching supabase/migrations/0001_init.sql column for column.
 *
 * Hand-written for now. Once the Supabase CLI is set up (02-ARCHITECTURE §9),
 * regenerate with:
 *
 *   supabase gen types typescript --local > src/db/database.types.ts
 *
 * and delete this note. src/db/schema.test.ts runs the migrations for real, so
 * a drift between these types and the SQL shows up as a failing test there.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Role = 'admin' | 'scorer';
export type SeriesStatus = 'setup' | 'in_progress' | 'completed';
export type MatchStatus = 'scheduled' | 'live' | 'completed' | 'abandoned';
export type InningsStatus = 'in_progress' | 'complete';
export type EndReason = 'overs_complete' | 'all_out' | 'target_reached';
export type TossSide = 'heads' | 'tails';
export type TossDecision = 'bat' | 'bowl';
export type MatchEventType =
  | 'squad_player_added'
  | 'squad_player_removed'
  | 'squad_player_swapped'
  | 'impact_over_declared'
  | 'impact_over_undone'
  | 'last_man_activated'
  | 'deadrunner_set'
  | 'strike_switched_manually'
  | 'bowler_selected'
  | 'bowler_replaced_midover'
  | 'retired_out'
  | 'retired_hurt'
  | 'retired_hurt_returned'
  | 'ball_voided'
  | 'innings_start'
  | 'innings_end'
  | 'match_end';

export interface ProfileRow {
  id: string;
  email: string | null;
  role: Role;
  display_name: string | null;
  created_at: string;
}

export interface PlayerRow {
  id: string;
  name: string;
  nickname: string | null;
  photo_url: string | null;
  batting_hand: 'left' | 'right' | null;
  bowling_style: string | null;
  is_active: boolean;
  /** R35a — soft delete; stats stay attributed. */
  deleted_at: string | null;
  created_at: string;
  created_by: string | null;
}

export interface JerseyRow {
  id: string;
  name: string;
  short_name: string | null;
  colour_hex: string | null;
  logo_url: string | null;
  deleted_at: string | null;
  created_at: string;
}

export interface SeriesRow {
  id: string;
  name: string;
  season: string | null;
  planned_matches: number;
  status: SeriesStatus;
  /** R0 — the series level of the cascade, shaped like RulesConfig. */
  rules_config: Json;
  created_at: string;
  closed_at: string | null;
  deleted_at: string | null;
}

export interface SquadRow {
  id: string;
  series_id: string;
  jersey_id: string;
  name_override: string | null;
  last_man_enabled: boolean;
  created_at: string;
}

export interface SquadPlayerRow {
  id: string;
  squad_id: string;
  series_id: string;
  player_id: string;
  added_at: string;
  added_by: string | null;
  /** R1a — set instead of deleting the row, so his stats survive. */
  removed_at: string | null;
  is_captain: boolean;
  is_deadrunner_for: string | null;
}

export interface MatchRow {
  id: string;
  series_id: string;
  match_no: number;
  match_date: string | null;
  venue: string | null;
  /** Nullable so a knockout bracket can fill them later (§4). */
  squad_a_id: string | null;
  squad_b_id: string | null;
  overs: number;
  rules_override: Json;
  /** R2 — frozen at the toss; null before it. */
  effective_rules: Json | null;
  status: MatchStatus;
  toss_calling_squad_id: string | null;
  toss_call: TossSide | null;
  toss_result: TossSide | null;
  toss_winner_squad_id: string | null;
  toss_decision: TossDecision | null;
  tossed_at: string | null;
  result_text: string | null;
  winner_squad_id: string | null;
  scorer_id: string | null;
  created_at: string;
}

export interface InningsRow {
  id: string;
  match_id: string;
  seq: 1 | 2;
  batting_squad_id: string;
  bowling_squad_id: string;
  target: number | null;
  status: InningsStatus;
  end_reason: EndReason | null;
  impact_over_number: number | null;
  last_man_active: boolean;
  deadrunner_id: string | null;
  created_at: string;
}

/** The event log. Append only (§4). */
export interface DeliveryRow {
  /** Client-generated UUID — the idempotency key. */
  id: string;
  innings_id: string;
  seq: number;
  over_no: number;
  ball_no: number;
  bowler_id: string;
  striker_id: string;
  non_striker_id: string | null;
  zone: number | null;
  contact: 'pitched' | 'direct' | 'none';
  declared_runs: number;
  physical_runs: number;
  extra_type: 'none' | 'wide' | 'noball';
  is_body_hit: boolean;
  is_roof_hit: boolean;
  is_free_hit: boolean;
  impact_over: boolean;
  impact_ball: boolean;
  wicket_type:
    | 'bowled'
    | 'caught'
    | 'runout'
    | 'stumped'
    | 'dotout'
    | 'bodyout'
    | 'retired_out'
    | 'retired_hurt'
    | null;
  player_out_id: string | null;
  fielder_id: string | null;
  /** Denormalised — always recomputable by replaying through the engine. */
  team_runs: number;
  batsman_runs: number;
  bowler_conceded: number;
  is_voided: boolean;
  created_at: string;
  created_by: string | null;
}

export interface MatchEventRow {
  id: string;
  match_id: string;
  innings_id: string | null;
  seq: number | null;
  type: MatchEventType;
  payload: Json;
  created_at: string;
  created_by: string | null;
}

export interface InningsSnapshotRow {
  innings_id: string;
  runs: number;
  wickets: number;
  balls: number;
  state: Json;
  updated_at: string;
}

export interface AppSettingsRow {
  id: string;
  scope: 'general' | 'series' | 'match';
  scope_id: string | null;
  config: Json;
  updated_at: string;
}

/** Columns the client supplies on insert; the rest have defaults. */
export type DeliveryInsert = Omit<DeliveryRow, 'created_at' | 'is_voided'> &
  Partial<Pick<DeliveryRow, 'is_voided'>>;

export interface Database {
  public: {
    Tables: {
      profiles: { Row: ProfileRow; Insert: Partial<ProfileRow> & { id: string }; Update: Partial<ProfileRow> };
      players: { Row: PlayerRow; Insert: Partial<PlayerRow> & { name: string }; Update: Partial<PlayerRow> };
      jerseys: { Row: JerseyRow; Insert: Partial<JerseyRow> & { name: string }; Update: Partial<JerseyRow> };
      series: { Row: SeriesRow; Insert: Partial<SeriesRow> & { name: string }; Update: Partial<SeriesRow> };
      squads: {
        Row: SquadRow;
        Insert: Partial<SquadRow> & { series_id: string; jersey_id: string };
        Update: Partial<SquadRow>;
      };
      squad_players: {
        Row: SquadPlayerRow;
        // series_id is filled by a trigger from squads; callers may omit it.
        Insert: Partial<SquadPlayerRow> & { squad_id: string; player_id: string };
        Update: Partial<SquadPlayerRow>;
      };
      matches: {
        Row: MatchRow;
        Insert: Partial<MatchRow> & { series_id: string; match_no: number };
        Update: Partial<MatchRow>;
      };
      innings: {
        Row: InningsRow;
        Insert: Partial<InningsRow> & {
          match_id: string;
          seq: 1 | 2;
          batting_squad_id: string;
          bowling_squad_id: string;
        };
        Update: Partial<InningsRow>;
      };
      deliveries: {
        Row: DeliveryRow;
        Insert: DeliveryInsert;
        /** Only is_voided may change — the append-only trigger enforces it. */
        Update: Pick<DeliveryRow, 'is_voided'>;
      };
      match_events: {
        Row: MatchEventRow;
        Insert: Partial<MatchEventRow> & { match_id: string; type: MatchEventType };
        Update: Partial<MatchEventRow>;
      };
      innings_snapshot: {
        Row: InningsSnapshotRow;
        Insert: Partial<InningsSnapshotRow> & { innings_id: string };
        Update: Partial<InningsSnapshotRow>;
      };
      app_settings: {
        Row: AppSettingsRow;
        Insert: Partial<AppSettingsRow> & { scope: 'general' | 'series' | 'match' };
        Update: Partial<AppSettingsRow>;
      };
    };
    Views: Record<string, never>;
    Functions: {
      auth_role: { Args: Record<string, never>; Returns: Role | null };
      is_admin: { Args: Record<string, never>; Returns: boolean };
      is_staff: { Args: Record<string, never>; Returns: boolean };
      can_score_match: { Args: { p_match: string }; Returns: boolean };
      can_score_innings: { Args: { p_innings: string }; Returns: boolean };
    };
    Enums: Record<string, never>;
  };
}
