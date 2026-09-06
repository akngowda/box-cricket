'use client';

/**
 * Phase 4 — the scoring pad. The most important screen in the app.
 *
 * Layout and design follow prototype.html; the row order is R7c, the greying
 * is R7b, and every number on screen comes from the Phase 1 engine replaying
 * the delivery log. Nothing here does arithmetic of its own.
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { matchInnings, matchRules, openingOf, scoreboard } from '../../../lib/innings';
import {
  appendDelivery,
  appendEvent,
  addToSquad,
  completeMatch,
  createMatch,
  extendSeries,
  nextSeq,
  playerName,
  setBallVoided,
  squadCode,
  squadMembers,
  squadName,
  reopenPreviousInnings,
  startSecondInnings,
  useDB,
  useMutate,
  voidLastBall,
  type DB,
} from '../../../lib/store';
import { requestSync } from '../../../lib/sync';
import { Btn, Sheet, tapProps, TopBar } from '../../../lib/ui';
import { toDeliveryRow } from '../../../src/db/mappers';
import {
  applyDelivery,
  ballsInCurrentOver,
  ballsUntilEligible,
  bowlerCapFor,
  currentOver,
  eligibleBowlers,
  impactOverIsDefault,
  impactOverOf,
  overAnnouncement,
  resultAnnouncement,
} from '../../../src/engine/engine';
import type {
  Contact,
  DeclaredRuns,
  DeliveryInput,
  DeliveryResult,
  ExtraType,
  InningsState,
  RulesConfig,
  RulesConfigOverride,
  WicketType,
} from '../../../src/engine/types';
import type { InningsRow, MatchRow } from '../../../src/db/database.types';

interface Selection {
  declared: DeclaredRuns | null;
  contact: Contact;
  phys: number;
  extra: ExtraType;
  dot: boolean;
  body: boolean;
}
const EMPTY: Selection = { declared: null, contact: 'none', phys: 0, extra: 'none', dot: false, body: false };

/**
 * Force a selection to be a legal one.
 *
 * Greying keys out is a hint, not a guarantee: the ordering of taps, a
 * re-render, or a stale press can still leave two things set that cannot both
 * be true — a wide with a run off the bat, say, which the engine would then
 * refuse at commit. So every change goes through here and the impossible parts
 * are dropped, whichever way round they were tapped.
 */
function legal(sel: Selection): Selection {
  // A wide is a dead ball: nothing off the bat, nothing run, nothing else.
  if (sel.extra === 'wide') {
    return { ...EMPTY, extra: 'wide' };
  }
  // A body hit is 0 off the bat and always a dot.
  if (sel.body) {
    return { ...EMPTY, body: true, dot: true, extra: 'none' };
  }
  // A dot is nothing at all.
  if (sel.dot) {
    return { ...EMPTY, dot: true };
  }
  // Declared runs must belong to the row they were tapped on.
  if (sel.declared === null && sel.contact !== 'none') {
    return { ...sel, contact: 'none' };
  }
  return sel;
}

const WICKET_LABEL: Record<WicketType, string> = {
  bowled: 'Bowled',
  caught: 'Caught',
  runout: 'Run out',
  stumped: 'Stumped',
  hitwicket: 'Hit wicket',
  dotout: 'Dot out',
  bodyout: 'Body out',
  retired_out: 'Retired out',
  retired_hurt: 'Retired hurt',
};

type SheetName = 'none' | 'wicket' | 'bowler' | 'phys' | 'roster' | 'start' | 'autoout';

export default function ScorePage() {
  const params = useParams<{ matchId: string }>();
  const db = useDB();
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
  return <Pad db={db} match={match} />;
}

