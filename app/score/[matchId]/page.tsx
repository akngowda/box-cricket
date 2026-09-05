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
  squadCode,
  squadMembers,
  squadName,
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

const WICKET_LABEL: Record<WicketType, string> = {
  bowled: 'Bowled',
  caught: 'Caught',
  runout: 'Run out',
  stumped: 'Stumped',
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

  const [sel, setSel] = useState<Selection>(EMPTY);
  const [sheet, setSheet] = useState<SheetName>('none');
  const [audio, setAudio] = useState(rules.audioPerBall);
  const [fixing, setFixing] = useState<string | null>(null);
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

  /** Who is left to walk in, in batting order. */
  const availableBatsmen = state.battingOrder.filter(
    (id) => !state.batsmen[id]?.hasBatted && !state.batsmen[id]?.isOut,
  );

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

  // R7d — Undo clears a half-made selection, else voids the last ball.
  const undo = (): void => {
    if (JSON.stringify(sel) !== JSON.stringify(EMPTY)) {
      setSel(EMPTY);
      return;
    }
    mutate((d) => voidLastBall(d, current.id));
  };

  const event = (type: Parameters<typeof appendEvent>[3], payload: object = {}): void =>
    mutate((d) => appendEvent(d, match.id, current.id, type, payload));

  const thisOver = results.filter((r) => r.overNo === over);

  return (
    <div className="app">
      {/* header — never moves */}
      <div style={{ padding: '14px 18px 10px', background: 'var(--turf)', borderBottom: '1px solid var(--line)' }}>
        <div className="row">
          <div>
            <Link href="/" className="back" style={{ textDecoration: 'none', marginRight: 6 }}>
              ‹
            </Link>
            <span className="tcode">{squadCode(db, current.batting_squad_id)}</span>{' '}
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
      {impactOverOf(state, rules) === over && (
        <div className="banner impact">
          ⬆ Impact over{impactOverIsDefault(state, rules) ? ' by default — nothing was declared' : ''} — bat runs
          doubled{rules.doubleExtrasOnImpact ? ' (extras too)' : ' (extras not)'}
        </div>
      )}
      {state.isFreeHit && <div className="banner free">◎ Free hit — run out only</div>}
      {state.lastManActive && (
        <div className="banner last">
          ◆ Last man — {playerName(db, state.strikerId)} faces every ball
          {state.deadrunnerId ? `, ${playerName(db, state.deadrunnerId)} at the other end` : ''}
        </div>
      )}
      {impactBallNext && !done && <div className="banner impact">◆ Next legal ball is the impact ball ×2</div>}
      {preview?.wicket?.automatic && (
        <>
          <div className="banner last">
            ✕ {preview.wicket.type === 'dotout' ? '3rd straight dot' : '3rd body hit'} —{' '}
            {playerName(db, preview.wicket.playerOutId)} is OUT ({WICKET_LABEL[preview.wicket.type]})
          </div>
          <div className="pad" style={{ paddingTop: 8 }}>
            <div className="lbl" style={{ margin: '0 0 4px' }}>Who comes in?</div>
            <div className="grid3">
              {availableBatsmen.map((id) => (
                <Opt key={id} on={autoIn === id} onTap={() => setAutoIn(id)} style={{ fontSize: 12 }}>
                  {playerName(db, id)}
                </Opt>
              ))}
            </div>
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
            />
            <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--line)' }} />
            <BatCell
              db={db}
              id={state.nonStrikerId}
              state={state}
              note={state.lastManActive ? 'other end' : ''}
              align="right"
              onFix={() => setFixing(state.nonStrikerId)}
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
          <div className="key" style={{ marginBottom: 8 }}>
            <span><i style={{ background: 'var(--sodium)' }} />pitched</span>
            <span><i style={{ background: '#E8663A' }} />direct</span>
            <span><i style={{ background: 'var(--cool)' }} />physical</span>
          </div>

          {/* Row 1 — declared, two rows, two colours */}
          <div className="lbl">
            Declared runs{' '}
            <span style={{ opacity: 0.6 }}>— row shows pitched vs direct · zone 0 = Dot</span>
          </div>
          {(
            [
              [[1, 2, 3], 'pitched'],
              [[2, 4, 6], 'direct'],
            ] as Array<[DeclaredRuns[], Contact]>
          ).map(([vals, contact], rowIdx) => (
            <div
              key={contact}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 9, marginTop: rowIdx ? 8 : 0 }}
            >
              {vals.map((v, i) => (
                <button
                  key={`${contact}${v}`}
                  className={`declbtn ${contact} ${sel.declared === v && sel.contact === contact ? 'on' : ''}`}
                  disabled={dis.runs}
                  {...tapProps(() => setSel((s) =>
                      s.declared === v && s.contact === contact
                        ? { ...s, declared: null, contact: 'none' }
                        : { ...s, declared: v, contact },
                    )
                  )}
                >
                  {v}
                  <small>zone {i + 1}</small>
                </button>
              ))}
            </div>
          ))}

          {/* Row 2 — physical runs, Dot first */}
          <div className="lbl">
            Physical runs <span style={{ opacity: 0.6 }}>— tap again to clear back to 0</span>
          </div>
          <div className="grid3">
            <button
              className={`physbtn dotbtn ${sel.dot ? 'on' : ''}`}
              disabled={dis.dot}
              {...tapProps(() => setSel((s) => (s.dot ? EMPTY : { ...EMPTY, dot: true })))}
            >
              Dot<small>{dotLocked ? 'body hit' : '0 & 0'}</small>
            </button>
            <button
              className={`physbtn ${sel.phys === 1 ? 'on' : ''}`}
              disabled={dis.runs}
              {...tapProps(() => setSel((s) => ({ ...s, phys: s.phys === 1 ? 0 : 1 })))}
            >
              1
            </button>
            <button
              className={`physbtn ${sel.phys > 1 ? 'on' : ''}`}
              disabled={dis.runs}
              {...tapProps(() => (sel.phys > 1 ? setSel((s) => ({ ...s, phys: 0 })) : setSheet('phys')))}
            >
              {sel.phys > 1 ? (
                <>
                  {sel.phys}
                  <small>ran{sel.phys % 2 === 1 ? ' · strike ↔' : ''}</small>
                </>
              ) : (
                <>
                  custom<small>&lt;10</small>
                </>
              )}
            </button>
          </div>

          {/* Extras, body, wicket and undo — under the runs, because the runs
              are what gets tapped on nearly every ball. The gap keeps a
              mis-aimed thumb off the wicket button. */}
          <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: `repeat(${rules.threeBodyOut ? 5 : 4},1fr)`, gap: 9 }}>
            <Opt on={wideSel} disabled={dis.wide} onTap={() => setSel((s) => (s.extra === 'wide' ? EMPTY : { ...EMPTY, extra: 'wide' }))}>
              Wide<small>{rules.wideRuns}</small>
            </Opt>
            <Opt on={nbSel} disabled={dis.noball} onTap={() => setSel((s) => (s.extra === 'noball' ? { ...s, extra: 'none' } : { ...s, extra: 'noball', dot: false, body: false }))}>
              No ball<small>{rules.noBallRuns}</small>
            </Opt>
            {/* R17a — the Body marker exists only when the rule is on. */}
            {rules.threeBodyOut && (
              <Opt on={sel.body} disabled={dis.body} onTap={() => setSel((s) => (s.body ? EMPTY : { ...EMPTY, body: true, dot: true }))}>
                Body<small>hit pad</small>
              </Opt>
            )}
            <Opt disabled={dis.wicket} onTap={() => setSheet('wicket')} style={{ color: 'var(--strike)', fontSize: 13 }}>
              Wicket
            </Opt>
            <Opt onTap={undo} style={{ fontSize: 13 }}>Undo</Opt>
          </div>

          {/* The live total for this ball */}
          <div className="preview" style={{ marginTop: 13 }}>
            <Total sel={sel} preview={preview} rules={rules} />
            <div style={{ marginTop: 3, fontSize: 11 }}>
              {wideSel
                ? 're-bowled'
                : sel.dot
                  ? 'counts as a dot'
                  : `${preview?.strikeChanged ? 'strike changes' : 'same batsman on strike'}${
                      state.lastManActive ? ' · last man faces every ball' : ''
                    }`}
            </div>
          </div>

          <Btn
            className="btn primary"
            style={{ margin: '13px 0 6px', ...(preview?.isImpactBall ? { background: 'var(--strike)', color: '#fff' } : {}) }}
            disabled={needsBowler}
            buzz={preview?.wicket ? [30, 50, 30] : 10}
            onTap={() => commit()}
          >
            {needsBowler
              ? 'Pick a bowler first'
              : preview?.wicket
                ? `Score — ${WICKET_LABEL[preview.wicket.type]}`
                : preview?.isImpactBall
                  ? 'Score impact ball ×2'
                  : 'Score'}
          </Btn>

          <div className="grid3" style={{ marginBottom: 8 }}>
            <Btn className="btn ghost" style={{ fontSize: 12, padding: '11px 4px' }} onTap={() => event('strike_switched_manually')}>
              Switch strike
            </Btn>
            <Btn className="btn ghost" style={{ fontSize: 12, padding: '11px 4px' }} onTap={() => setSheet('bowler')}>
              Bowler
            </Btn>
            <Btn className="btn ghost" style={{ fontSize: 12, padding: '11px 4px' }} onTap={() => setSheet('roster')}>
              Roster
            </Btn>
          </div>

          {/* R20 / R20e */}
          {rules.impactOverAllowed &&
            (state.impactOverNumber === null ? (
              <>
                <Btn
                  className="btn ghost"
                  disabled={inOver > 0 || over >= rules.oversPerInnings - 1}
                  onTap={() => event('impact_over_declared', { overNo: inOver > 0 ? over + 1 : over })}
                >
                  {inOver > 0 ? 'Declare impact over (only between overs)' : `Declare impact over ${over + 1}`}
                </Btn>
                <div className="hint" style={{ margin: '7px 0 20px', textAlign: 'center' }}>
                  Nothing declared yet — the last over (over {rules.oversPerInnings}) doubles by default.
                </div>
              </>
            ) : (
              <Btn
                className="btn ghost"
                style={{ marginBottom: 20 }}
                disabled={state.impactOverNumber < over || (state.impactOverNumber === over && inOver > 0)}
                onTap={() => event('impact_over_undone')}
              >
                Undo impact over {state.impactOverNumber + 1}
              </Btn>
            ))}

          {/* R25a — the last man needs someone to run for him. */}
          {state.lastManActive && rules.lastManHasDeadrunner && !state.deadrunnerId && (
            <div className="note" style={{ marginBottom: 20, borderColor: 'var(--strike)' }}>
              <b>Who stands at the other end?</b> He does not run for{' '}
              {playerName(db, state.strikerId)} — he holds the non-striker&apos;s end, so a run out
              is on at both ends.
              <div className="grid3" style={{ marginTop: 9 }}>
                {squadMembers(db, current.batting_squad_id)
                  .filter((p) => p.id !== state.strikerId)
                  .slice(0, 6)
                  .map((p) => (
                    <Btn key={p.id} className="btn" style={{ fontSize: 12, padding: '9px 4px' }} onTap={() => event('deadrunner_set', { playerId: p.id })}>
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
          <div className="grid3">
            {availableBatsmen.map((id) => (
              <Opt
                key={id}
                onTap={() => {
                  setAutoIn(id);
                  commit(undefined, id);
                }}
                style={{ fontSize: 12 }}
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
}: {
  db: DB;
  id: string | null;
  state: InningsState;
  note: string;
  align?: 'left' | 'right';
  onFix: () => void;
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
      <div className="hist" style={{ justifyContent: right ? 'flex-end' : 'flex-start' }}>
        {(b?.ballHistory ?? []).slice(-6).map((pip, i) => (
          <i key={i} className={pip === 'scored' ? 'g' : pip === 'body' ? 'b' : 'd'} />
        ))}
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
  const choices = state.battingOrder.filter(
    (id) => id !== state.strikerId && id !== state.nonStrikerId && !state.batsmen[id]?.isOut,
  );
  return (
    <Sheet title={`Replace ${playerName(db, outgoingId)}`} onClose={onClose}>
      <div className="hint" style={{ marginBottom: 10 }}>
        For a mis-tap: this puts someone else at the crease from here on. Runs already scored stay
        with whoever they were credited to — undo the ball instead if they went to the wrong man.
      </div>
      <div className="grid3">
        {choices.map((id) => (
          <Opt key={id} onTap={() => onPick(id)} style={{ fontSize: 12 }}>
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

function BowlerSheet({
  db,
  state,
  rules,
  midOver,
  onPick,
  onClose,
}: {
  db: DB;
  state: InningsState;
  rules: RulesConfig;
  midOver: boolean;
  onPick: (id: string) => void;
  onClose?: (() => void) | undefined;
}) {
  // R20b is intrinsic: he is simply not in the list.
  const eligible = midOver
    ? state.bowlingSquad.filter((id) => (state.bowlers[id]?.oversCompleted ?? 0) < rules.maxOversPerBowler)
    : eligibleBowlers(state, rules);
  return (
    <Sheet title={midOver ? 'Replace the bowler mid-over' : 'Who bowls this over?'} onClose={onClose ?? (() => {})}>
      <div className="hint" style={{ marginBottom: 10 }}>
        {midOver
          ? 'The replacement finishes the over. Balls already bowled stay with the original bowler.'
          : `No two overs in a row, and ${rules.maxOversPerBowler} overs each at most.`}
      </div>
      <div className="grid3">
        {eligible.map((id) => (
          <Btn key={id} className="btn" style={{ fontSize: 13, padding: '12px 4px' }} onTap={() => onPick(id)}>
            {playerName(db, id)}
            <div className="sub" style={{ fontSize: 10, fontWeight: 400 }}>
              {state.bowlers[id]?.oversCompleted ?? 0} ov
            </div>
          </Btn>
        ))}
      </div>
      {eligible.length === 0 && <div className="note">Nobody is eligible — everyone has bowled their overs.</div>}
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
      ? ['stumped']
      : sel.extra === 'noball' || state.isFreeHit || scored
        ? ['runout']
        : ['bowled', 'caught', 'runout', 'stumped', 'retired_out', 'retired_hurt'];

  const atCrease = [state.strikerId, state.nonStrikerId].filter((x): x is string => x !== null);
  const nextIn = state.battingOrder.find((id) => !state.batsmen[id]?.hasBatted && !state.batsmen[id]?.isOut) ?? '';
  const [type, setType] = useState<WicketType>(allowed[0] as WicketType);
  const [outId, setOutId] = useState<string>(state.strikerId ?? '');
  const [fielderId, setFielderId] = useState('');
  const [newId, setNewId] = useState(nextIn);
  const [onStrike, setOnStrike] = useState(false);

  const available = state.battingOrder.filter((id) => !state.batsmen[id]?.hasBatted && !state.batsmen[id]?.isOut);

  return (
    <Sheet title="Wicket" onClose={onClose}>
      <div className="grid3">
        {allowed.map((t) => (
          <Opt key={t} on={type === t} onTap={() => setType(t)} style={{ fontSize: 12 }}>
            {WICKET_LABEL[t]}
          </Opt>
        ))}
      </div>

      {sel.extra === 'wide' && (
        <div className="hint" style={{ marginTop: 10 }}>A wide allows a stumping and nothing else.</div>
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
      <div className="grid2">
        {atCrease.map((id) => (
          <Opt key={id} on={outId === id} onTap={() => setOutId(id)} style={{ fontSize: 13 }}>
            {playerName(db, id)}
          </Opt>
        ))}
      </div>

      {(type === 'caught' || type === 'runout' || type === 'stumped') && (
        <>
          <div className="lbl">Fielder</div>
          <div className="grid3">
            {squadMembers(db, innings.bowling_squad_id).map((p) => (
              <Opt
                key={p.id}
                on={fielderId === p.id}
                onTap={() => setFielderId(fielderId === p.id ? '' : p.id)}
                style={{ fontSize: 12 }}
              >
                {p.name}
              </Opt>
            ))}
          </div>
        </>
      )}

      {available.length > 0 && type !== 'retired_hurt' && (
        <>
          <div className="lbl">New batsman</div>
          <div className="grid3">
            {available.map((id) => (
              <Opt key={id} on={newId === id} onTap={() => setNewId(id)} style={{ fontSize: 12 }}>
                {playerName(db, id)}
              </Opt>
            ))}
          </div>
        </>
      )}

      {/* R26a — the scorer confirms; the app never assumes. */}
      {type === 'runout' && (
        <>
          <div className="lbl">Does the new batsman take strike?</div>
          <div className="grid2">
            <Opt on={onStrike} onTap={() => setOnStrike(true)} style={{ fontSize: 12 }}>
              Yes, on strike
            </Opt>
            <Opt on={!onStrike} onTap={() => setOnStrike(false)} style={{ fontSize: 12 }}>
              No, other end
            </Opt>
          </div>
        </>
      )}

      <div className="grid2" style={{ marginTop: 14 }}>
        <Btn className="btn ghost" onTap={onClose}>
          Cancel
        </Btn>
        <Btn
          className="btn danger"
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

/** The innings cannot start until the openers and the first bowler are known. */
function StartInnings({ db, match, innings }: { db: DB; match: MatchRow; innings: InningsRow }) {
  const mutate = useMutate();
  const batting = squadMembers(db, innings.batting_squad_id);
  const bowling = squadMembers(db, innings.bowling_squad_id);
  const [striker, setStriker] = useState(batting[0]?.id ?? '');
  const [nonStriker, setNonStriker] = useState(batting[1]?.id ?? '');
  const [bowler, setBowler] = useState(bowling[0]?.id ?? '');

  const ready = striker && nonStriker && bowler && striker !== nonStriker;

  return (
    <div className="app">
      <TopBar title={`Innings ${innings.seq} — ${squadName(db, innings.batting_squad_id)}`} back="/" />
      <div className="pad">
        {innings.target !== null && (
          <div className="note" style={{ marginBottom: 12 }}>
            Chasing <b>{innings.target}</b>.
          </div>
        )}
        <div className="lbl">On strike</div>
        <Picker options={batting} value={striker} onPick={setStriker} />
        <div className="lbl">Non-striker</div>
        <Picker options={batting.filter((p) => p.id !== striker)} value={nonStriker} onPick={setNonStriker} />
        <div className="lbl">Opening bowler</div>
        <Picker options={bowling} value={bowler} onPick={setBowler} />

        <Btn
          className="btn primary"
          style={{ marginTop: 16, marginBottom: 24 }}
          disabled={!ready}
          onTap={() =>
            mutate((d) =>
              appendEvent(d, match.id, innings.id, 'innings_start', {
                strikerId: striker,
                nonStrikerId: nonStriker,
                bowlerId: bowler,
              }),
            )
          }
        >
          Start the innings
        </Btn>
      </div>
    </div>
  );
}

function Picker({
  options,
  value,
  onPick,
}: {
  options: Array<{ id: string; name: string }>;
  value: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="grid3">
      {options.map((p) => (
        <Opt key={p.id} on={value === p.id} onTap={() => onPick(p.id)} style={{ fontSize: 12 }}>
          {p.name}
        </Opt>
      ))}
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
