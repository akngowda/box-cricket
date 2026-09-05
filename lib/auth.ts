'use client';

/**
 * Who is using the app, and what they are allowed to do.
 *
 * There is no password here yet — Supabase Auth arrives with Phase 5 and this
 * module is the seam it plugs into. What this DOES give us now is identity:
 * every write is stamped with the email that made it, so the activity log can
 * say who changed what.
 *
 * The super admin is fixed in code. He cannot be removed, and he is the only
 * one who can add or remove other admins.
 */

import { useCallback, useSyncExternalStore } from 'react';

export const SUPER_ADMIN = 'akarsha.kng@gmail.com';

const KEY = 'box-cricket.user';
const listeners = new Set<() => void>();
let cache: string | null | undefined;

export const normalise = (email: string): string => email.trim().toLowerCase();

function read(): string | null {
  if (cache !== undefined) return cache;
  if (typeof window === 'undefined') return null;
  try {
    cache = window.localStorage.getItem(KEY);
  } catch {
    cache = null;
  }
  return cache;
}

export function signIn(email: string): void {
  cache = normalise(email);
  try {
    window.localStorage.setItem(KEY, cache);
  } catch {
    /* signing in must not fail because storage is full */
  }
  listeners.forEach((l) => l());
}

export function signOut(): void {
  cache = null;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The signed-in email, or null. Also readable outside React (see store). */
export function currentEmail(): string | null {
  return read();
}

export function useCurrentEmail(): string | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

export function isSuperAdmin(email: string | null): boolean {
  return email !== null && normalise(email) === SUPER_ADMIN;
}

/** Admins are the super admin plus anyone he has added. */
export function isAdmin(email: string | null, admins: readonly string[]): boolean {
  if (email === null) return false;
  const e = normalise(email);
  return e === SUPER_ADMIN || admins.map(normalise).includes(e);
}

export function useSignIn(): (email: string) => void {
  return useCallback((email: string) => signIn(email), []);
}
