'use client';

/**
 * Phase 3 / 3b — one weekend series: two squads built from the pool, the
 * matches, and the virtual toss (R3).
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { fill, RulesEditor } from '../../../../lib/settings';
import {
  addPlayer,
  addToSquad,
  abandonMatch,
  createMatch,
  deleteMatch,
  deleteSeries,
  extendSeries,
  isTestSeries,
  renameJersey,
  renameSeries,
  setSeriesIsTest,
  setSquadJersey,
  generalSettings,
  recordCall,
  recordDecision,
  recordSpin,
  recordWinnerChoice,
  removeFromSquad,
  setLastMan,
  squadMembers,
  squadName,
  useDB,
  useMutate,
  type DB,
} from '../../../../lib/store';
import { isSuperAdmin } from '../../../../lib/auth';
import { useSession } from '../../../../lib/session';
import { Btn, NumberPicker, Sheet, tapProps, Toggle, TopBar } from '../../../../lib/ui';
import type { MatchRow, SquadRow } from '../../../../src/db/database.types';
import type { RulesConfig, RulesConfigOverride } from '../../../../src/engine/types';

export default function SeriesPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const db = useDB();
  const email = useSession().email;
  const mutate = useMutate();
  const [addTo, setAddTo] = useState<SquadRow | null>(null);
  const [newMatch, setNewMatch] = useState(false);
  const [toss, setToss] = useState<MatchRow | null>(null);

  const series = db.series.find((s) => s.id === params.id);
  if (!series) return <div className="app"><TopBar title="Series" back="/admin" /></div>;
  const testSeries = isTestSeries(db, series.id);

  const squads = db.squads.filter((q) => q.series_id === series.id);
  const sizes = squads.map((q) => squadMembers(db, q.id).length);
  const [sizeA = 0, sizeB = 0] = sizes;
  const uneven = squads.length === 2 && sizeA !== sizeB;
  const smaller = uneven ? (sizeA < sizeB ? squads[0] : squads[1]) : null;
  const matches = db.matches.filter((m) => m.series_id === series.id);
  const played = matches.filter((m) => m.status === 'completed').length;

  return (
    <div className="app">
      <TopBar title={`${series.name}${testSeries ? ' · test' : ''}`} back="/admin" right={<span className="chip">{played}/{series.planned_matches}</span>} />

      <div className="pad">
        {/* R1 — build the week's two sides from the pool. */}
        {squads.map((q) => {
          const members = squadMembers(db, q.id);
          return (
            <div key={q.id} className="card" style={{ marginBottom: 9 }}>
              <div className="row">
                <div
                  className="tcode"
                  {...tapProps(() => {
                    const jersey = db.jerseys.find((j) => j.id === q.jersey_id);
                    if (jersey) {
                      const next = prompt('Team name', jersey.name);
                      if (next && next.trim()) mutate((d) => renameJersey(d, jersey.id, next));
                      return;
                    }
                    // No team on this squad: name one now and attach it.
                    const teamName = prompt('This side has no team. Name it');
                    if (!teamName || !teamName.trim()) return;
                    mutate((d) => {
                      const withTeam = addJersey(d, teamName, '#ffb627');
                      const created = withTeam.jerseys[withTeam.jerseys.length - 1];
                      return created ? setSquadJersey(withTeam, q.id, created.id) : withTeam;
                    });
                  })}
                >
                  {squadName(db, q.id)}
                </div>
                <span className="chip">{members.length} players</span>
              </div>

              <div style={{ margin: '10px 0' }}>
                {members.map((p) => (
                  <div
                    key={p.id}
                    className="row"
                    style={{ padding: '6px 0', borderBottom: '1px solid #1B2A22' }}
                  >
                    <span style={{ fontSize: 13.5 }}>{p.name}</span>
                    <Btn
                      className="btn ghost"
                      style={{ width: 70, padding: '5px 4px', fontSize: 11 }}
                      onTap={() => mutate((d) => removeFromSquad(d, q.id, p.id))}
                    >
                      Remove
                    </Btn>
                  </div>
                ))}
                {members.length === 0 && <div className="sub">Nobody yet — search-add from the pool.</div>}
              </div>

              <div className="row">
                <Btn className="btn" style={{ flex: 1 }} onTap={() => setAddTo(q)}>
                  Add players
                </Btn>
                {/* R24 — last man, enabled per team before the toss. */}
                <Btn
                  className={q.last_man_enabled ? 'btn primary' : 'btn ghost'}
                  style={{ flex: 1 }}
                  onTap={() => mutate((d) => setLastMan(d, q.id, !q.last_man_enabled))}
                >
                  Last man {q.last_man_enabled ? 'on' : 'off'}
                </Btn>
              </div>
            </div>
          );
        })}

        {uneven && smaller && !smaller.last_man_enabled && (
          <div className="note" style={{ borderColor: 'var(--sodium-dim)', marginBottom: 12 }}>
            <b>Squads are uneven — {sizeA} v {sizeB}.</b> Give {squadName(db, smaller.id)} last man
            so both sides get the same number of wickets.
            <Btn
              className="btn primary"
              style={{ marginTop: 9 }}
              onTap={() => mutate((d) => setLastMan(d, smaller.id, true))}
            >
              Enable last man for {squadName(db, smaller.id)}
            </Btn>
          </div>
        )}

        <div className="lbl" style={{ marginTop: 16 }}>Matches</div>
        {matches.map((m) => (
          <MatchRowCard
            key={m.id}
            db={db}
            match={m}
            onToss={() => setToss(m)}
            {...(testSeries
              ? {
                  onDelete: () => {
                    if (confirm(`Delete match ${m.match_no} and every ball in it? This cannot be undone.`))
                      mutate((d) => deleteMatch(d, m.id));
                  },
                }
              : {
                  onAbandon: () => {
                    if (confirm(`Abandon match ${m.match_no}? It keeps its balls but stops counting.`))
                      mutate((d) => abandonMatch(d, m.id));
                  },
                })}
            {...(m.status === 'completed' && !matches.some((x) => x.status !== 'completed')
              ? { onNext: () => setNewMatch(true) }
              : {})}
          />
        ))}

        <Btn
          className="btn primary"
          style={{ marginTop: 4 }}
          disabled={sizeA < 2 || sizeB < 2}
          onTap={() => setNewMatch(true)}
        >
          {sizeA < 2 || sizeB < 2 ? 'Both squads need at least 2 players' : 'Add a match'}
        </Btn>

        {/* Only the super admin decides what counts as practice data. */}
        {isSuperAdmin(email) && (
          <div className="card" style={{ padding: '11px 13px', marginTop: 16 }}>
            <div className="row">
              <div style={{ flex: 1, fontSize: 13 }}>
                Test series
                <div className="sub" style={{ fontSize: 10.5, marginTop: 2 }}>
                  {testSeries
                    ? 'This one can be deleted, matches and balls and all.'
                    : 'Mark it as practice data to make it deletable.'}
                </div>
              </div>
              <Toggle
                on={testSeries}
                onTap={() => mutate((d) => setSeriesIsTest(d, series.id, !testSeries))}
              />
            </div>
          </div>
        )}

        {testSeries ? (
          <Btn
            className="btn danger"
            style={{ marginTop: 14 }}
            onTap={() => {
              if (
                confirm(
                  `Delete ${series.name} and every match and ball in it? This cannot be undone.`,
                )
              ) {
                mutate((d) => deleteSeries(d, series.id));
                router.push('/admin');
              }
            }}
          >
            Delete this test series
          </Btn>
        ) : (
          <div className="hint" style={{ marginTop: 14, textAlign: 'center' }}>
            A real series is permanent. Individual matches can be abandoned.
          </div>
        )}

        <div className="row" style={{ marginTop: 14, marginBottom: 24 }}>
          <span className="sub" style={{ flex: 1 }}>Matches planned</span>
          <NumberPicker
            label="Matches planned"
            value={series.planned_matches}
            quick={[1, 3, 5, 7]}
            min={1}
            max={50}
            width={80}
            onChange={(n) => mutate((d) => extendSeries(d, series.id, n))}
          />
        </div>
      </div>

      {addTo && <AddPlayersSheet squad={addTo} onClose={() => setAddTo(null)} />}
      {newMatch && <NewMatchSheet seriesId={series.id} onClose={() => setNewMatch(false)} />}
      {toss && <TossSheet match={toss} onClose={() => setToss(null)} />}
    </div>
  );
}

