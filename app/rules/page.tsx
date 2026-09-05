'use client';

/**
 * Phase 7 — the rules page, public and always available, so an argument on the
 * turf gets settled on the spot. Written in plain language: no rule numbers,
 * because nobody standing on a floodlit box wants to hear "per R16b".
 */

import { useState } from 'react';
import { useSession } from '../../lib/session';
import { TabBar, tapProps, TopBar } from '../../lib/ui';

function BoxDiagram() {
  // Every net is drawn the same way — a double line, same weight all round —
  // so none of them reads as having depth. Zone 3 IS the front net, so it is
  // that line rather than a band.
  const NET = '#5F7A6B';
  const netWidth = 1.6;

  return (
    <svg viewBox="0 0 330 190" width="100%" role="img" aria-label="The box, with the four zones marked">
      {/* the floor of the box */}
      <rect x="20" y="26" width="280" height="138" fill="#142019" />

      {/* zone bands along the pitch: 1 is the biggest, 2 is a short band
          just before the front net */}
      <rect x="20" y="26" width="75" height="138" fill="#1C2C23" />
      <rect x="95" y="26" width="140" height="138" fill="#24382C" />
      <rect x="235" y="26" width="65" height="138" fill="rgba(255,182,39,.18)" />

      {/* the pitch, running the full length */}
      <rect x="20" y="82" width="280" height="26" fill="#0B1512" opacity=".55" />

      {/* side nets — top and bottom */}
      <g stroke={NET} strokeWidth={netWidth}>
        <line x1="20" y1="20" x2="300" y2="20" />
        <line x1="20" y1="25" x2="300" y2="25" />
        <line x1="20" y1="165" x2="300" y2="165" />
        <line x1="20" y1="170" x2="300" y2="170" />
        {/* back net, behind the keeper — same weight as the sides */}
        <line x1="10" y1="20" x2="10" y2="170" />
        <line x1="15" y1="20" x2="15" y2="170" />
      </g>

      {/* front net = zone 3. Same double line, picked out in the zone colour. */}
      <g stroke="#FF5C45" strokeWidth={netWidth}>
        <line x1="305" y1="20" x2="305" y2="170" />
        <line x1="310" y1="20" x2="310" y2="170" />
      </g>

      {/* mid line — where the non-striker stands, inside zone 1 */}
      <line x1="170" y1="26" x2="170" y2="164" stroke="#7E9489" strokeDasharray="4 4" />

      {/* bowling crease, with the stumps standing on it */}
      <line x1="235" y1="74" x2="235" y2="116" stroke="#E9EFEA" strokeWidth="2" />
      <line x1="235" y1="86" x2="235" y2="104" stroke="#FFB627" strokeWidth="4" />

      {/* batting end: stumps behind the batsman, crease in front of him */}
      <line x1="42" y1="86" x2="42" y2="104" stroke="#FFB627" strokeWidth="4" />
      <line x1="62" y1="74" x2="62" y2="116" stroke="#E9EFEA" strokeWidth="2" />

      <g fill="#E9EFEA" fontSize="13" fontFamily="var(--font-num)" textAnchor="middle">
        <text x="57" y="44">0</text>
        <text x="165" y="44">1</text>
        <text x="267" y="44">2</text>
        <text x="307" y="14" fill="#FF5C45">3</text>
      </g>
      <g fill="#7E9489" fontSize="8" textAnchor="middle">
        <text x="12" y="182">back net</text>
        <text x="170" y="182">mid line</text>
        <text x="255" y="182">bowling crease</text>
        <text x="307" y="182" fill="#FF5C45">front net</text>
      </g>
    </svg>
  );
}

