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
 * What this device has already seen in the database.
 *
 * Without this, sync cannot tell "never uploaded" from "deleted by someone
 * else", so it treats a remote deletion as a missing row and pushes it back —
 * which made clearing the database impossible while the app was open. A row
 * that WAS on the server and no longer is has been deleted, and goes here too.
 */
const KNOWN_KEY = 'box-cricket.synced';

export type Known = Partial<Record<TableName, string[]>>;

function loadKnown(): Known {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(KNOWN_KEY) ?? '{}') as Known;
  } catch {
    return {};
  }
}

function saveKnown(known: Known): void {
  try {
    window.localStorage.setItem(KNOWN_KEY, JSON.stringify(known));
  } catch {
    /* not worth failing a sync over */
  }
}

/** Forget everything; used when the device is cleared. */
export function forgetSyncHistory(): void {
  try {
    window.localStorage.removeItem(KNOWN_KEY);
  } catch {
    /* ignore */
  }
}

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

/**
 * Turn a database error into something a scorer can act on. Nobody standing on
 * a turf box needs a table name or a Postgres code — they need to know whether
 * to sign in, wait, or call someone.
 */
function readable(message: string): string {
  if (/row-level security|permission denied|jwt|not authenticated/i.test(message)) {
    return 'You are not signed in, so nothing can be saved to the scorebook yet.';
  }
  if (/duplicate key|already exists/i.test(message)) {
    return 'Some of this was already saved. Nothing is lost.';
  }
  if (/network|fetch|timeout|failed to fetch/i.test(message)) {
    return 'Cannot reach the scorebook right now. Still trying.';
  }
  return 'The scorebook refused the last save. Still trying.';
}

async function pull(): Promise<Partial<Record<TableName, unknown[]>>> {
  const client = supabase();
  const out: Partial<Record<TableName, unknown[]>> = {};
  for (const t of TABLES) {
    const { data, error } = await client.from(t).select('*');
    if (error) throw new Error(readable(error.message));
    out[t] = data ?? [];
  }
  return out;
}

export interface PushResult {
  problems: string[];
  /** Tables the server would not accept, so local must stay authoritative. */
  failed: Set<TableName>;
}

/**
 * Push local state up.
 *
 * Two different jobs, because the log is not like the rest:
 *
 *  - Ordinary rows (players, squads, matches, innings...) are upserted whole.
 *    Sending only new ids was a bug: marking an innings complete edits an
 *    existing row, the server never heard, and the next pull undid it.
 *
 *  - Deliveries are append-only and the database enforces it with a trigger.
 *    Re-sending a stored ball is rejected — created_by and created_at never
 *    match exactly — and because an upsert is one statement, that rejection
 *    took the NEW balls in the same batch down with it. So a scored ball
 *    stopped reaching the database at all. Here they are inserted once, and
 *    the only later change ever sent is a void.
 */
async function push(
  local: DB,
  remote: Partial<Record<TableName, unknown[]>>,
): Promise<PushResult> {
  const client = supabase();
  const problems: string[] = [];
  const failed = new Set<TableName>();

  for (const t of TABLES) {
    const localRows = ((local[t] ?? []) as unknown as Array<Record<string, unknown>>).filter(
      (r) => typeof r.id === 'string',
    );
    if (localRows.length === 0) continue;

    if (t === 'deliveries') {
      const stored = new Map(
        ((remote[t] ?? []) as Array<{ id: string; is_voided?: boolean }>).map((r) => [r.id, r]),
      );

      const fresh = localRows.filter((r) => !stored.has(r.id as string)).map(sanitise);
      if (fresh.length > 0) {
        const { error } = await client.from(t).insert(fresh as never);
        if (error) {
          problems.push(readable(error.message));
          failed.add(t);
        }
      }

      // R7d — a void is the one edit a ball is allowed.
      const toVoid = localRows.filter(
        (r) => r.is_voided === true && stored.get(r.id as string)?.is_voided === false,
      );
      for (const row of toVoid) {
        const { error } = await client
          .from(t)
          .update({ is_voided: true } as never)
          .eq('id', row.id as string);
        if (error) {
          problems.push(readable(error.message));
          failed.add(t);
        }
      }
      continue;
    }

    const { error } = await client.from(t).upsert(localRows.map(sanitise) as never, {
      onConflict: 'id',
    });
    if (error) {
      problems.push(readable(error.message));
      failed.add(t);
    }
  }
  return { problems, failed };
}

/**
 * Combine the two sides.
 *
 * Where the push succeeded the server is authoritative and any local-only row
 * is kept so it can go again. Where the push was refused — a viewer with no
 * write rights, or an expired session — the local rows win outright, because
 * otherwise the pull would silently roll back work the scorer can see.
 */