function MatchRowCard({
  db,
  match,
  onToss,
  onNext,
  onDelete,
  onAbandon,
}: {
  db: DB;
  match: MatchRow;
  onToss: () => void;
  onNext?: () => void;
  onDelete?: () => void;
  onAbandon?: () => void;
}) {
  const tossed = match.toss_decision !== null;
  return (
    <div className="card" style={{ marginBottom: 9 }}>
      <div className="row">
        <div>
          <div className="tcode">Match {match.match_no}</div>
          <div className="sub" style={{ marginTop: 3 }}>
            {match.venue ?? 'no venue'} · {match.overs} overs
            {match.toss_winner_squad_id &&
              ` · ${squadName(db, match.toss_winner_squad_id)} chose to ${match.toss_decision ?? '…'}`}
          </div>
        </div>
        <span className={`chip ${match.status === 'live' ? 'red' : match.status === 'completed' ? 'green' : 'amber'}`}>
          {match.status}
        </span>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        {!tossed ? (
          <Btn className="btn primary" style={{ flex: 1 }} onTap={onToss}>
            Toss
          </Btn>
        ) : (
          <Link href={`/score/${match.id}`} style={{ flex: 1, textDecoration: 'none' }}>
            <button className="btn primary">{match.status === 'completed' ? 'Scorecard' : 'Score'}</button>
          </Link>
        )}
        {/* A test match can go entirely; a real one can only be abandoned. */}
        {onDelete && (
          <Btn className="btn danger" style={{ flex: 1 }} onTap={onDelete}>
            Delete
          </Btn>
        )}
        {onAbandon && match.status !== 'completed' && match.status !== 'abandoned' && (
          <Btn className="btn ghost" style={{ flex: 1 }} onTap={onAbandon}>
            Abandon
          </Btn>
        )}
        {match.status === 'completed' && onNext && (
          <Btn className="btn" style={{ flex: 1 }} onTap={onNext}>
            Start next match
          </Btn>
        )}
      </div>
    </div>
  );
}

