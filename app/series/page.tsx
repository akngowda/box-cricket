'use client';

/** Every series ever played — public, no login. */

import Link from 'next/link';
import { seriesState } from '../../lib/stats';
import { squadCode, useDB } from '../../lib/store';
import { TabBar, TopBar } from '../../lib/ui';

export default function AllSeries() {
  const db = useDB();
  const list = db.series.filter((s) => s.deleted_at === null).slice().reverse();

  return (
    <div className="app">
      <TopBar title="Series" back="/" />
      <div className="pad">
        {list.length === 0 && <div className="note">No series yet.</div>}
        {list.map((s) => {
          const st = seriesState(db, s.id);
          const scoreline = st.table.map((t) => `${squadCode(db, t.squadId)} ${t.wins}`).join(' — ');
          return (
            <Link key={s.id} href={`/s/${s.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="card" style={{ marginBottom: 9 }}>
                <div className="row">
                  <div>
                    <div className="tcode">{s.name}</div>
                    <div className="sub" style={{ marginTop: 3 }}>
                      {st.played} of {st.planned} played
                    </div>
                  </div>
                  <span className="score" style={{ fontSize: 19 }}>{scoreline || '—'}</span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
      <div style={{ height: 24 }} />
      <TabBar active="series" />
    </div>
  );
}