const SECTIONS: Array<{ title: string; body: React.ReactNode }> = [
  {
    title: 'The zones',
    body: (
      <>
        <p>
          The box is marked with cones into four bands, measured along the pitch away from the
          batsman. The scorer taps whichever band the ball reached — the cones make the call, and
          only the first thing the ball touches counts.
        </p>
        <BoxDiagram />
        <p>
          <b>Zone 0</b> is the band around the batsman. <b>Zone 1</b> runs to the bowling crease.{' '}
          <b>Zone 2</b> starts at the bowling crease, where the stumps stand, and runs to the front
          net. <b>Zone 3</b> is the front net itself.
        </p>
      </>
    ),
  },
  {
    title: 'What a shot is worth',
    body: (
      <>
        <p>
          Runs depend on the zone <b>and</b> whether the ball bounced on the floor first (pitched)
          or arrived on the full (direct).
        </p>
        <table>
          <thead>
            <tr>
              <th>Zone</th>
              <th>Pitched</th>
              <th>Direct</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>0 — around the batsman</td><td>0</td><td>0</td></tr>
            <tr><td>1 — up to the bowling crease</td><td><b>1</b></td><td><b>2</b></td></tr>
            <tr><td>2 — crease to the front net</td><td><b>2</b></td><td><b>4</b></td></tr>
            <tr><td>3 — the front net</td><td><b>3</b></td><td><b>6</b></td></tr>
          </tbody>
        </table>
        <p>
          Hitting the top net counts as a bounce: the ball stays live and is scored by wherever it
          ends up.
        </p>
      </>
    ),
  },
  {
    title: 'Running',
    body: (
      <p>
        Physical runs are added on top. A run is only from the crease to the mid line, where the
        non-striker stands, so one is the usual number and two or more is rare. An odd number of
        runs changes strike; the zone runs never do, however big the hit.
      </p>
    ),
  },
  {
    title: 'Wides, no balls and free hits',
    body: (
      <p>
        A wide is one run and re-bowled — a dead ball, so nothing can be scored off it and the
        only way out is stumped. A no ball is two runs plus whatever is scored, re-bowled, and the
        only way out is a run out. The next legal ball after a no ball is a free hit, where a run
        out is the only way to lose your wicket. If that free hit is itself a wide or a no ball,
        the free hit carries over to the next one.
      </p>
    ),
  },
  {
    title: 'The impact over and the impact ball',
    body: (
      <p>
        The batting captain declares one over of the innings as the impact over, before it starts,
        and bat runs in it are doubled. <b>If nobody declares one, the last over is the impact
        over by default</b> — the side never loses it by forgetting. The final legal ball of the
        innings is also doubled. The two never stack: a doubled ball is worth twice, never four
        times. Extras are not doubled unless the league turns that on.
      </p>
    ),
  },
  {
    title: 'Getting out',
    body: (
      <>
        <p>
          Bowled, caught, run out, stumped, and retired. <b>There is no LBW, there are no byes,
          and there is no obstruction.</b> A catch only counts if it is taken before the ball
          touches the floor, a net or the roof.
        </p>
        <p>
          Two optional rules, switched on per league: <b>three dots in a row</b> and{' '}
          <b>three body hits</b>. Both dismiss the batsman and both are credited to the bowler; the
          app records them by itself, so the scorer never has to. A body hit is a dead ball worth
          nothing, so it also counts as a dot. Wides and no balls leave both counters untouched —
          they neither add to a streak nor break one.
        </p>
        <p>
          Two batsmen can never be out on the same ball. If a run is attempted on what would have
          been someone&apos;s deciding dot and the <em>other</em> batsman is run out, the streak is
          not broken by that ball — the league picks in advance whether it resets, carries over to
          the next dot, or leaves him needing to score off everything.
        </p>
      </>
    ),
  },
  {
    title: 'Bowling',
    body: (
      <p>
        Once a bowler finishes, he has to sit out a full over&apos;s worth of legal balls before
        he can bowl again — six, normally — so nobody bowls back to back. Each bowler also has a
        maximum number of overs for the match. If a bowler is hurt mid-over, someone else finishes
        it, and the balls already bowled stay on the original bowler&apos;s figures.
      </p>
    ),
  },
  {
    title: 'Last man',
    body: (
      <p>
        When a side is short, it can be given last man, so both teams have the same number of
        wickets to lose. The last man faces every single ball — he never rotates off strike, not
        even at the end of an over. A teammate stands at the other end, but he does{' '}
        <b>not</b> run for him: he simply holds the non-striker&apos;s end, which means a run out
        is on at both ends. If either of them is run out, the innings is over.
      </p>
    ),
  },
  {
    title: 'Teams and stats',
    body: (
      <p>
        There is one permanent pool of players. Every week two sides are picked from it, so who you
        played for last week means nothing. A player can be added or moved at any time, even
        mid-match, and he keeps everything he has already scored. All stats belong to the player,
        never to the shirt.
      </p>
    ),
  },
];

export default function RulesPage() {
  const session = useSession();
  const [open, setOpen] = useState<number | null>(0);

  return (
    <div className="app">
      <TopBar title="Rules" back="/" />
      <div className="pad">
        <div className="hint" style={{ marginBottom: 14 }}>
          Box cricket, as this league plays it. Anything not written here is not a rule.
        </div>

        {SECTIONS.map((s, i) => (
          <div key={s.title} className="card" style={{ marginBottom: 9, padding: 0 }}>
            <button
              {...tapProps(() => setOpen(open === i ? null : i))}
              style={{
                width: '100%',
                background: 'none',
                border: 0,
                color: 'var(--chalk)',
                fontFamily: 'inherit',
                fontSize: 14,
                fontWeight: 600,
                textAlign: 'left',
                padding: 14,
                display: 'flex',
                justifyContent: 'space-between',
                gap: 10,
              }}
            >
              {s.title}
              <span style={{ color: 'var(--muted)' }}>{open === i ? '−' : '+'}</span>
            </button>
            {open === i && (
              <div
                className="hint"
                style={{ padding: '0 14px 14px', borderTop: '1px solid #1B2A22', paddingTop: 12 }}
              >
                {s.body}
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ height: 24 }} />
      <TabBar active="rules" signedIn={session.role === 'admin'} />
    </div>
  );
}