/** R1 — search-add from the pool, with an inline "add a new player" (R39 swaps). */
function AddPlayersSheet({ squad, onClose }: { squad: SquadRow; onClose: () => void }) {
  const db = useDB();
  const mutate = useMutate();
  const [q, setQ] = useState('');

  const inThisSquad = new Set(squadMembers(db, squad.id).map((p) => p.id));
  const otherSquads = db.squads.filter((s) => s.series_id === squad.series_id && s.id !== squad.id);
  const takenElsewhere = new Map<string, string>();
  for (const s of otherSquads) for (const p of squadMembers(db, s.id)) takenElsewhere.set(p.id, s.id);

  const list = db.players
    .filter((p) => p.deleted_at === null && p.name.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 40);

  return (
    <Sheet title={`Add to ${squadName(db, squad.id)}`} onClose={onClose}>
      {/* The box stays put: only the list below it scrolls, so it cannot
          slide away underneath your thumb as the results narrow. */}
      <div className="pickerhead row">
        <input
          className="field"
          placeholder="Search the pool, or type a new name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Btn
          className="btn"
          style={{ width: 92 }}
          disabled={q.trim().length === 0}
          onTap={() => {
            mutate((d) => {
              const withPlayer = addPlayer(d, q);
              const added = withPlayer.players[withPlayer.players.length - 1];
              return added ? addToSquad(withPlayer, squad.id, added.id) : withPlayer;
            });
            setQ('');
          }}
        >
          New
        </Btn>
      </div>

      <div className="pickerlist">
      {list.map((p) => {
        const mine = inThisSquad.has(p.id);
        const elsewhere = takenElsewhere.get(p.id);
        return (
          <div key={p.id} className="row" style={{ padding: '8px 2px', borderBottom: '1px solid #1B2A22' }}>
            <span style={{ fontSize: 13.5, flex: 1 }}>
              {p.name}
              {elsewhere && (
                <span className="sub" style={{ marginLeft: 6 }}>
                  in {squadName(db, elsewhere)}
                </span>
              )}
            </span>
            <Btn
              className={mine ? 'btn ghost' : 'btn primary'}
              style={{ width: 96, padding: '7px 4px', fontSize: 12 }}
              onTap={() =>
                mutate((d) => (mine ? removeFromSquad(d, squad.id, p.id) : addToSquad(d, squad.id, p.id)))
              }
            >
              {mine ? 'Remove' : elsewhere ? 'Swap over' : 'Add'}
            </Btn>
          </div>
        );
      })}
      {list.length === 0 && <div className="sub" style={{ padding: '10px 2px' }}>No match in the pool — tap New to add him.</div>}
      </div>
      <div className="hint" style={{ marginTop: 12 }}>
        A player is in one squad per series — adding someone from the other side swaps him,
        and his stats stay with him.
      </div>
    </Sheet>
  );
}