function Pad({ db, match }: { db: DB; match: MatchRow }) {
  const mutate = useMutate();
  const rules = matchRules(db, match);
  const innings = matchInnings(db, match.id);
  // The latest in-progress innings, not the first: once the chase starts the
  // pad must follow it even if the first innings row is briefly stale.
  const current =
    [...innings].reverse().find((i) => i.status === 'in_progress') ?? innings[innings.length - 1];

  const [rawSel, setRawSel] = useState<Selection>(EMPTY);
  const sel = legal(rawSel);
  const setSel = (next: Selection | ((s: Selection) => Selection)): void =>
    setRawSel((current) => legal(typeof next === 'function' ? next(legal(current)) : next));
  const [sheet, setSheet] = useState<SheetName>('none');
  const [audio, setAudio] = useState(rules.audioPerBall);
  const [fixing, setFixing] = useState<string | null>(null);
  const [fixingDots, setFixingDots] = useState<string | null>(null);
  const [autoIn, setAutoIn] = useState<string | null>(null);
  const spoken = useRef<string | null>(null);

  const board = current ? scoreboard(db, current, rules) : null;
  const opening = current ? openingOf(db, current.id) : null;

  // R30 — announce the over just finished.
  useEffect(() => {
    if (!audio || !rules.audioPerOver || !board || board.error) return;
    const last = board.results[board.results.length - 1];
    if (!last?.overCompleted || !current) return;
    const key = `${current.id}:${board.results.length}`;
    if (spoken.current === key) return;
    spoken.current = key;
    speak(overAnnouncement(board.state, last.overNo, rules));
  }, [audio, board, current, rules.audioPerOver]);

  if (!current) {
    return (
      <div className="app">
        <TopBar title="Not started" back="/" />
        <div className="pad">
          <div className="note">Run the toss first — the innings is created when the winner chooses.</div>
        </div>
      </div>
    );
  }

  if (!opening || !board) return <StartInnings db={db} match={match} innings={current} />;
  if (board.error) {
    return (
      <div className="app">
        <TopBar title="Replay failed" back="/" />
        <div className="pad">
          <div className="note">{board.error}</div>
        </div>
      </div>
    );
  }

  const state = board.state;
  const results = board.results;
  const over = currentOver(state, rules);
  const inOver = ballsInCurrentOver(state, rules);
  const striker = state.strikerId ? state.batsmen[state.strikerId] : null;
  const nonStriker = state.nonStrikerId ? state.batsmen[state.nonStrikerId] : null;
  const bowler = state.currentBowlerId ? state.bowlers[state.currentBowlerId] : null;
  const needsBowler = state.currentBowlerId === null && state.status === 'in_progress';
  const done = state.status === 'complete';

  // --- R7b interlocks -------------------------------------------------------
  const hasScore = sel.declared !== null || sel.phys > 0;
  const wideSel = sel.extra === 'wide';
  const nbSel = sel.extra === 'noball';
  const runsDisabled = wideSel || sel.dot || sel.body;
  const dotLocked = sel.body; // Body forces Dot on and it cannot be cleared
  const dis = {
    runs: runsDisabled,
    wide: hasScore || sel.dot || sel.body || nbSel,
    // A no ball carries declared and physical runs, so scoring must not grey
    // it out — only a wide, a body hit or a dot rule it out.
    noball: sel.dot || sel.body || wideSel,
    body: hasScore || (sel.dot && !sel.body) || wideSel || nbSel,
    dot: (hasScore || wideSel || nbSel) && !dotLocked,
    wicket: sel.dot && !sel.body,
  };

  const input: DeliveryInput = {
    id: 'preview',
    declaredRuns: sel.declared ?? 0,
    contact: sel.contact,
    physicalRuns: sel.phys,
    extra: sel.extra,
    isBodyHit: sel.body,
  };
  const preview = done || needsBowler ? null : tryApply(state, input, rules);

  const impactBallNext =
    rules.impactBallAllowed && state.legalBalls === rules.oversPerInnings * rules.ballsPerOver - 1;
  const isImpactOver = impactOverOf(state, rules) === over;

  /** Who is left to walk in, by name, so the list reads the same every time. */
  const availableBatsmen = state.battingOrder
    .filter((id) => !state.batsmen[id]?.hasBatted && !state.batsmen[id]?.isOut)
    .sort((a, b) => playerName(db, a).localeCompare(playerName(db, b)));

  // --- commit ---------------------------------------------------------------
  const commit = (wicket?: DeliveryInput['wicket'], chosenIn?: string): void => {
    // R16c — the app records a third dot or third body hit by itself, but the
    // scorer still decides who comes in. Ask before writing the ball, rather
    // than hoping he noticed the preview.
    const incoming = chosenIn ?? autoIn;
    if (!wicket && !incoming && availableBatsmen.length > 1) {
      const auto = tryApplyFull(state, { ...input, id: 'probe' }, rules)?.result.wicket;
      if (auto?.automatic) {
        setSheet('autoout');
        return;
      }
    }
    const id = uuid();
    const real: DeliveryInput = {
      ...input,
      id,
      ...(wicket ? { wicket } : {}),
      // R16c — the app records a third dot or third body hit itself, but the
      // scorer still says who walks in.
      ...(incoming ? { newBatsmanId: incoming } : {}),
    };
    const out = tryApplyFull(state, real, rules);
    if (!out) return;
    mutate((d) => {
      const seq = nextSeq(d, current.id);
      const row = toDeliveryRow(real, out.result, state, { inningsId: current.id, seq });
      return appendDelivery(d, { ...row, is_voided: false, created_at: new Date().toISOString() });
    });
    // The ball is already saved locally; this only asks the loop to get it
    // upstream sooner. Scoring never waits for it.
    requestSync();
    if (audio && rules.audioPerBall) speak(out.result.announcement);
    navigator.vibrate?.(out.result.wicket ? [30, 50, 30] : 10);
    setSel(EMPTY);
    setAutoIn(null);
    setSheet('none');
  };

  // R7d — Undo clears a half-made selection, else steps back a ball. When
  // there is nothing left to step back in this innings and the chase has only
  // just begun, it steps back out of the chase into the innings before it.
  const undo = (): void => {
    if (JSON.stringify(sel) !== JSON.stringify(EMPTY)) {
      setSel(EMPTY);
      return;
    }
    const hasBall = db.deliveries.some((d) => d.innings_id === current.id && !d.is_voided);
    if (!hasBall && current.seq === 2) {
      mutate((d) => reopenPreviousInnings(d, match.id));
      return;
    }
    mutate((d) => voidLastBall(d, current.id));
  };

  const event = (type: Parameters<typeof appendEvent>[3], payload: object = {}): void =>
    mutate((d) => appendEvent(d, match.id, current.id, type, payload));

  const thisOver = results.filter((r) => r.overNo === over);

  /** The ball the next undo would take back. */
  const lastBall = db.deliveries
    .filter((d) => d.innings_id === current.id && !d.is_voided)
    .sort((a, b) => a.seq - b.seq)
    .at(-1);

  return (
    <div className="app">
      {/* header — never moves */}
      <div style={{ padding: '14px 18px 10px', background: 'var(--turf)', borderBottom: '1px solid var(--line)' }}>
        <div className="row">
          <div>
            <Link href="/" className="back" style={{ textDecoration: 'none', marginRight: 6 }}>
              ‹
            </Link>
            <span className="tcode" style={{ fontSize: 15 }}>
              {squadName(db, current.batting_squad_id)}
            </span>{' '}
            <span className="score mid">
              {state.runs}/{state.wickets}
            </span>{' '}
            <span className="sub" style={{ marginLeft: 6 }}>
              ({over}.{inOver} of {rules.oversPerInnings})
            </span>
          </div>
          <div className="miczone">
            <button
              className={`tog ${audio ? 'on' : ''}`}
              style={{ width: 38, height: 22 }}
              {...tapProps(() => {
                setAudio((v) => {
                  if (!v) unlockSpeech(); // must happen inside the gesture
                  return !v;
                });
              })}
            />
            🔊
          </div>
        </div>
        {current.target !== null && (
          <div className="sub" style={{ marginTop: 6 }}>
            needs {Math.max(0, current.target - state.runs)} from{' '}
            {rules.oversPerInnings * rules.ballsPerOver - state.legalBalls} balls
          </div>
        )}
      </div>

      {/* banners */}

      {state.isFreeHit && <div className="banner free">◎ Free hit — run out only</div>}
      {state.lastManActive && (
        <div className="banner last">
          ◆ Last man — {playerName(db, state.strikerId)} faces every ball
          {state.deadrunnerId ? `, ${playerName(db, state.deadrunnerId)} at the other end` : ''}
        </div>
      )}

      {preview?.wicket?.automatic && (
        <>
          <div className="banner last">
            ✕ {preview.wicket.type === 'dotout' ? '3rd straight dot' : '3rd body hit'} —{' '}
            {playerName(db, preview.wicket.playerOutId)} <b>will be out</b> when you save (
            {WICKET_LABEL[preview.wicket.type]})
          </div>
          <div className="pad" style={{ paddingTop: 8 }}>
            <div className="lbl" style={{ margin: '0 0 4px' }}>Who comes in?</div>
            <select
              className="field"
              value={autoIn ?? ''}
              onChange={(e) => setAutoIn(e.target.value || null)}
            >
              <option value="">Next in the order</option>
              {availableBatsmen.map((id) => (
                <option key={id} value={id}>
                  {playerName(db, id)}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      {/* Both batsmen in one box, their pips under their own names; the
          bowler in a box of his own beneath. */}
      <div className="pad" style={{ paddingTop: 6 }}>
        <div className="statbox">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <BatCell
              db={db}
              id={state.strikerId}
              state={state}
              note="on strike"
              onFix={() => setFixing(state.strikerId)}
              onFixDots={() => setFixingDots(state.strikerId)}
            />
            <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--line)' }} />
            <BatCell
              db={db}
              id={state.nonStrikerId}
              state={state}
              note={state.lastManActive ? 'other end' : ''}
              align="right"
              onFix={() => setFixing(state.nonStrikerId)}
              onFixDots={() => setFixingDots(state.nonStrikerId)}
            />
          </div>
        </div>

        <div className="statbox" style={{ marginTop: 6 }}>
          <div className="row">
            <span style={{ fontSize: 13 }}>
              <span className="sub">bowling </span>
              {playerName(db, state.currentBowlerId)}{' '}
              <span style={{ fontFamily: 'var(--font-num)', fontSize: 15 }}>
                {Math.floor((bowler?.legalBalls ?? 0) / rules.ballsPerOver)}.
                {(bowler?.legalBalls ?? 0) % rules.ballsPerOver}-{bowler?.runsConceded ?? 0}-
                {bowler?.wickets ?? 0}
              </span>
            </span>
            <span className="sub">
              {thisOver.length === 0 ? 'new over' : thisOver.map(token).join(' · ')}
            </span>
          </div>
        </div>
      </div>

      {/* The innings being over is not the end of correcting it: undo steps
          back a ball at a time, and keeps stepping. */}
      {done && (
        <div className="pad" style={{ marginTop: 10 }}>
          <Btn className="btn ghost" onTap={undo}>
            Undo the last ball
          </Btn>
          <div className="hint" style={{ marginTop: 6, textAlign: 'center' }}>
            {lastBall
              ? `Takes back ${lastBall.over_no}.${lastBall.ball_no} — ${lastBall.team_runs} run${
                  lastBall.team_runs === 1 ? '' : 's'
                }. Press again to keep going back.`
              : current.seq === 2
                ? 'Goes back into the first innings.'
                : 'Nothing left to take back.'}
          </div>
        </div>
      )}

      {done ? (
        <InningsOver
          db={db}
          match={match}
          innings={current}
          state={state}
          rules={rules}
          say={(line) => {
            if (audio) speak(line);
          }}
        />
      ) : (
        <div className="pad" style={{ marginTop: 12 }}>
          {/* The court. Columns are zones 1, 2 and 3 running away from the
              batsman; the top row is pitched, the bottom direct; the strip
              through the middle is the pitch, tapped once per run they ran. */}
          {/* Doubling shows on the court itself: amber for the impact over,
              red for the single impact ball. */}
          {isImpactOver && !impactBallNext && (
            <div className="impactflag over">
              ⬆ IMPACT OVER — bat runs doubled
              {impactOverIsDefault(state, rules) ? ' (last over, by default)' : ''}
            </div>
          )}
          {impactBallNext && <div className="impactflag ball">◆ IMPACT BALL — this one doubles</div>}

          <div
            className={`court ${impactBallNext ? 'impactball' : isImpactOver ? 'impact' : ''}`}
          >
            <Key
              className="k-wide extra"
              on={wideSel}
              disabled={dis.wide}
              onTap={() => setSel((s) => (s.extra === 'wide' ? EMPTY : { ...EMPTY, extra: 'wide' }))}
            >
              Wide<small>{rules.wideRuns}</small>
            </Key>

            {(
              [
                ['k-z1p', 1, 'pitched', 1],
                ['k-z2p', 2, 'pitched', 2],
                ['k-z3p', 3, 'pitched', 3],
                ['k-z1d', 2, 'direct', 1],
                ['k-z2d', 4, 'direct', 2],
                ['k-z3d', 6, 'direct', 3],
              ] as Array<[string, DeclaredRuns, Contact, number]>
            ).map(([cell, value, contact, zone]) => (
              <Key
                key={cell}
                className={`${cell} ${contact} zone`}
                on={sel.declared === value && sel.contact === contact}
                disabled={dis.runs || (sel.declared !== null && sel.contact !== contact) ||
                          (sel.declared !== null && sel.declared !== value && sel.contact === contact)}
                onTap={() =>
                  setSel((s) =>
                    s.declared === value && s.contact === contact
                      ? { ...s, declared: null, contact: 'none' }
                      : { ...s, declared: value, contact },
                  )
                }
              >
                {value}
                <small>zone {zone}</small>
              </Key>
            ))}

            {/* The pitch is an add-on: it never blocks a zone, and each tap is
                one run they ran. */}
            <Key
              className="k-pitch pitch"
              on={sel.phys > 0}
              disabled={dis.runs}
              onTap={() => setSel((s) => ({ ...s, phys: Math.min(9, s.phys + 1) }))}
              onHold={() => setSel((s) => ({ ...s, phys: 0 }))}
            >
              {/* The ends speak for themselves: plus this side, minus the
                  other, count in the middle. */}
              <span className="pitch-add">+</span>

              <span className="pitch-count">
                {sel.phys}
                <span>{sel.phys === 1 ? 'run' : 'runs'} · tap once per run</span>
              </span>
              <button
                className={`k-minus ${sel.phys > 0 && !dis.runs ? 'live' : ''}`}
                disabled={sel.phys === 0 || dis.runs}
                aria-label="one run fewer"
                onPointerDown={(e) => {
                  // Its own control, so it never counts as a tap on the pitch.
                  e.stopPropagation();
                  navigator.vibrate?.(10);
                  setSel((s) => ({ ...s, phys: Math.max(0, s.phys - 1) }));
                }}
                onPointerUp={(e) => e.stopPropagation()}
              >
                −
              </button>
            </Key>

            <Key
              className="k-noball extra"
              on={nbSel}
              disabled={dis.noball}
              onTap={() =>
                setSel((s) =>
                  s.extra === 'noball' ? { ...s, extra: 'none' } : { ...s, extra: 'noball', dot: false, body: false },
                )
              }
            >
              No ball<small>{rules.noBallRuns}</small>
            </Key>
          </div>

          {/* Impact over · Wicket (wide) · Undo. There is no Dot key: a ball
              with nothing tapped IS a dot, so Save alone records it. */}
          <div
            className="krow"
            style={{
              marginTop: 16,
              gridTemplateColumns: rules.threeBodyOut ? '1fr 1fr 2fr 1fr' : '1fr 2fr 1fr',
            }}
          >
            {rules.impactOverAllowed &&
              (state.impactOverNumber === null ? (
                <Key
                  disabled={inOver > 0 || over >= rules.oversPerInnings - 1}
                  onTap={() => event('impact_over_declared', { overNo: over })}
                >
                  Impact over
                  <small>{inOver > 0 ? 'between overs only' : `over ${over + 1}`}</small>
                </Key>
              ) : (
                <Key
                  on
                  // Once an over is under way the declaration is settled, for
                  // that over and for any other: it cannot be moved mid-over.
                  disabled={inOver > 0 || state.impactOverNumber < over}
                  onTap={() => event('impact_over_undone')}
                >
                  Undo impact
                  <small>
                    {inOver > 0 ? 'between overs only' : `over ${state.impactOverNumber + 1}`}
                  </small>
                </Key>
              ))}

            {rules.threeBodyOut && (
              <Key
                on={sel.body}
                disabled={dis.body}
                onTap={() => setSel((s) => (s.body ? EMPTY : { ...EMPTY, body: true, dot: true }))}
              >
                Body<small>hit pad</small>
              </Key>
            )}

            <Key className="danger" disabled={dis.wicket} onTap={() => setSheet('wicket')}>
              Wicket
            </Key>

            <Key onTap={undo}>Undo</Key>
          </div>

          {/* Runs on this ball, and the commit. */}
          <div className="krow" style={{ gridTemplateColumns: '1fr' }}>
            <div className="k total" style={{ pointerEvents: 'none' }}>
              {preview ? `${preview.teamRuns} run${preview.teamRuns === 1 ? '' : 's'}` : '—'}
              <small>{preview ? ballSummary(sel, preview) : 'pick a bowler'}</small>
            </div>
            <Key
              className="save"
              style={{ minHeight: 56 }}
              disabled={needsBowler || done}
              onTap={() => commit()}
              buzz={preview?.wicket ? [30, 50, 30] : 10}
            >
              {preview?.wicket ? WICKET_LABEL[preview.wicket.type] : preview?.isImpactBall ? 'Save ×2' : 'Save'}
            </Key>
          </div>

          <div className="krow" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
            <Key onTap={() => event('strike_switched_manually')}>Switch side</Key>
            <Key onTap={() => setSheet('bowler')}>Bowler</Key>
            <Key onTap={() => setSheet('roster')}>Roster</Key>
          </div>

          {/* R25a — the last man needs someone to run for him. */}
          {state.lastManActive && rules.lastManHasDeadrunner && !state.deadrunnerId && (
            <div className="note" style={{ marginBottom: 20, borderColor: 'var(--strike)' }}>
              <b>Who stands at the other end?</b> He does not run for{' '}
              {playerName(db, state.strikerId)} — he holds the non-striker&apos;s end, so a run out
              is on at both ends.
              <div className="grid2" style={{ marginTop: 9 }}>
                {squadMembers(db, current.batting_squad_id)
                  .filter((p) => p.id !== state.strikerId)
                  .slice(0, 6)
                  .map((p) => (
                    <Btn
                      key={p.id}
                      className="btn"
                      style={{ fontSize: 18, padding: '11px 6px', minHeight: 58 }}
                      onTap={() => event('deadrunner_set', { playerId: p.id })}
                    >
                      {p.name}
                    </Btn>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* commentary */}
      <div className="pad" style={{ paddingBottom: 24 }}>
        <div className="lbl">This innings</div>
        {results
          .slice(-8)
          .reverse()
          .map((r, i) => (
            <div key={i} className="sub" style={{ padding: '4px 0', borderBottom: '1px solid #1B2A22' }}>
              {r.overNo}.{r.ballNo} — {r.commentary}
            </div>
          ))}
      </div>

      {/* --- sheets --- */}
      {(needsBowler || sheet === 'bowler') && !done && (
        <BowlerSheet
          db={db}
          state={state}
          rules={rules}
          midOver={inOver > 0}
          onPick={(id) => {
            event(inOver > 0 ? 'bowler_replaced_midover' : 'bowler_selected', { bowlerId: id });
            setSheet('none');
          }}
          onClose={needsBowler ? undefined : () => setSheet('none')}
          onUndo={
            lastBall
              ? {
                  label: `Undo ${lastBall.over_no}.${lastBall.ball_no} (${lastBall.team_runs} run${
                    lastBall.team_runs === 1 ? '' : 's'
                  })`,
                  run: undo,
                }
              : undefined
          }
        />
      )}

      {sheet === 'autoout' && preview?.wicket && (
        <Sheet
          title={
            preview.wicket.type === 'dotout'
              ? 'Third dot in a row — who comes in?'
              : 'Third body hit — who comes in?'
          }
          onClose={() => setSheet('none')}
        >
          <div className="hint" style={{ marginBottom: 10 }}>
            {playerName(db, preview.wicket.playerOutId)} is out. Pick the next batsman and the ball
            is scored.
          </div>
          <div style={{ display: 'grid', gap: 7 }}>
            {availableBatsmen.map((id) => (
              <Opt
                key={id}
                onTap={() => {
                  setAutoIn(id);
                  commit(undefined, id);
                }}
                style={{ fontSize: 18, minHeight: 58 }}
              >
                {playerName(db, id)}
              </Opt>
            ))}
          </div>
        </Sheet>
      )}

      {sheet === 'phys' && (
        <Sheet title="How many did they run?" onClose={() => setSheet('none')}>
          <div className="keypad">
            {[2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <button
                key={n}
                {...tapProps(() => {
                  setSel((s) => ({ ...s, phys: n }));
                  setSheet('none');
                })}
              >
                {n}
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {sheet === 'wicket' && (
        <WicketSheet
          db={db}
          state={state}
          sel={sel}
          innings={current}
          onClose={() => setSheet('none')}
          onConfirm={(w) => commit(w)}
        />
      )}

      {fixingDots && (
        <Sheet title={`Dots against ${playerName(db, fixingDots)}`} onClose={() => setFixingDots(null)}>
          <div className="hint" style={{ marginBottom: 12 }}>
            He is on <b>{state.batsmen[fixingDots]?.dotStreak ?? 0}</b> in a row. A dot added by
            mistake would dismiss him at{' '}
            {rules.dotsToOut}, so set the real count here.
          </div>
          <div className="grid3">
            {Array.from({ length: rules.dotsToOut }, (_, n) => n).map((n) => (
              <Opt
                key={n}
                on={(state.batsmen[fixingDots]?.dotStreak ?? 0) === n}
                style={{ fontSize: 20, minHeight: 58 }}
                onTap={() => {
                  event('dot_count_set', { playerId: fixingDots, dots: n });
                  setFixingDots(null);
                }}
              >
                {n}
                <small>{n === 1 ? 'dot' : 'dots'}</small>
              </Opt>
            ))}
          </div>
          {rules.threeDotOut ? null : (
            <div className="note" style={{ marginTop: 12 }}>
              The three-dot rule is off in this match, so the count does not dismiss anybody.
            </div>
          )}
        </Sheet>
      )}

      {fixing && (
        <FixBatsman
          db={db}
          state={state}
          outgoingId={fixing}
          onClose={() => setFixing(null)}
          onPick={(incomingId) => {
            event('batsman_corrected', { outgoingId: fixing, incomingId });
            setFixing(null);
          }}
        />
      )}

      {sheet === 'roster' && (
        <RosterSheet db={db} innings={current} matchId={match.id} onClose={() => setSheet('none')} />
      )}
    </div>
  );
}

// --- pieces -----------------------------------------------------------------

/**
 * A raised key on the court.
 *
 * Tap discrimination lives here too: a drag scrolls, a tap presses. A long
 * press is a second gesture — the pitch uses it to clear the runs it has
 * collected, so there is no separate reset button taking up room.
 */
function Key({
  children,
  className = '',
  on,
  disabled,
  onTap,
  onHold,
  buzz,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  on?: boolean;
  disabled?: boolean;
  onTap: () => void;
  onHold?: () => void;
  buzz?: number | number[];
}) {
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  const held = useRef(false);
  const timer = useRef<number | null>(null);

  const clear = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    down.current = null;
  };

  return (
    <button
      className={`k ${className} ${on ? 'on' : ''}`}
      style={style}
      disabled={disabled}
      onPointerDown={(e) => {
        down.current = { x: e.clientX, y: e.clientY, t: Date.now() };
        held.current = false;
        if (onHold) {
          timer.current = window.setTimeout(() => {
            held.current = true;
            navigator.vibrate?.(20);
            onHold();
          }, 550);
        }
      }}
      onPointerUp={(e) => {
        const from = down.current;
        clear();
        if (!from || held.current) return;
        const moved = Math.hypot(e.clientX - from.x, e.clientY - from.y);
        if (moved > 12) return; // that was a scroll
        navigator.vibrate?.(buzz ?? 10);
        onTap();
      }}
      onPointerCancel={clear}
      onPointerLeave={clear}
    >
      {children}
    </button>
  );
}

function Opt({
  children,
  on,
  disabled,
  onTap,
  style,
}: {
  children: React.ReactNode;
  on?: boolean;
  disabled?: boolean;
  onTap: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      className={`opt ${on ? 'on' : ''}`}
      disabled={disabled}
      style={{ fontSize: 13, ...style }}
      {...tapProps(onTap)}
    >
      {children}
    </button>
  );
}

/** One batsman: name, how he is placed, his score, and his pips below. */
function BatCell({
  db,
  id,
  state,
  note,
  align = 'left',
  onFix,
  onFixDots,
}: {
  db: DB;
  id: string | null;
  state: InningsState;
  note: string;
  align?: 'left' | 'right';
  onFix: () => void;
  onFixDots: () => void;
}) {
  if (!id) return <div style={{ flex: 1 }} />;
  const b = state.batsmen[id];
  const right = align === 'right';
  return (
    <div style={{ flex: 1, minWidth: 0, textAlign: right ? 'right' : 'left' }}>
      {/* Tapping the name is how a mis-tapped batsman gets corrected. */}
      <div style={{ fontSize: 13, whiteSpace: 'nowrap' }} {...tapProps(onFix)}>
        <b>{playerName(db, id)}</b>
        {note && <span className="sub"> ({note})</span>}{' '}
        <span style={{ fontFamily: 'var(--font-num)', fontSize: 16, color: 'var(--sodium)' }}>
          {b?.runs ?? 0}
          <span style={{ fontSize: 12, color: 'var(--muted)' }}> ({b?.ballsFaced ?? 0})</span>
        </span>
      </div>
      {/* The pips are the dot counter. Tapping them is how a wrong one gets
          put right, before it dismisses somebody who does not deserve it. */}
      <div
        className="hist"
        style={{ justifyContent: right ? 'flex-end' : 'flex-start', minHeight: 16, cursor: 'pointer' }}
        {...tapProps(onFixDots)}
      >
        {(b?.ballHistory ?? []).slice(-6).map((pip, i) => (
          <i key={i} className={pip === 'scored' ? 'g' : pip === 'body' ? 'b' : 'd'} />
        ))}
        {(b?.ballHistory ?? []).length === 0 && (
          <span className="sub" style={{ fontSize: 9.5 }}>no balls faced</span>
        )}
      </div>
    </div>
  );
}

/** The wrong man was put at the crease — swap him for the right one. */
function FixBatsman({
  db,
  state,
  outgoingId,
  onClose,
  onPick,
}: {
  db: DB;
  state: InningsState;
  outgoingId: string;
  onClose: () => void;
  onPick: (incomingId: string) => void;
}) {
  const choices = state.battingOrder
    .filter((id) => id !== state.strikerId && id !== state.nonStrikerId && !state.batsmen[id]?.isOut)
    .sort((a, b) => playerName(db, a).localeCompare(playerName(db, b)));
  return (
    <Sheet title={`Replace ${playerName(db, outgoingId)}`} onClose={onClose}>
      <div className="hint" style={{ marginBottom: 10 }}>
        For a mis-tap: this puts someone else at the crease from here on. Runs already scored stay
        with whoever they were credited to — undo the ball instead if they went to the wrong man.
      </div>
      <div className="grid2">
        {choices.map((id) => (
          <Opt key={id} onTap={() => onPick(id)} style={{ fontSize: 18, minHeight: 58 }}>
            {playerName(db, id)}
          </Opt>
        ))}
      </div>
      {choices.length === 0 && <div className="note">Nobody else is available.</div>}
    </Sheet>
  );
}

function Hist({ history }: { history: readonly string[] }) {
  return (
    <div className="hist">
      {history.slice(-6).map((p, i) => (
        <i key={i} className={p === 'scored' ? 'g' : p === 'body' ? 'b' : 'd'} />
      ))}
    </div>
  );
}

function Total({ sel, preview, rules }: { sel: Selection; preview: DeliveryResult | null; rules: RulesConfig }) {
  if (sel.extra === 'wide') return <>Wide — dead ball, re-bowled = <b>{rules.wideRuns}</b></>;
  if (sel.dot && !sel.body) return <>Dot ball = <b>0</b></>;
  if (!preview) return <>—</>;
  const declLabel =
    sel.declared !== null
      ? `declared ${sel.declared} (${sel.contact}, zone ${preview.zone})`
      : sel.body
        ? 'body hit, 0 off the bat'
        : 'declared 0';
  return (
    <>
      {declLabel}
      {sel.phys > 0 && ` + ${sel.phys} ran`}
      {preview.extras > 0 && ` + ${preview.extras}${sel.extra === 'noball' ? ' no ball' : ''}`}
      {preview.multiplier === 2 && <span style={{ color: 'var(--sodium)' }}> ×2</span>} = <b>{preview.teamRuns}</b>
    </>
  );
}

/**
 * The bowler picker.
 *
 * It used to hide anyone who could not bowl, which turned an ordinary rule
 * into a mystery — especially after an undo, when the state has moved and the
 * scorer is looking for a bowler he was watching a moment ago. Everyone in the
 * side is listed now, with the reason underneath if he cannot take the ball.
 */
function BowlerSheet({
  db,
  state,
  rules,
  midOver,
  onPick,
  onClose,
  onUndo,
}: {
  db: DB;
  state: InningsState;
  rules: RulesConfig;
  midOver: boolean;
  onPick: (id: string) => void;
  onClose?: (() => void) | undefined;
  /** Stepping back into the previous over instead of starting a new one. */
  onUndo?: { label: string; run: () => void } | undefined;
}) {
  const squad = [...state.bowlingSquad].sort((a, b) =>
    playerName(db, a).localeCompare(playerName(db, b)),
  );

  return (
    <Sheet title={midOver ? 'Replace the bowler mid-over' : 'Who bowls this over?'} onClose={onClose ?? (() => {})}>
      {midOver && (
        <div className="hint" style={{ marginBottom: 10 }}>
          The replacement finishes the over. Balls already bowled stay with the original bowler.
        </div>
      )}

      <div className="grid2">
        {squad.map((id) => {
          const b = state.bowlers[id];
          const overs = b?.oversCompleted ?? 0;
          const cap = bowlerCapFor(state, id, rules);
          const resting = midOver ? 0 : ballsUntilEligible(state, id, rules);
          const capped = overs >= cap;
          const why = capped
            ? `${overs} over${overs === 1 ? '' : 's'} bowled`
            : resting > 0
              ? `resting ${resting} more ball${resting === 1 ? '' : 's'}`
              : `${overs} over${overs === 1 ? '' : 's'}`;

          return (
            <Btn
              key={id}
              className="btn"
              style={{ fontSize: 18, fontWeight: 600, padding: '12px 6px', minHeight: 62 }}
              disabled={capped || resting > 0}
              onTap={() => onPick(id)}
            >
              {playerName(db, id)}
              <div className="sub" style={{ fontSize: 10, fontWeight: 400, marginTop: 2 }}>
                {why}
              </div>
            </Btn>
          );
        })}
      </div>

      {/* The over is only over until you take a ball back. */}
      {onUndo && !midOver && (
        <Btn className="btn ghost" style={{ marginTop: 12 }} onTap={onUndo.run}>
          {onUndo.label}
        </Btn>
      )}

      {squad.every((id) => {
        const overs = state.bowlers[id]?.oversCompleted ?? 0;
        return overs >= bowlerCapFor(state, id, rules) || (!midOver && ballsUntilEligible(state, id, rules) > 0);
      }) && (
        <div className="note" style={{ marginTop: 12, borderColor: 'var(--sodium-dim)' }}>
          Nobody can take the ball: everyone has either bowled their overs or is still resting. If
          the side is short of bowlers, turn on <b>Let one bowler bowl an extra over</b> in the
          match settings.
        </div>
      )}
    </Sheet>
  );
}

function WicketSheet({
  db,
  state,
  sel,
  innings,
  onClose,
  onConfirm,
}: {
  db: DB;
  state: InningsState;
  sel: Selection;
  innings: InningsRow;
  onClose: () => void;
  onConfirm: (w: NonNullable<DeliveryInput['wicket']>) => void;
}) {
  // What this ball allows:
  //   wide      -> a stumping and nothing else
  //   no ball   -> a run out only
  //   free hit  -> a run out only
  //   runs off the bat -> a run out only; every other dismissal scores 0
  //   nothing tapped   -> everything is on
  const scored = sel.declared !== null || sel.phys > 0;
  const allowed: WicketType[] =
    sel.extra === 'wide'
      ? ['stumped', 'hitwicket']
      : sel.extra === 'noball' || state.isFreeHit || scored
        ? ['runout']
        : ['bowled', 'caught', 'runout', 'stumped', 'hitwicket', 'retired_out', 'retired_hurt'];

  const atCrease = [state.strikerId, state.nonStrikerId].filter((x): x is string => x !== null);
  const available = state.battingOrder
    .filter((id) => !state.batsmen[id]?.hasBatted && !state.batsmen[id]?.isOut)
    .sort((a, b) => playerName(db, a).localeCompare(playerName(db, b)));
  const nextIn = available[0] ?? '';
  const [type, setType] = useState<WicketType>(allowed[0] as WicketType);
  const [outId, setOutId] = useState<string>(state.strikerId ?? '');
  const [fielderId, setFielderId] = useState('');
  const [newId, setNewId] = useState(nextIn);
  const [onStrike, setOnStrike] = useState(false);

  return (
    <Sheet title="Wicket" onClose={onClose}>
      <div className="grid3">
        {allowed.map((t) => (
          <Opt key={t} on={type === t} onTap={() => setType(t)} style={{ fontSize: 12.5 }}>
            {WICKET_LABEL[t]}
          </Opt>
        ))}
      </div>

      {sel.extra === 'wide' && (
        <div className="hint" style={{ marginTop: 10 }}>
          On a wide he can be stumped, or hit his own wicket reaching for it. Nothing else.
        </div>
      )}
      {sel.extra === 'noball' && (
        <div className="hint" style={{ marginTop: 10 }}>Only a run out is possible on a no-ball, and the runs still count.</div>
      )}
      {scored && (
        <div className="hint" style={{ marginTop: 10 }}>
          Runs are on the pad, so a run out is the only dismissal left — every other one scores 0
          off the bat. Clear the runs to pick a different one.
        </div>
      )}
      {!scored && type !== 'runout' && (
        <div className="hint" style={{ marginTop: 10 }}>Every dismissal but a run out scores 0 off the bat.</div>
      )}

      <div className="lbl">Who is out</div>
      <div style={{ display: 'grid', gap: 7 }}>
        {atCrease.map((id) => (
          <Opt key={id} on={outId === id} onTap={() => setOutId(id)} style={{ fontSize: 18, minHeight: 58 }}>
            {playerName(db, id)}
          </Opt>
        ))}
      </div>

      {(type === 'caught' || type === 'runout' || type === 'stumped') && (
        <>
          <div className="lbl">
            {type === 'caught' ? 'Caught by' : type === 'stumped' ? 'Stumped by' : 'Run out by'}
          </div>
          {/* A dropdown, full width: eleven names three-to-a-row was the
              hardest thing on this sheet to pick from in a hurry. */}
          <select className="field" value={fielderId} onChange={(e) => setFielderId(e.target.value)}>
            <option value="">Nobody recorded</option>
            {squadMembers(db, innings.bowling_squad_id).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </>
      )}

      {available.length > 0 && type !== 'retired_hurt' && (
        <>
          <div className="lbl">New batsman</div>
          <select className="field" value={newId} onChange={(e) => setNewId(e.target.value)}>
            {available.map((id) => (
              <option key={id} value={id}>
                {playerName(db, id)}
              </option>
            ))}
          </select>
        </>
      )}

      {/* R26a — the scorer confirms; the app never assumes. */}
      {type === 'runout' && (
        <>
          <div className="lbl">Does the new batsman take strike?</div>
          <div className="grid2">
            <Opt on={onStrike} onTap={() => setOnStrike(true)} style={{ fontSize: 16, minHeight: 56 }}>
              Yes, on strike
            </Opt>
            <Opt on={!onStrike} onTap={() => setOnStrike(false)} style={{ fontSize: 16, minHeight: 56 }}>
              No, other end
            </Opt>
          </div>
        </>
      )}

      <div className="grid2" style={{ marginTop: 14 }}>
        <Btn className="btn ghost" style={{ fontSize: 17, minHeight: 58 }} onTap={onClose}>
          Cancel
        </Btn>
        <Btn
          className="btn danger"
          style={{ fontSize: 17, fontWeight: 700, minHeight: 58 }}
          buzz={[30, 50, 30]}
          onTap={() =>
            onConfirm({
              type,
              playerOutId: outId,
              ...(fielderId ? { fielderId } : {}),
              ...(newId ? { newBatsmanId: newId } : {}),
              ...(type === 'runout' ? { newBatsmanOnStrike: onStrike } : {}),
            })
          }
        >
          Confirm wicket
        </Btn>
      </div>
    </Sheet>
  );
}

/** R1a — add someone to the batting squad mid-match; he joins the bottom. */
function RosterSheet({
  db,
  innings,
  matchId,
  onClose,
}: {
  db: DB;
  innings: InningsRow;
  matchId: string;
  onClose: () => void;
}) {
  const mutate = useMutate();
  const [q, setQ] = useState('');
  const inSquad = new Set(squadMembers(db, innings.batting_squad_id).map((p) => p.id));
  const list = db.players.filter(
    (p) => p.deleted_at === null && !inSquad.has(p.id) && p.name.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <Sheet title="Roster" onClose={onClose}>
      <div className="hint" style={{ marginBottom: 10 }}>
        Adding a player mid-innings puts him at the bottom of the order, stamped to this ball.
      </div>
      <div className="pickerhead">
        <input className="field" placeholder="Search the pool" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="pickerlist">
        {list.slice(0, 20).map((p) => (
          <div key={p.id} className="row" style={{ padding: '8px 2px', borderBottom: '1px solid #1B2A22' }}>
            <span style={{ fontSize: 13.5 }}>{p.name}</span>
            <Btn
              className="btn primary"
              style={{ width: 84, padding: '7px 4px', fontSize: 12 }}
              onTap={() => {
                mutate((d) => {
                  const withSquad = addToSquad(d, innings.batting_squad_id, p.id);
                  return appendEvent(withSquad, matchId, innings.id, 'squad_player_added', { playerId: p.id });
                });
                onClose();
              }}
            >
              Add
            </Btn>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * Openers and the first bowler.
 *
 * One list, not two: tap the two men going out and the first one tapped takes
 * strike. Two lists meant reading the same names twice and deciding "striker"
 * and "non-striker" separately, which is not how anyone thinks about it — you
 * just know who is opening. Strike can be swapped on the pad anyway.
 */
function StartInnings({ db, match, innings }: { db: DB; match: MatchRow; innings: InningsRow }) {
  const mutate = useMutate();
  const batting = squadMembers(db, innings.batting_squad_id);
  const bowling = squadMembers(db, innings.bowling_squad_id);
  const [openers, setOpeners] = useState<string[]>([]);
  const [bowler, setBowler] = useState('');

  const pick = (id: string): void =>
    setOpeners((current) =>
      current.includes(id)
        ? current.filter((x) => x !== id)
        : current.length < 2
          ? [...current, id]
          : [current[1] as string, id], // a third tap replaces the older pick
    );

  const [strikerId, nonStrikerId] = openers;
  const ready = openers.length === 2 && bowler !== '';

  return (
    <div className="app">
      <TopBar title={`Innings ${innings.seq} — ${squadName(db, innings.batting_squad_id)}`} back="/" />
      <div className="pad">
        {innings.target !== null && (
          <div className="note" style={{ marginBottom: 12 }}>
            Chasing <b>{innings.target}</b>.
          </div>
        )}

        {/* Two to a row, not three: a full name in a third of a phone is a
            squint, and this is the screen where picking the wrong man costs
            you the whole innings. */}
        <div className="lbl" style={{ fontSize: 13 }}>
          The two opening batsmen — <b>first tapped takes strike</b>
        </div>
        <div className="grid2">
          {batting.map((p) => {
            const at = openers.indexOf(p.id);
            return (
              <Opt
                key={p.id}
                on={at >= 0}
                onTap={() => pick(p.id)}
                style={{ fontSize: 18, minHeight: 60 }}
              >
                {p.name}
                {at === 0 && <small>on strike</small>}
                {at === 1 && <small>other end</small>}
              </Opt>
            );
          })}
        </div>

        <div className="lbl" style={{ fontSize: 13 }}>Opening bowler</div>
        <div className="grid2">
          {bowling.map((p) => (
            <Opt
              key={p.id}
              on={bowler === p.id}
              onTap={() => setBowler(p.id)}
              style={{ fontSize: 18, minHeight: 60 }}
            >
              {p.name}
            </Opt>
          ))}
        </div>

        <Btn
          className="btn primary"
          style={{ marginTop: 16, marginBottom: 24 }}
          disabled={!ready}
          onTap={() =>
            mutate((d) =>
              appendEvent(d, match.id, innings.id, 'innings_start', {
                strikerId,
                nonStrikerId,
                bowlerId: bowler,
              }),
            )
          }
        >
          {openers.length === 0
            ? 'Pick the two opening batsmen'
            : openers.length === 1
              ? 'Pick one more batsman'
              : bowler === ''
                ? 'Pick the opening bowler'
                : 'Start the innings'}
        </Btn>
      </div>
    </div>
  );
}

/** R28 / R29 — end of an innings: start the chase, or settle the match. */
function InningsOver({
  db,
  match,
  innings,
  state,
  rules,
  say,
}: {
  db: DB;
  match: MatchRow;
  innings: InningsRow;
  state: InningsState;
  rules: RulesConfig;
  say: (line: string) => void;
}) {
  const mutate = useMutate();
  const all = matchInnings(db, match.id);
  const first = all.find((i) => i.seq === 1);
  const firstBoard = first ? scoreboard(db, first, rules) : null;

  if (innings.seq === 1) {
    return (
      <div className="pad" style={{ marginTop: 14 }}>
        <div className="note" style={{ marginBottom: 12 }}>
          Innings closed — <b>{state.runs}/{state.wickets}</b> ({state.endReason?.replace('_', ' ')}).
        </div>
        <Btn className="btn primary" onTap={() => mutate((d) => startSecondInnings(d, match.id, state.runs))}>
          Start the chase — {squadName(db, innings.bowling_squad_id)} need {state.runs + 1}
        </Btn>
      </div>
    );
  }

  const targetRuns = firstBoard && !firstBoard.error ? firstBoard.state.runs : 0;
  const chased = state.runs > targetRuns;
  const tied = state.runs === targetRuns;
  const winner = tied ? null : chased ? innings.batting_squad_id : innings.bowling_squad_id;
  // Wickets in hand: the squad loses all but one, unless last man is on, in
  // which case the last batsman's wicket counts too.
  const allWickets = state.battingOrder.length - (state.lastManEnabled ? 0 : 1);
  const inHand = Math.max(0, allWickets - state.wickets);
  const margin = targetRuns - state.runs;
  const text = tied
    ? 'Match tied'
    : chased
      ? `${squadName(db, innings.batting_squad_id)} won by ${inHand} ${inHand === 1 ? 'wicket' : 'wickets'}`
      : `${squadName(db, innings.bowling_squad_id)} won by ${margin} ${margin === 1 ? 'run' : 'runs'}`;

  return (
    <div className="pad" style={{ marginTop: 14 }}>
      <div className="card" style={{ textAlign: 'center' }}>
        <div className="sub">result</div>
        <div className="score mid" style={{ margin: '6px 0', fontSize: 22 }}>{text}</div>
        <div className="sub">
          {squadCode(db, innings.bowling_squad_id)} {targetRuns} · {squadCode(db, innings.batting_squad_id)}{' '}
          {state.runs}/{state.wickets}
        </div>
      </div>
      {match.status !== 'completed' ? (
        <Btn
          className="btn primary"
          style={{ marginTop: 12 }}
          onTap={() => {
            mutate((d) => completeMatch(d, match.id, winner, text));
            // R30 — call the result: won by so many wickets, or so many runs.
            say(resultAnnouncement(text));
          }}
        >
          Save the result
        </Btn>
      ) : (
        <NextMatch db={db} match={match} />
      )}
    </div>
  );
}

/**
 * With the result saved, the obvious next thing is the next match of the
 * weekend. It inherits the series settings, and the toss (or the winner's
 * choice) happens on the series screen.
 */
function NextMatch({ db, match }: { db: DB; match: MatchRow }) {
  const mutate = useMutate();
  const router = useRouter();
  const series = db.series.find((s) => s.id === match.series_id);
  if (!series) return null;

  const inSeries = db.matches.filter((m) => m.series_id === series.id);
  const played = inSeries.filter((m) => m.status === 'completed').length;
  const pending = inSeries.find((m) => m.status !== 'completed');
  const wins = new Map<string, number>();
  for (const m of inSeries) {
    if (m.winner_squad_id) wins.set(m.winner_squad_id, (wins.get(m.winner_squad_id) ?? 0) + 1);
  }
  const scoreline = db.squads
    .filter((s) => s.series_id === series.id)
    .map((s) => `${squadCode(db, s.id)} ${wins.get(s.id) ?? 0}`)
    .join(' — ');

  return (
    <div style={{ marginTop: 12 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="sub">
          {series.name} · {played} of {series.planned_matches} played
        </span>
        <span className="chip amber">{scoreline}</span>
      </div>

      {pending ? (
        <Link href={`/admin/series/${series.id}`} style={{ textDecoration: 'none' }}>
          <button className="btn primary">Match {pending.match_no} is waiting — go to the toss</button>
        </Link>
      ) : (
        <Btn
          className="btn primary"
          onTap={() => {
            mutate((d) => {
              // Beyond the planned count, extend the series rather than block.
              const extended =
                played >= series.planned_matches ? extendSeries(d, series.id, played + 1) : d;
              return createMatch(
                extended,
                series.id,
                (series.rules_config ?? {}) as RulesConfigOverride,
                match.venue ?? '',
              ).db;
            });
            router.push(`/admin/series/${series.id}`);
          }}
        >
          {played >= series.planned_matches
            ? `Add match ${played + 1} — beyond the ${series.planned_matches} planned`
            : `Start match ${played + 1} of ${series.planned_matches}`}
        </Btn>
      )}

      <Link href={`/admin/series/${series.id}`} style={{ textDecoration: 'none' }}>
        <button className="btn ghost" style={{ marginTop: 9 }}>
          Series and squads
        </button>
      </Link>
    </div>
  );
}

// --- helpers ----------------------------------------------------------------

function tryApply(state: InningsState, input: DeliveryInput, rules: RulesConfig): DeliveryResult | null {
  return tryApplyFull(state, input, rules)?.result ?? null;
}

function tryApplyFull(
  state: InningsState,
  input: DeliveryInput,
  rules: RulesConfig,
): { state: InningsState; result: DeliveryResult } | null {
  try {
    return applyDelivery(state, input, rules);
  } catch {
    return null;
  }
}

/** The one-line reading of what is currently on the pad. */
function ballSummary(sel: Selection, r: DeliveryResult): string {
  if (sel.extra === 'wide') return 'wide — re-bowled, nothing off the bat';
  const bits: string[] = [];
  if (sel.extra === 'noball') bits.push('no ball');
  if (sel.body) bits.push('body hit');
  if (sel.declared !== null) bits.push(`${sel.declared} ${sel.contact} · zone ${r.zone}`);
  if (sel.phys > 0) bits.push(`${sel.phys} ran`);
  if (sel.dot && !sel.body) bits.push('dot');
  if (r.multiplier === 2 && r.batRuns > 0) bits.push('doubled');
  bits.push(r.strikeChanged ? 'strike changes' : 'same end');
  return bits.join(' · ');
}

function token(r: DeliveryResult): string {
  if (r.wicket) return 'W';
  if (r.contact === 'none' && r.extras > 0) return r.teamRuns === 1 ? 'wd' : `nb${r.teamRuns}`;
  return String(r.teamRuns);
}

function uuid(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/**
 * iOS will not speak until speechSynthesis has been used inside a real user
 * gesture, and it stays silent forever if the first call comes from a timer or
 * a network callback. So the audio toggle primes it with a silent utterance,
 * and everything after that works.
 */
function unlockSpeech(): void {
  try {
    const u = new SpeechSynthesisUtterance('');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch {
    /* nothing to unlock on this browser */
  }
}

function speak(line: string): void {
  try {
    if (typeof speechSynthesis === 'undefined') return;
    // A queue left paused by a backgrounded tab is the other common cause of
    // silence on a phone.
    if (speechSynthesis.paused) speechSynthesis.resume();
    const u = new SpeechSynthesisUtterance(line);
    u.rate = 1.15;
    u.lang = 'en-IN';
    speechSynthesis.speak(u);
  } catch {
    /* audio is never allowed to break scoring */
  }
}
