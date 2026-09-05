'use client';

import Link from 'next/link';
import { matchInnings, matchRules, scoreboard } from '../lib/innings';
import { squadCode, squadName, useDB, visibleMatches, type DB } from '../lib/store';
import { TabBar } from '../lib/ui';
import { useSession } from '../lib/session';
import type { MatchRow } from '../src/db/database.types';

export default function Home() {
  const db = useDB();
  const session = useSession();
  // A test series stays out of sight unless an admin is looking.
  const matches = visibleMatches(db, session.role === 'admin');
  const live = matches.filter((m) => m.status === 'live');
  const done = matches.filter((m) => m.status === 'completed').reverse();
  const upcoming = matches.filter((m) => m.status === 'scheduled');

  return (
    <div className="app">
      <div className="bar">
        <h2>Box Cricket</h2>
        <span className="chip">weekend league</span>
      </div>

      <div className="pad">
        {live.length > 0 && (
          <>
            <div className="row" style={{ marginBottom: 9 }}>
              <span className="sub">
                <span className="livedot" /> Live now
              </span>
            </div>
            {live.map((m) => (
              <MatchCard key={m.id} db={db} match={m} accent />
            ))}
          </>
        )}

        {upcoming.length > 0 && (
          <>
            <div className="lbl" style={{ marginTop: live.length ? 22 : 0 }}>
              Ready to start
            </div>
            {upcoming.map((m) => (
              <MatchCard key={m.id} db={db} match={m} />
            ))}
          </>
        )}

        {done.length > 0 && (
          <>
            <div className="lbl" style={{ marginTop: 22 }}>
              Results
            </div>
            {done.map((m) => (
              <MatchCard key={m.id} db={db} match={m} />
            ))}
          </>
        )}

        {matches.length === 0 && (
          <div className="note" style={{ marginTop: 8 }}>
            No matches yet. Sign in from <b>Login</b>, bottom right, to build the weekend&apos;s two
            squads, add a match and run the toss.
          </div>
        )}

        <Link href="/rules" style={{ textDecoration: 'none' }}>
          <button className="btn ghost" style={{ margin: '18px 0 20px' }}>
            Read the rules
          </button>
        </Link>
      </div>

      <TabBar active="matches" signedIn={session.role === 'admin'} />
    </div>
  );
}

function MatchCard({ db, match, accent }: { db: DB; match: MatchRow; accent?: boolean }) {
  const rules = matchRules(db, match);
  const innings = matchInnings(db, match.id);
  const lines = innings.map((i) => {
    const board = scoreboard(db, i, rules);
    const s = board?.error ? null : board?.state;
    return {
      code: squadCode(db, i.batting_squad_id),
      text: s ? `${s.runs}/${s.wickets}` : 'yet to bat',
      overs: s ? `${Math.floor(s.legalBalls / rules.ballsPerOver)}.${s.legalBalls % rules.ballsPerOver}` : '',
    };
  });
  // Public view by default — scoring lives behind /score for admins.
  const href = `/m/${match.id}`;

  return (
    <Link href={href} style={{ textDecoration: 'none', color: 'inherit' }}>
      <div
        className="card"
        style={{ marginBottom: 9, borderColor: accent ? 'var(--sodium-dim)' : undefined }}
      >
        <div className="row">
          <div>
            <div className="tcode">{squadName(db, match.squad_a_id)}</div>
            <div className="score mid">{lines[0]?.text ?? '—'}</div>
            <div className="sub">
              {lines[0]?.overs ? `${lines[0].overs} of ${rules.oversPerInnings} overs` : `match ${match.match_no}`}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="tcode" style={{ color: 'var(--muted)' }}>
              {squadName(db, match.squad_b_id)}
            </div>
            <div className="sub" style={{ marginTop: 4 }}>
              {lines[1] ? `${lines[1].text} (${lines[1].overs})` : 'yet to bat'}
            </div>
            {match.status === 'live' && (
              <span className="chip red" style={{ display: 'inline-block', marginTop: 8 }}>
                <span className="livedot" /> live
              </span>
            )}
            {match.status === 'scheduled' && (
              <span className="chip amber" style={{ display: 'inline-block', marginTop: 8 }}>
                {match.tossed_at ? 'toss done' : 'needs toss'}
              </span>
            )}
          </div>
        </div>
        {match.result_text && (
          <div
            className="sub"
            style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--line)' }}
          >
            {match.result_text}
          </div>
        )}
      </div>
    </Link>
  );
}