/** R0 — the match level: the series values, pre-filled, changeable once more. */
function NewMatchSheet({ seriesId, onClose }: { seriesId: string; onClose: () => void }) {
  const db = useDB();
  const mutate = useMutate();
  const series = db.series.find((s) => s.id === seriesId);
  const [venue, setVenue] = useState('');
  const [rules, setRules] = useState<RulesConfig>(
    fill({ ...generalSettings(db), ...((series?.rules_config ?? {}) as RulesConfigOverride) }),
  );

  return (
    <Sheet title="Add a match" onClose={onClose}>
      <div className="lbl">Venue</div>
      <input className="field" placeholder="Turf 4" value={venue} onChange={(e) => setVenue(e.target.value)} />
      <div className="lbl" style={{ marginTop: 16 }}>
        Settings for this match — pre-filled from the series. They freeze at the toss.
      </div>
      <RulesEditor value={rules} onChange={setRules} />
      <Btn
        className="btn primary"
        style={{ marginTop: 12 }}
        onTap={() => {
          mutate((d) => createMatch(d, seriesId, rules, venue).db);
          onClose();
        }}
      >
        Create match
      </Btn>
    </Sheet>
  );
}

/**
 * R3 — the virtual toss. The result is generated and stored the instant Spin
 * is pressed, before the animation ends, so closing the app cannot change it.
 * The opposing captain calls while the coin is in the air.
 */
