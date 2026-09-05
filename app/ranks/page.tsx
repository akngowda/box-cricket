'use client';

/** Phase 5 / 8 — overall rankings only. No scope tabs here on purpose. */

import { Rankings } from '../../lib/rankings';
import { useDB } from '../../lib/store';
import { TabBar, TopBar } from '../../lib/ui';

export default function RanksPage() {
  const db = useDB();
  return (
    <div className="app">
      <TopBar title="Rankings" back="/" />
      <div className="pad">
        <div className="hint" style={{ marginBottom: 12 }}>
          Everything here is per player and counts every week ever played. Squads change from
          week to week, so nothing is totalled by team.
        </div>
        <Rankings db={db} scopes={['overall']} />
      </div>
      <div style={{ height: 24 }} />
      <TabBar active="ranks" />
    </div>
  );
}