export function mergeTables(
  local: DB,
  server: Partial<Record<TableName, unknown[]>>,
  failed: Set<TableName>,
  known: Known = {},
): { db: DB; known: Known } {
  const merged: DB = { ...local };
  const nextKnown: Known = { ...known };

  for (const t of TABLES) {
    const serverRows = (server[t] ?? []) as Array<{ id: string }>;
    const localRows = (local[t] ?? []) as unknown as Array<{ id: string }>;
    const serverIds = new Set(serverRows.map((r) => r.id));
    const seenBefore = new Set(known[t] ?? []);

    // Anything this device knew was stored, and is now gone from the server,
    // was deleted there. Drop it rather than helpfully putting it back.
    const deletedRemotely = (id: string): boolean => seenBefore.has(id) && !serverIds.has(id);

    if (failed.has(t)) {
      const kept = localRows.filter((r) => !deletedRemotely(r.id));
      const localIds = new Set(kept.map((r) => r.id));
      const serverOnly = serverRows.filter((r) => !localIds.has(r.id));
      (merged as unknown as Record<string, unknown[]>)[t] = [...kept, ...serverOnly];
      // A refused push tells us nothing new about what the server holds.
      nextKnown[t] = [...serverIds];
      continue;
    }

    const localOnly = localRows.filter((r) => !serverIds.has(r.id) && !deletedRemotely(r.id));
    (merged as unknown as Record<string, unknown[]>)[t] = [...serverRows, ...localOnly];
    nextKnown[t] = [...serverIds];
  }
  return { db: merged, known: nextKnown };
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
    const known = loadKnown();
    // Look first, so deliveries already stored are not sent again — and so a
    // row deleted in the database is recognised before anything is pushed.
    const before = await pull();
    const trimmed = mergeTables(local, before, new Set(TABLES), known).db;
    const { problems, failed } = await push(trimmed, before);
    const after = await pull();
    const { db: merged, known: nextKnown } = mergeTables(trimmed, after, failed, known);
    replaceAll(merged);
    saveKnown(nextKnown);

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


// ---------------------------------------------------------------------------
// The sync loop.
//
// Scoring must never wait for, or be lost to, the network. A ball is written
// locally and the UI moves on; this keeps trying to get it upstream until it
// succeeds. Failures back off so a dead connection does not hammer the phone,
// and any success or new ball resets the delay.
// ---------------------------------------------------------------------------

const RETRY_MIN = 3_000;
const RETRY_MAX = 60_000;
const IDLE = 30_000;

let running = false;
let queued = false;
let timer: number | null = null;
let attempt = 0;
let status: SyncStatus = { state: isRemote ? 'syncing' : 'off', pending: 0 };
const watchers = new Set<(s: SyncStatus) => void>();

export function currentStatus(): SyncStatus {
  return status;
}

export function watchStatus(cb: (s: SyncStatus) => void): () => void {
  watchers.add(cb);
  cb(status);
  return () => watchers.delete(cb);
}

function publish(next: SyncStatus): void {
  status = next;
  watchers.forEach((w) => w(next));
}

function schedule(ms: number): void {
  if (typeof window === 'undefined') return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void runSync();
  }, ms);
}

/**
 * Ask for a sync now. Safe to call on every ball: one runs at a time, and a
 * request made mid-run queues exactly one more pass afterwards.
 */
export function requestSync(): void {
  if (!isRemote) return;
  if (running) {
    queued = true;
    return;
  }
  void runSync();
}

async function runSync(): Promise<void> {
  if (!isRemote || running) return;
  running = true;
  publish({ ...status, state: 'syncing' });

  let next: SyncStatus;
  try {
    next = await syncNow();
  } catch (err) {
    // Never let a sync failure surface as an app error.
    next = { state: 'error', pending: status.pending, message: (err as Error).message };
  }
  running = false;
  publish(next);

  const settled = next.state === 'synced' && next.pending === 0;
  if (settled) attempt = 0;
  else attempt += 1;

  if (queued) {
    queued = false;
    schedule(0);
    return;
  }
  // Keep trying until everything is upstream; idle poll once it is.
  schedule(settled ? IDLE : Math.min(RETRY_MIN * 2 ** (attempt - 1), RETRY_MAX));
}

/** Start the loop and keep it honest about connectivity. */
export function startSyncLoop(): () => void {
  if (!isRemote || typeof window === 'undefined') return () => {};
  const wake = (): void => requestSync();
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', wake);
  const unsubscribe = subscribeToChanges(wake);
  void runSync();

  return () => {
    window.removeEventListener('online', wake);
    document.removeEventListener('visibilitychange', wake);
    unsubscribe();
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
}


/**
 * Take the scorebook as gospel: replace this device with exactly what the
 * database holds, discarding anything local that is not there.
 *
 * The ordinary merge deliberately protects unsent work, which is right while
 * scoring and wrong after a deliberate wipe — the device keeps restoring what
 * you just deleted. This is the explicit way to say "the database is correct,
 * I am not". It throws away anything scored on this device and not yet saved,
 * so it asks first in the UI.
 */
export async function forcePull(): Promise<SyncStatus> {
  if (!isRemote) return { state: 'off', pending: 0 };
  try {
    const server = await pull();
    const local = snapshot();
    const next: DB = { ...local };
    const known: Known = {};
    for (const t of TABLES) {
      const rows = (server[t] ?? []) as Array<{ id: string }>;
      (next as unknown as Record<string, unknown[]>)[t] = rows;
      known[t] = rows.map((r) => r.id);
    }
    replaceAll(next);
    saveKnown(known);
    publish({ state: 'synced', pending: 0, at: Date.now() });
    return { state: 'synced', pending: 0 };
  } catch (err) {
    return { state: 'error', pending: 0, message: (err as Error).message };
  }
}
