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
import { currentStatus, requestSync, startSyncLoop, watchStatus, type SyncStatus } from './sync';
import { tapProps } from './ui';

export function SyncPill() {
  const [status, setStatus] = useState<SyncStatus>(currentStatus());
  const [open, setOpen] = useState(false);
  const session = useSession();

  // One loop for the whole app; the pill only reports what it is doing.
  useEffect(() => {
    const stop = startSyncLoop();
    const unwatch = watchStatus(setStatus);
    return () => {
      unwatch();
      stop();
    };
  }, []);

  // Signing in is usually what unblocks a refused push.
  useEffect(() => {
    if (session.role) requestSync();
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
    ? 'Nobody is signed in on this device, so nothing can be saved to the scorebook. Sign in from Login and it goes up by itself.'
    : status.state === 'error'
      ? (status.message ?? 'The last save was refused. Still trying.')
      : status.pending > 0
        ? 'Saved on this phone and on their way up. Nothing is lost.'
        : 'Everything on this phone is saved.';

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
          <b>{status.pending} not saved yet</b>
          <div style={{ marginTop: 6 }}>{why}</div>
          <button
            className="btn ghost"
            style={{ marginTop: 9, padding: 8, fontSize: 12 }}
            {...tapProps(() => {
              setOpen(false);
              requestSync();
            })}
          >
            Try again now
          </button>
        </div>
      )}
    </div>
  );
}