function TossSheet({ match, onClose }: { match: MatchRow; onClose: () => void }) {
  const db = useDB();
  const mutate = useMutate();
  const live = db.matches.find((m) => m.id === match.id) ?? match;
  const rules = fill({
    ...generalSettings(db),
    ...((db.series.find((s) => s.id === match.series_id)?.rules_config ?? {}) as RulesConfigOverride),
    ...(match.rules_override as RulesConfigOverride),
  });

  // R3a — from match 2 on, the previous winner picks instead of tossing.
  const previous = db.matches
    .filter((m) => m.series_id === match.series_id && m.match_no < match.match_no && m.winner_squad_id)
    .sort((a, b) => b.match_no - a.match_no)[0];
  const winnerChooses = rules.winnerChoosesNextMatch && previous?.winner_squad_id;

  const [phase, setPhase] = useState<'pick' | 'spinning' | 'reveal'>(winnerChooses ? 'reveal' : 'pick');
  const [caller, setCaller] = useState<string>(live.squad_a_id ?? '');

  const squads = [live.squad_a_id, live.squad_b_id].filter((x): x is string => x !== null);
  const opposing = squads.find((s) => s !== caller) ?? '';

  const spin = (): void => {
    // Generated and stored first; the animation is only decoration (R3).
    const result: 'heads' | 'tails' = Math.random() < 0.5 ? 'heads' : 'tails';
    mutate((d) => recordSpin(d, match.id, caller, result));
    setPhase('spinning');
    window.setTimeout(() => setPhase('reveal'), 3600); // 3–5 seconds
  };

  return (
    <Sheet title={winnerChooses ? 'Winner picks' : 'Toss'} onClose={onClose}>
      {winnerChooses && !live.toss_winner_squad_id && previous?.winner_squad_id && (
        <>
          <div className="hint" style={{ marginBottom: 12 }}>
            {squadName(db, previous.winner_squad_id)} won match {previous.match_no}, so they choose
            this time — no toss.
          </div>
          <Btn
            className="btn primary"
            onTap={() => mutate((d) => recordWinnerChoice(d, match.id, previous.winner_squad_id as string))}
          >
            {squadName(db, previous.winner_squad_id)} will choose
          </Btn>
        </>
      )}

      {phase === 'pick' && (
        <>
          <div className="lbl">Which captain is spinning?</div>
          <div className="grid2">
            {squads.map((s) => (
              <Btn
                key={s}
                className={caller === s ? 'btn primary' : 'btn'}
                onTap={() => setCaller(s)}
              >
                {squadName(db, s)}
              </Btn>
            ))}
          </div>
          <div className="hint" style={{ margin: '12px 0' }}>
            {squadName(db, opposing)} calls heads or tails while the coin is spinning.
          </div>
          <Btn className="btn primary" onTap={spin}>
            Spin
          </Btn>
        </>
      )}

      {phase === 'spinning' && (
        <>
          <div style={{ textAlign: 'center', padding: '18px 0' }}>
            <div
              style={{
                width: 88,
                height: 88,
                borderRadius: '50%',
                margin: '0 auto',
                background: 'var(--sodium)',
                animation: 'spin 0.45s linear infinite',
              }}
            />
            <style>{'@keyframes spin{to{transform:rotateY(360deg)}}'}</style>
            <div className="sub" style={{ marginTop: 12 }}>
              In the air — {squadName(db, opposing)}, call it.
            </div>
          </div>
          <div className="grid2">
            {(['heads', 'tails'] as const).map((c) => (
              <Btn
                key={c}
                className={live.toss_call === c ? 'btn primary' : 'btn'}
                onTap={() => mutate((d) => recordCall(d, match.id, c))}
              >
                {c}
              </Btn>
            ))}
          </div>
        </>
      )}

      {phase === 'reveal' && (
        <>
          {live.toss_result && (
            <div className="card" style={{ textAlign: 'center', marginBottom: 12 }}>
              <div className="sub">the coin</div>
              <div className="score mid" style={{ margin: '4px 0' }}>{live.toss_result.toUpperCase()}</div>
              <div className="sub">
                {squadName(db, live.toss_calling_squad_id)} spun · {squadName(db, opposing)} called{' '}
                {live.toss_call ?? '—'}
              </div>
            </div>
          )}

          {!live.toss_call && !winnerChooses && (
            <div className="grid2" style={{ marginBottom: 12 }}>
              {(['heads', 'tails'] as const).map((c) => (
                <Btn key={c} className="btn" onTap={() => mutate((d) => recordCall(d, match.id, c))}>
                  called {c}
                </Btn>
              ))}
            </div>
          )}

          {live.toss_winner_squad_id && (
            <>
              <div className="lbl">{squadName(db, live.toss_winner_squad_id)} won — bat or bowl?</div>
              <div className="grid2">
                {(['bat', 'bowl'] as const).map((d) => (
                  <Btn
                    key={d}
                    className="btn primary"
                    onTap={() => {
                      mutate((db2) => recordDecision(db2, match.id, d, rules));
                      onClose();
                    }}
                  >
                    {d}
                  </Btn>
                ))}
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                The effective config freezes now and cannot change for the rest of the match.
              </div>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}
