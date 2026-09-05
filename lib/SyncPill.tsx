'use client';

/**
 * The only network UI the scorer ever sees: Synced / 3 pending / Offline.
 *
 * It also drives the sync itself — one pass on load, one whenever the browser
 * says the connection is back, one every half minute, and one whenever another
 * device changes something.
 */

import { useEffect, useState } from 'react';
import { isRemote } from './supabase';
import { subscribeToChanges, syncNow, type SyncStatus } from './sync';

export function SyncPill() {
  const [status, setStatus] = useState<SyncStatus>({ state: isRemote ? 'syncing' : 'off', pending: 0 });

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

  if (!isRemote || status.state === 'off') return null;

  const label =
    status.state === 'offline'
      ? 'Offline'
      : status.pending > 0
        ? `${status.pending} pending`
        : status.state === 'syncing'
          ? 'Syncing'
          : status.state === 'error'
            ? 'Sync failed'
            : 'Synced';

  const tone =
    status.state === 'error' ? 'red' : status.pending > 0 || status.state === 'offline' ? 'amber' : 'green';

  return (
    <div
      className="noprint"
      style={{
        position: 'fixed',
        top: 'calc(6px + env(safe-area-inset-top))',
        right: 8,
        zIndex: 40,
        pointerEvents: 'none',
      }}
    >
      <span className={`chip ${tone}`} style={{ background: 'var(--turf)' }} title={status.message}>
        {label}
      </span>
    </div>
  );
}
