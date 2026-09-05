'use client';

/**
 * Phase 5 — the link you paste in the group. No login, read only.
 *
 * (Live updates arrive with Supabase Realtime; today it reads this device's
 * log, so it repaints whenever the pad on the same device scores.)
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { isAdmin, useCurrentEmail } from '../../../lib/auth';
import { matchInnings, matchRules, scoreboard } from '../../../lib/innings';
import { Rankings } from '../../../lib/rankings';
import { playerName, squadCode, squadName, useDB } from '../../../lib/store';
import { TabBar, TopBar } from '../../../lib/ui';

export default function MatchView() {
  const params = useParams<{ matchId: string }>();
  const db = useDB();
  const email = useCurrentEmail();
  const match = db.matches.find((m) => m.id === params.matchId);

  if (!match) {
    return (
      <div className="app">
        <TopBar title="Match" back="/" />
        <div className="pad">
          <div className="note">That match is not on this device.</div>
        </div>
      </div>
    );
  }

  const rules = matchRules(db, match);
  const innings = matchInnings(db, match.id);
  const current = innings.find((i) => i.status === 'in_progress') ?? innings[innings.length - 1];
  const board = current ? scoreboard(db, current, rules) : null;
  const state = board && !board.error ? board.state : null;
  const first = innings.find((i) => i.seq === 1);
  const firstBoard = first && first !== current ? scoreboard(db, first, rules) : null;

  const balls = rules.oversPerInnings * rules.ballsPerOver;
  const left = state ? balls - state.legalBalls : balls;
  const need = current?.target != null && state ? current.target - state.runs : null;

  return (
    <div className="app">
      <TopBar
        title={`${squadCode(db, match.squad_a_id)} vs ${squadCode(db, match.squad_b_id)}`}
        back="/"
        right={
          match.status === 'live' ? (
            <span className="chip red">
              <span className="livedot" /> live
            </span>
          ) : (
            <span className="chip">{match.status}</span>
          )
        }
      />

      {state && state.impactOverNumber !== null && (
        <div className="banner impact">⬆ Impact over — bat runs doubled</div>
      )}
      {state?.isFreeHit && <div className="banner free">◎ Free hit</div>}
      {state?.lastManActive && <div className="banner last">◆ Last man in</div>}

      <div className="pad" style={{ paddingTop: 18, textAlign: 'center' }}>
        <div className="tcode" style={{ color: 'var(--muted)' }}>
          {squadName(db, current?.batting_squad_id ?? null).toUpperCase()}
        </div>
        <div className="score big" style={{ margin: '4px 0' }}>
          {state ? `${state.runs}/${state.wickets}` : '—'}
        </div>
        <div className="sub">
          {state
            ? `${Math.floor(state.legalBalls / rules.ballsPerOver)}.${state.legalBalls % rules.ballsPerOver} of ${rules.oversPerInnings}` +
              (state.legalBalls > 0 ? ` · run rate ${((state.runs / state.legalBalls) * rules.ballsPerOver).toFixed(1)}` : '')
            : 'not started'}
        </div>
        {need !== null && need > 0 && (
          <div className="chip amber" style={{ display: 'inline-block', marginTop: 10 }}>
            needs {need} from {left} balls
          </div>
        )}
        {firstBoard && !firstBoard.error && (
          <div className="sub" style={{ marginTop: 8 }}>
            {squadCode(db, first?.batting_squad_id ?? null)} made {firstBoard.state.runs}/
            {firstBoard.state.wickets}
          </div>
        )}
        {match.result_text && (
          <div className="chip green" style={{ display: 'inline-block', marginTop: 10 }}>
            {match.result_text}
          </div>
        )}
      </div>

      {state && (
        <div className="pad" style={{ marginTop: 18 }}>
          <div className="card" style={{ cursor: 'default' }}>
            <div className="row">
              <div>
                {playerName(db, state.strikerId)}{' '}
                <b style={{ fontFamily: 'var(--font-num)', fontSize: 17 }}>
                  {state.strikerId ? state.batsmen[state.strikerId]?.runs : 0}*
                </b>
              </div>
              <div className="sub">
                {state.strikerId ? state.batsmen[state.strikerId]?.ballsFaced : 0} balls
              </div>
            </div>
            {state.nonStrikerId && (
              <div
                className="row"
                style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1B2A22' }}
              >
                <div className="sub">
                  {playerName(db, state.nonStrikerId)}{' '}
                  <b style={{ fontFamily: 'var(--font-num)', fontSize: 15, color: 'var(--chalk)' }}>
                    {state.batsmen[state.nonStrikerId]?.runs ?? 0}
                  </b>
                </div>
                <div className="sub">{state.batsmen[state.nonStrikerId]?.ballsFaced ?? 0} balls</div>
              </div>
            )}
          </div>

          {/* this over, as a strip of balls */}
          <div className="lbl">This over</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {board?.results
              .filter((r) => r.overNo === Math.floor(state.legalBalls / rules.ballsPerOver))
              .map((r, i) => (
                <span
                  key={i}
                  className={`ball ${r.wicket ? 'w' : r.teamRuns >= 6 ? 'big' : r.teamRuns > 0 ? 'run' : ''}`}
                >
                  {r.wicket ? 'W' : r.teamRuns}
                </span>
              ))}
            {board?.results.filter((r) => r.overNo === Math.floor(state.legalBalls / rules.ballsPerOver))
              .length === 0 && <span className="sub">new over</span>}
          </div>

          <div className="lbl">Last 5 balls</div>
          {board?.results
            .slice(-5)
            .reverse()
            .map((r, i) => (
              <div key={i} className="sub" style={{ padding: '4px 0', borderBottom: '1px solid #1B2A22' }}>
                {r.overNo}.{r.ballNo} — {r.commentary}
              </div>
            ))}

          <Link href={`/m/${match.id}/scorecard`} style={{ textDecoration: 'none' }}>
            <button className="btn ghost" style={{ marginTop: 14 }}>
              Full scorecard and ball-by-ball
            </button>
          </Link>

          {/* Only an admin sees the way through to the pad. */}
          {isAdmin(email, db.admins) && match.status !== 'completed' && (
            <Link href={`/score/${match.id}`} style={{ textDecoration: 'none' }}>
              <button className="btn primary" style={{ marginTop: 9 }}>
                Score this match
              </button>
            </Link>
          )}

          <div className="lbl" style={{ marginTop: 20 }}>
            Rankings
          </div>
          <Rankings db={db} scopes={['match', 'series', 'overall']} seriesId={match.series_id} matchId={match.id} />
        </div>
      )}

      <div style={{ height: 24 }} />
      <TabBar active="matches" />
    </div>
  );
}
