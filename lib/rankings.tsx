'use client';

/**
 * Rankings, shown at three scopes — match, series, overall.
 *
 * Each screen only offers the scopes that belong to it: the overall page has
 * no tabs, a series shows Series and Overall, a match shows all three.
 */

import { useState } from 'react';
import {
  average,
  economy,
  fmt,
  overs,
  playerStats,
  rank,
  strikeRate,
  type PlayerStats,
  type RankKey,
} from './stats';
import type { DB } from './store';
import { tapProps } from './ui';

export type Scope = 'match' | 'series' | 'overall';

const BOARDS: Array<{ key: RankKey; label: string }> = [
  { key: 'runs', label: 'Runs' },
  { key: 'average', label: 'Average' },
  { key: 'wickets', label: 'Wickets' },
  { key: 'strikeRate', label: 'Strike rate' },
  { key: 'economy', label: 'Economy' },
  { key: 'fielding', label: 'Fielding' },
  { key: 'won', label: 'Weeks won' },
];

export function Rankings({
  db,
  scopes,
  seriesId,
  matchId,
}: {
  db: DB;
  scopes: Scope[];
  seriesId?: string;
  matchId?: string;
}) {
  const [scope, setScope] = useState<Scope>(scopes[0] ?? 'overall');
  const [board, setBoard] = useState<RankKey>('runs');

  const stats =
    scope === 'overall'
      ? playerStats(db)
      : scope === 'series' && seriesId
        ? playerStats(db, seriesId)
        : matchOnly(db, matchId);

  const rows = rank(stats, board).slice(0, 12);

  return (
    <div>
      {scopes.length > 1 && (
        <div
          className="row"
          style={{ gap: 0, borderBottom: '1px solid var(--line)', marginBottom: 12 }}
        >
          {scopes.map((s) => (
            <button
              key={s}
              {...tapProps(() => setScope(s))}
              style={{
                flex: 1,
                background: 'none',
                border: 0,
                borderBottom: `2px solid ${scope === s ? 'var(--sodium)' : 'transparent'}`,
                color: scope === s ? 'var(--sodium)' : 'var(--muted)',
                fontFamily: 'inherit',
                fontSize: 12.5,
                padding: '10px 0',
                textTransform: 'capitalize',
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8 }}>
        {BOARDS.map((b) => (
          <button
            key={b.key}
            {...tapProps(() => setBoard(b.key))}
            className={`chip ${board === b.key ? 'amber' : ''}`}
            style={{ whiteSpace: 'nowrap', background: 'none' }}
          >
            {b.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="note">Nothing to rank yet — score a match first.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Player</th>
              {columnsFor(board).map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.playerId}>
                <td>{s.name}</td>
                {valuesFor(board, s).map((v, i) => (
                  <td key={i}>{i === 0 ? <b>{v}</b> : v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function columnsFor(board: RankKey): string[] {
  switch (board) {
    case 'runs':
      return ['Runs', 'Inns', 'Avg', 'SR'];
    case 'average':
      return ['Avg', 'Runs', 'Outs', 'Best'];
    case 'wickets':
      return ['Wkts', 'Overs', 'Runs', 'Econ'];
    case 'strikeRate':
      return ['SR', 'Runs', 'Balls'];
    case 'economy':
      return ['Econ', 'Overs', 'Wkts'];
    case 'fielding':
      return ['Total', 'Ct', 'RO', 'St'];
    case 'won':
      return ['Won', 'Played'];
  }
}

function valuesFor(board: RankKey, s: PlayerStats): string[] {
  switch (board) {
    case 'runs':
      return [String(s.runs), String(s.outs), fmt(average(s)), fmt(strikeRate(s), 0)];
    case 'average':
      return [fmt(average(s)), String(s.runs), String(s.outs), String(s.best)];
    case 'wickets':
      return [String(s.wickets), overs(s.ballsBowled), String(s.conceded), fmt(economy(s))];
    case 'strikeRate':
      return [fmt(strikeRate(s), 0), String(s.runs), String(s.ballsFaced)];
    case 'economy':
      return [fmt(economy(s)), overs(s.ballsBowled), String(s.wickets)];
    case 'fielding':
      return [
        String(s.catches + s.runOuts + s.stumpings),
        String(s.catches),
        String(s.runOuts),
        String(s.stumpings),
      ];
    case 'won':
      return [String(s.matchesWon), String(s.matches)];
  }
}

/** Match scope: the same aggregation, narrowed to this match's innings. */
function matchOnly(db: DB, matchId?: string): PlayerStats[] {
  if (!matchId) return [];
  const match = db.matches.find((m) => m.id === matchId);
  if (!match) return [];
  const scoped: DB = {
    ...db,
    matches: [match],
    innings: db.innings.filter((i) => i.match_id === matchId),
  };
  return playerStats(scoped, match.series_id);
}
