'use client';

/**
 * The Supabase client.
 *
 * Only the anon key ever reaches the browser, which is safe by design: what a
 * visitor can actually do is decided by the row level security in
 * supabase/migrations/0002_rls.sql, not by hiding the key. Viewers read, the
 * assigned scorer and admins write, and nobody deletes a delivery.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../src/db/database.types';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * True once both variables are set. Until then the app runs entirely on the
 * device, so a missing key degrades to local-only rather than a blank screen.
 */
export const isRemote = Boolean(url && anonKey);

let client: SupabaseClient<Database> | null = null;

export function supabase(): SupabaseClient<Database> {
  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY',
    );
  }
  client ??= createClient<Database>(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 5 } },
  });
  return client;
}

/** Null instead of throwing, for code paths that can fall back to local. */
export function supabaseOrNull(): SupabaseClient<Database> | null {
  return isRemote ? supabase() : null;
}
