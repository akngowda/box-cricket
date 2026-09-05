'use client';

/**
 * Phase 5 — the public series page: the scoreline, every match, and rankings
 * with Series and Overall tabs (defaulting to Series). No jersey points table:
 * stats attach to players, never to a shirt.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { matchInnings, matchRules, scoreboard } from '../../../lib/innings';
import { Rankings } from '../../../lib/rankings';
import { seriesState } from '../../../lib/stats';
import { squadCode, squadName, useDB, type DB } from '../../../lib/store';
import { PrintButton, PrintHeader, TabBar, TopBar } from '../../../lib/ui';
import type { MatchRow } from '../../../src/db/database.types';

export default function SeriesView() {
  const params = useParams<{ seriesId: string }>();
  const db = useDB();
  const state = seriesState(db, params.seriesId);

  if (!state.series) {
    return (
      <div className="app">
        <TopBar title="Series" back="/" />
        <div className="pad">
          <div className="note">That series is not on this device.</div>
        </div>
      </div>
    );
  }

  const scoreline = state.table.map((t) => `${squadCode(db, t.squadId)} ${t.wins}`).join(' — ');

  return (
    <div className="app">
      <TopBar
        title={state.series.name}
        back="/"
        right={<ShareButton label={state.series.name} />}
      />

      <div className="pad">
        <PrintHeader
          title={state.series.name}
          subtitle={`${state.played} of ${state.planned} matches played`}
        />
        <div className="card" style={{ textAlign: 'center' }}>
          <div className="sub">series</div>
          <div className="score mid" style={{ margin: '6px 0' }}>{scoreline || '0 — 0'}</div>
          <div className="sub">
            {state.played} of {state.planned} played
            {state.ties > 0 && ` · ${state.ties} tied`}
            {state.decided && state.leader && ` · ${squadName(db, state.leader.squadId)} have it`}
          </div>
        </div>

        <div className="lbl" style={{ marginTop: 18 }}>Matches</div>
        {state.matches.map((m) => (
          <MatchLine key={m.id} db={db} match={m} />
        ))}
        {state.matches.length === 0 && <div className="note">No matches yet.</div>}

        <div className="lbl" style={{ marginTop: 22 }}>Rankings</div>
        <Rankings db={db} scopes={['series', 'overall']} seriesId={state.series.id} />

        <div style={{ marginTop: 18 }}>
          <PrintButton label="Save this series report as PDF" />
        </div>
      </div>

      <div style={{ height: 24 }} />
      <TabBar active="series" />
    </div>
  );
}

function MatchLine({ db, match }: { db: DB; match: MatchRow }) {
  const rules = matchRules(db, match);
  const innings = matchInnings(db, match.id);
  const lines = innings.map((i) => {
    const board = scoreboard(db, i, rules);
    const s = board && !board.error ? board.state : null;
    return `${squadCode(db, i.batting_squad_id)} ${s ? `${s.runs}/${s.wickets}` : '—'}`;
  });

  return (
    <Link href={`/m/${match.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="card" style={{ marginBottom: 9 }}>
        <div className="row">
          <div>
            <div className="tcode">Match {match.match_no}</div>
            <div className="sub" style={{ marginTop: 3 }}>{lines.join('  ·  ') || 'not started'}</div>
          </div>
          <span
            className={`chip ${
              match.status === 'live' ? 'red' : match.status === 'completed' ? 'green' : 'amber'
            }`}
          >
            {match.status === 'live' ? 'live' : match.status}
          </span>
        </div>
        {match.result_text && (
          <div className="sub" style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--line)' }}>
            {match.result_text}
          </div>
        )}
      </div>
    </Link>
  );
}

/** Sharing a link is the whole point of the public pages. */
function ShareButton({ label }: { label: string }) {
  return (
    <button
      className="chip"
      onPointerDown={async () => {
        const url = window.location.href;
        try {
          if (navigator.share) await navigator.share({ title: label, url });
          else {
            await navigator.clipboard.writeText(url);
            alert('Link copied');
          }
        } catch {
          /* the user dismissed the share sheet */
        }
      }}
    >
      Share ▸
    </button>
  );
}
