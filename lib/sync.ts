'use client';

/**
 * Sync — local first, Supabase behind it.
 *
 * The pad never waits for the network. It scores into the local mirror, the UI
 * updates in the same tick, and this module pushes to Supabase afterwards and
 * pulls back what other devices have done. That is the offline-first flow the
 * architecture asks for: bad signal on the turf must never cost you a ball.
 *
 * Conflicts barely exist here because the delivery log is append-only and every
 * row carries a client-generated UUID, so pushing twice is a no-op.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import { isRemote, supabase } from './supabase';
import { replaceAll, snapshot, type DB } from './store';

/** Local-only keys: admins come from profiles, activity from audit_log. */
const TABLES = [
  'players',
  'jerseys',
  'series',
  'squads',
  'squad_players',
  'matches',
  'innings',
  'deliveries',
  'match_events',
] as const;

type TableName = (typeof TABLES)[number];

export interface SyncStatus {
  state: 'off' | 'syncing' | 'synced' | 'offline' | 'error';
  pending: number;
  message?: string;
  at?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The local store stamps created_by with an email, because offline there is no
 * user id to hand. The database wants a profiles UUID, so anything that is not
 * one is dropped rather than sent and rejected.
 */
function sanitise<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const key of ['created_by', 'added_by', 'is_deadrunner_for']) {
    const v = out[key];
    if (typeof v === 'string' && !UUID.test(v)) out[key] = null;
  }
  return out as T;
}

/** Every row this device holds that the server has not acknowledged. */
export function pendingCount(local: DB, remote: Partial<Record<TableName, unknown[]>>): number {
  let n = 0;
  for (const t of TABLES) {
    const localRows = (local[t] ?? []) as Array<{ id: string }>;
    const remoteIds = new Set(((remote[t] ?? []) as Array<{ id: string }>).map((r) => r.id));
    n += localRows.filter((r) => !remoteIds.has(r.id)).length;
  }
  return n;
}

async function pull(): Promise<Partial<Record<TableName, unknown[]>>> {
  const client = supabase();
  const out: Partial<Record<TableName, unknown[]>> = {};
  for (const t of TABLES) {
    const { data, error } = await client.from(t).select('*');
    if (error) throw new Error(`${t}: ${error.message}`);
    out[t] = data ?? [];
  }
  return out;
}

/**
 * Push whatever the server has not seen. Rejections are expected and fine —
 * a viewer has no write rights — so they are reported, never thrown away
 * silently and never allowed to lose the local row.
 */
async function push(
  local: DB,
  remote: Partial<Record<TableName, unknown[]>>,
): Promise<string[]> {
  const client = supabase();
  const problems: string[] = [];

  for (const t of TABLES) {
    const remoteIds = new Set(((remote[t] ?? []) as Array<{ id: string }>).map((r) => r.id));
    const rows = ((local[t] ?? []) as unknown as Array<Record<string, unknown>>)
      .filter((r) => typeof r.id === 'string' && !remoteIds.has(r.id as string))
      .map(sanitise);
    if (rows.length === 0) continue;

    const { error } = await client.from(t).upsert(rows as never, { onConflict: 'id' });
    if (error) problems.push(`${t}: ${error.message}`);
  }
  return problems;
}

/**
 * One round trip: push what is ours, pull everything, and keep any local row
 * the server refused so it can go again next time.
 */
export async function syncNow(): Promise<SyncStatus> {
  if (!isRemote) return { state: 'off', pending: 0 };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const local = snapshot();
    return { state: 'offline', pending: local.deliveries.length ? 0 : 0 };
  }

  try {
    const local = snapshot();
    const before = await pull();
    const problems = await push(local, before);
    const after = await pull();

    // Server rows win where both exist; local-only rows survive so a refused
    // or not-yet-pushed ball is never dropped on the floor.
    const merged: DB = { ...local };
    for (const t of TABLES) {
      const serverRows = (after[t] ?? []) as Array<{ id: string }>;
      const serverIds = new Set(serverRows.map((r) => r.id));
      const localOnly = ((local[t] ?? []) as Array<{ id: string }>).filter(
        (r) => !serverIds.has(r.id),
      );
      (merged as unknown as Record<string, unknown[]>)[t] = [...serverRows, ...localOnly];
    }
    replaceAll(merged);

    const pending = pendingCount(merged, after);
    return problems.length > 0
      ? { state: 'error', pending, message: problems[0] ?? 'sync failed', at: Date.now() }
      : { state: 'synced', pending, at: Date.now() };
  } catch (err) {
    return { state: 'error', pending: 0, message: (err as Error).message, at: Date.now() };
  }
}

/**
 * Live updates. A viewer watching the shared link sees the score move without
 * refreshing, because every insert into deliveries pokes this channel.
 */
export function subscribeToChanges(onChange: () => void): () => void {
  if (!isRemote) return () => {};
  const client = supabase();
  const channel: RealtimeChannel = client
    .channel('box-cricket')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'match_events' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'innings' }, onChange)
    .subscribe();

  return () => {
    void client.removeChannel(channel);
  };
}
