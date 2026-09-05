'use client';

/**
 * Who is signed in, for real.
 *
 * With Supabase configured this is a genuine session: a password, a JWT, and a
 * role read from the `profiles` row that the database created on sign-up. The
 * super admin is promoted by a trigger on his first sign-in, so there is no
 * bootstrap step and no way to lock yourself out.
 *
 * Without Supabase configured the app still runs — it falls back to the local
 * identity in auth.ts, which records who you are without checking anything.
 */

import { useCallback, useEffect, useState } from 'react';
import { isRemote, supabase } from './supabase';
import { currentEmail as localEmail, signIn as localSignIn, signOut as localSignOut } from './auth';

export type Role = 'admin' | 'scorer' | null;

export interface Session {
  email: string | null;
  role: Role;
  userId: string | null;
  loading: boolean;
  /** True when a real Supabase session is backing this. */
  remote: boolean;
}

const EMPTY: Session = { email: null, role: null, userId: null, loading: true, remote: isRemote };

export function useSession(): Session {
  const [session, setSession] = useState<Session>(EMPTY);

  useEffect(() => {
    if (!isRemote) {
      const email = localEmail();
      setSession({ email, role: email ? 'admin' : null, userId: null, loading: false, remote: false });
      return;
    }

    const client = supabase();
    let alive = true;

    const load = async (): Promise<void> => {
      const { data } = await client.auth.getSession();
      const user = data.session?.user ?? null;
      if (!alive) return;
      if (!user) {
        setSession({ email: null, role: null, userId: null, loading: false, remote: true });
        return;
      }
      // The role lives in the database, not in the client, so it cannot be
      // faked by editing localStorage.
      const { data: row } = await client
        .from('profiles')
        .select('role, email')
        .eq('id', user.id)
        .maybeSingle();
      const profile = row as { role?: string; email?: string | null } | null;
      if (!alive) return;
      setSession({
        email: profile?.email ?? user.email ?? null,
        role: (profile?.role as Role) ?? 'scorer',
        userId: user.id,
        loading: false,
        remote: true,
      });
    };

    void load();
    const { data: sub } = client.auth.onAuthStateChange(() => void load());
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return session;
}

export interface AuthResult {
  ok: boolean;
  message?: string;
}

/** Sign in, creating the account on first use if it does not exist yet. */
export function useSignInWithPassword(): (email: string, password: string) => Promise<AuthResult> {
  return useCallback(async (email, password) => {
    if (!isRemote) {
      localSignIn(email);
      return { ok: true };
    }
    const client = supabase();
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (!error) return { ok: true };

    // First time for this email: sign them up instead of making them guess.
    if (/invalid login credentials/i.test(error.message)) {
      const { data, error: signUpError } = await client.auth.signUp({
        email: email.trim(),
        password,
      });
      if (signUpError) return { ok: false, message: signUpError.message };
      if (!data.session) {
        return {
          ok: false,
          message: 'Account created — confirm the link in your email, then sign in.',
        };
      }
      return { ok: true };
    }
    return { ok: false, message: error.message };
  }, []);
}

export function useSignOut(): () => Promise<void> {
  return useCallback(async () => {
    if (!isRemote) {
      localSignOut();
      return;
    }
    await supabase().auth.signOut();
  }, []);
}
