'use client';

/**
 * Phase 5 — the full card: batting, bowling, fall of wickets and every ball.
 * Public, no login.
 */

import { useParams } from 'next/navigation';
import { matchInnings, matchRules, scoreboard } from '../../../../lib/innings';
import { fmt, overs, strikeRate } from '../../../../lib/stats';
import { playerName, squadName, useDB, type DB } from '../../../../lib/store';
import { PrintButton, PrintHeader, TabBar, TopBar } from '../../../../lib/ui';
import type { InningsRow } from '../../../../src/db/database.types';
import type { RulesConfig, WicketType } from '../../../../src/engine/types';

const OUT_LABEL: Record<WicketType, string> = {
  bowled: 'b',
  caught: 'c',
  runout: 'run out',
  stumped: 'st',
  dotout: 'dot out',
  bodyout: 'body out',
  retired_out: 'retired out',
  retired_hurt: 'retired hurt',
};

export default function Scorecard() {
  const params = useParams<{ matchId: string }>();
  const db = useDB();
  const match = db.matches.find((m) => m.id === params.matchId);

  if (!match) {
    return (
      <div className="app">
        <TopBar title="Scorecard" back="/" />
        <div className="pad">
          <div className="note">That match is not on this device.</div>
        </div>
      </div>
    );
  }

  const rules = matchRules(db, match);
  const innings = matchInnings(db, match.id);

  return (
    <div className="app">
      <TopBar title="Scorecard" back={`/m/${match.id}`} />
      <div className="pad">
        <PrintHeader
          title={`${squadName(db, match.squad_a_id)} v ${squadName(db, match.squad_b_id)}`}
          subtitle={[match.match_date, match.venue, `Match ${match.match_no}`]
            .filter(Boolean)
            .join(' · ')}
        />
        {match.result_text && (
          <div className="card" style={{ textAlign: 'center', marginBottom: 14 }}>
            <div className="score mid" style={{ fontSize: 20 }}>{match.result_text}</div>
          </div>
        )}
        {innings.length === 0 && <div className="note">No innings yet.</div>}
        {innings.map((i) => (
          <InningsCard key={i.id} db={db} innings={i} rules={rules} />
        ))}
        <PrintButton label="Save this scorecard as PDF" />
      </div>
      <div style={{ height: 24 }} />
      <TabBar active="matches" />
    </div>
  );
}

function InningsCard({ db, innings, rules }: { db: DB; innings: InningsRow; rules: RulesConfig }) {
  const board = scoreboard(db, innings, rules);
  if (!board || board.error) {
    return <div className="note">{squadName(db, innings.batting_squad_id)} — not started.</div>;
  }
  const s = board.state;
  const batted = s.battingOrder.filter((id) => s.batsmen[id]?.hasBatted);
  const bowled = Object.values(s.bowlers).filter((b) => b.legalBalls > 0 || b.runsConceded > 0);

  return (
    <div style={{ marginBottom: 26 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="tcode">{squadName(db, innings.batting_squad_id)}</span>
        <span className="score" style={{ fontSize: 22 }}>
          {s.runs}/{s.wickets}
          <span className="sub" style={{ marginLeft: 6, fontFamily: 'var(--font-ui)' }}>
            ({overs(s.legalBalls, rules.ballsPerOver)})
          </span>
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th>Batting</th>
            <th>R</th>
            <th>B</th>
            <th>SR</th>
            <th>z1/2/3</th>
          </tr>
        </thead>
        <tbody>
          {batted.map((id) => {
            const b = s.batsmen[id];
            if (!b) return null;
            const fow = s.fallOfWickets.find((f) => f.playerOutId === id);
            return (
              <tr key={id}>
                <td>
                  {playerName(db, id)}
                  {s.strikerId === id && '*'}
                  <div className="sub" style={{ fontSize: 10 }}>
                    {b.isOut && fow
                      ? `${OUT_LABEL[fow.type]}${fow.bowlerId ? ` ${playerName(db, fow.bowlerId)}` : ''}${
                          fow.fielderId && fow.type === 'caught' ? ` (${playerName(db, fow.fielderId)})` : ''
                        }`
                      : b.isRetiredHurt
                        ? 'retired hurt'
                        : 'not out'}
                  </div>
                </td>
                <td>
                  <b>{b.runs}</b>
                </td>
                <td>{b.ballsFaced}</td>
                <td>{b.ballsFaced ? ((b.runs / b.ballsFaced) * 100).toFixed(0) : '—'}</td>
                <td className="sub">
                  {b.zoneCounts[1]}/{b.zoneCounts[2]}/{b.zoneCounts[3]}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="sub" style={{ margin: '8px 0 16px' }}>
        Extras {s.extras.total} (wides {s.extras.wides}, no balls {s.extras.noBalls})
      </div>

      <table>
        <thead>
          <tr>
            <th>Bowling</th>
            <th>O</th>
            <th>Dots</th>
            <th>R</th>
            <th>W</th>
            <th>Econ</th>
          </tr>
        </thead>
        <tbody>
          {bowled.map((b) => (
            <tr key={b.id}>
              <td>{playerName(db, b.id)}</td>
              <td>{overs(b.legalBalls, rules.ballsPerOver)}</td>
              <td>{b.dotBalls}</td>
              <td>{b.runsConceded}</td>
              <td>
                <b>{b.wickets}</b>
              </td>
              <td>
                {b.legalBalls
                  ? (b.runsConceded / (b.legalBalls / rules.ballsPerOver)).toFixed(1)
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {s.fallOfWickets.length > 0 && (
        <>
          <div className="lbl">Fall of wickets</div>
          <div className="sub">
            {s.fallOfWickets
              .map(
                (f) =>
                  `${f.wicketNumber}-${f.runs} (${playerName(db, f.playerOutId)}, ${overs(
                    f.legalBalls,
                    rules.ballsPerOver,
                  )})`,
              )
              .join(' · ')}
          </div>
        </>
      )}

      <div className="lbl">Ball by ball</div>
      {board.results
        .slice()
        .reverse()
        .map((r, i) => (
          <div key={i} className="sub" style={{ padding: '4px 0', borderBottom: '1px solid #1B2A22' }}>
            <span style={{ color: 'var(--chalk)', fontFamily: 'var(--font-num)', marginRight: 6 }}>
              {r.overNo}.{r.ballNo}
            </span>
            {r.commentary}
          </div>
        ))}
    </div>
  );
}
