'use client';

/**
 * The only network UI the scorer ever sees: Synced / 3 pending / Offline.
 *
 * It also drives the sync itself — one pass on load, one whenever the browser
 * says the connection is back, one every half minute, and one whenever another
 * device changes something.
 *
 * Tapping it explains itself. "68 pending" with no explanation is alarming and
 * useless; the usual cause is simply that nobody is signed in, so the database
 * is refusing writes, and that is worth saying in words.
 */

import { useEffect, useState } from 'react';
import { useSession } from './session';
import { isRemote } from './supabase';
import { subscribeToChanges, syncNow, type SyncStatus } from './sync';
import { tapProps } from './ui';

export function SyncPill() {
  const [status, setStatus] = useState<SyncStatus>({ state: isRemote ? 'syncing' : 'off', pending: 0 });
  const [open, setOpen] = useState(false);
  const session = useSession();

  useEffect(() => {
    if (!isRemote) return;
    let alive = true;

    const run = async (): Promise<void> => {
      setStatus((s) => ({ ...s, state: 'syncing' }));
      const next = await syncNow();
      if (alive) setStatus(next);
    };

    void run();
    const timer = window.setInterval(run, 30_000);
    const unsubscribe = subscribeToChanges(() => void run());
    window.addEventListener('online', run);

    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('online', run);
      unsubscribe();
    };
  }, []);

  // Re-sync as soon as somebody signs in: that is usually what unblocks it.
  useEffect(() => {
    if (isRemote && session.role) void syncNow().then(setStatus);
  }, [session.role]);

  if (!isRemote || status.state === 'off') return null;

  const label =
    status.state === 'offline'
      ? 'Offline'
      : status.state === 'error'
        ? 'Not saved'
        : status.pending > 0
          ? `${status.pending} pending`
          : status.state === 'syncing'
            ? 'Syncing'
            : 'Synced';

  const tone =
    status.state === 'error' ? 'red' : status.pending > 0 || status.state === 'offline' ? 'amber' : 'green';

  const why = !session.role
    ? 'Nobody is signed in on this device, so the database is refusing to store anything. Sign in from Login and it will go up by itself.'
    : status.state === 'error'
      ? status.message ?? 'The database refused the last write.'
      : status.pending > 0
        ? 'These are on this device and on their way up. They are not lost.'
        : 'Everything on this device is in the database.';

  return (
    <div
      className="noprint"
      style={{ position: 'fixed', top: 'calc(6px + env(safe-area-inset-top))', right: 8, zIndex: 40 }}
    >
      <button
        className={`chip ${tone}`}
        style={{ background: 'var(--turf)' }}
        {...tapProps(() => setOpen((v) => !v))}
      >
        {label}
      </button>

      {open && (
        <div
          className="note"
          style={{ position: 'absolute', top: 26, right: 0, width: 250, background: 'var(--turf)' }}
        >
          <b>{status.pending} not in the database yet</b>
          <div style={{ marginTop: 6 }}>{why}</div>
          <button
            className="btn ghost"
            style={{ marginTop: 9, padding: 8, fontSize: 12 }}
            {...tapProps(() => {
              setOpen(false);
              void syncNow().then(setStatus);
            })}
          >
            Try again now
          </button>
        </div>
      )}
    </div>
  );
}
