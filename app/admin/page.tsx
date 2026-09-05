'use client';

/**
 * Phase 3 — the admin hub: the player pool, the general settings (R0) and the
 * weekend series list.
 *
 * There is no login yet (Supabase Auth arrives with Phase 5), so this is open.
 * The RLS in supabase/migrations/0002_rls.sql is what will gate it for real.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { isAdmin, isSuperAdmin, normalise, SUPER_ADMIN } from '../../lib/auth';
import { useSession, useSignInWithPassword, useSignOut } from '../../lib/session';
import { isRemote, supabase } from '../../lib/supabase';
import { forcePull } from '../../lib/sync';
import { fill, RulesEditor } from '../../lib/settings';
import {
  activity,
  addAdmin,
  addJersey,
  addPlayer,
  createSeries,
  deleteAllTestSeries,
  deletePlayer,
  renamePlayer,
  generalSettings,
  removeAdmin,
  resetAll,
  saveGeneralSettings,
  squadMembers,
  useDB,
  useMutate,
} from '../../lib/store';
import { Btn, NumberPicker, Sheet, TabBar, tapProps, Toggle, TopBar } from '../../lib/ui';
import type { RulesConfig } from '../../src/engine/types';

type Panel = 'none' | 'pool' | 'settings' | 'series' | 'jersey' | 'admins' | 'activity';

export default function Admin() {
  const db = useDB();
  const mutate = useMutate();
  const session = useSession();
  const signOut = useSignOut();
  const [panel, setPanel] = useState<Panel>('none');
  const email = session.email;

  const activePlayers = db.players.filter((p) => p.deleted_at === null);

  // The only thing that opens this screen is an admin role read from the
  // database. There is deliberately no offline or local fallback: without a
  // real session there is no admin, so a stale browser cannot let anyone in.
  const admin = isRemote && session.role === 'admin';

  if (session.loading) {
    return (
      <div className="app">
        <TopBar title="Admin" back="/" />
        <div className="pad">
          <div className="sub">Checking your session…</div>
        </div>
      </div>
    );
  }
  if (!admin) return <SignIn email={email} />;

  return (
    <div className="app">
      <TopBar
        title="Admin"
        back="/"
        right={<span className="chip">{isSuperAdmin(email) ? 'super admin' : 'admin'}</span>}
      />

      <div className="pad">
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="sub">Signed in as {email}</span>
          <Btn
            className="btn ghost"
            style={{ width: 90, padding: '7px 4px', fontSize: 12 }}
            onTap={() => void signOut()}
          >
            Sign out
          </Btn>
        </div>

        <div className="grid2">
          <Btn className="btn" onTap={() => setPanel('pool')}>
            Player pool
            <div className="sub" style={{ marginTop: 3, fontWeight: 400 }}>{activePlayers.length} in the pool</div>
          </Btn>
          <Btn className="btn" onTap={() => setPanel('settings')}>
            General settings
            <div className="sub" style={{ marginTop: 3, fontWeight: 400 }}>the baseline for every series</div>
          </Btn>
        </div>

        <div className="grid2" style={{ marginTop: 9 }}>
          <Btn className="btn" onTap={() => setPanel('activity')}>
            Activity
            <div className="sub" style={{ marginTop: 3, fontWeight: 400 }}>
              {db.audit.length} recorded
            </div>
          </Btn>
          {isSuperAdmin(email) ? (
            <Btn className="btn" onTap={() => setPanel('admins')}>
              Admins
              <div className="sub" style={{ marginTop: 3, fontWeight: 400 }}>
                who may sign up
              </div>
            </Btn>
          ) : (
            <div />
          )}
        </div>

        <div className="lbl" style={{ marginTop: 20 }}>Weekend series</div>
        {db.series
          .filter((s) => s.deleted_at === null)
          .map((s) => {
            const squads = db.squads.filter((q) => q.series_id === s.id);
            const played = db.matches.filter((m) => m.series_id === s.id && m.status === 'completed').length;
            return (
              <Link key={s.id} href={`/admin/series/${s.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="card" style={{ marginBottom: 9 }}>
                  <div className="row">
                    <div>
                      <div className="tcode">
                        {s.name}
                        {s.is_test && (
                          <span className="chip amber" style={{ marginLeft: 6 }}>test</span>
                        )}
                      </div>
                      <div className="sub" style={{ marginTop: 3 }}>
                        {squads.map((q) => squadMembers(db, q.id).length).join(' v ')} players ·{' '}
                        {played} of {s.planned_matches} played
                      </div>
                    </div>
                    <span className="chip">{s.status}</span>
                  </div>
                </div>
              </Link>
            );
          })}

        <Btn className="btn primary" onTap={() => setPanel('series')} style={{ marginTop: 4 }}>
          Start a new series
        </Btn>

        <div className="note" style={{ margin: '20px 0' }}>
          <b>Not built yet:</b> login and roles, the public viewer, offline sync and knockout
          brackets. This build keeps everything on this device.
        </div>

        {db.series.some((s) => s.is_test) && (
          <Btn
            className="btn danger"
            style={{ marginBottom: 9 }}
            onTap={() => {
              const n = db.series.filter((s) => s.is_test).length;
              if (confirm(`Delete ${n} test series and every match and ball in them? This cannot be undone.`))
                mutate((d) => deleteAllTestSeries(d));
            }}
          >
            Delete all test series
          </Btn>
        )}

        <div className="note" style={{ marginBottom: 9 }}>
          <b>Starting fresh?</b> Clear the scorebook first, then press <b>Match the scorebook</b>{' '}
          on every device that has the app open. That replaces each device with whatever the
          scorebook now holds — which, after a wipe, is nothing.
        </div>

        <Btn
          className="btn"
          style={{ marginBottom: 9 }}
          onTap={() => {
            if (
              confirm(
                'Replace everything on this device with what the scorebook holds? Anything scored here and not yet saved is lost.',
              )
            )
              void forcePull();
          }}
        >
          Match the scorebook
        </Btn>

        <Btn
          className="btn danger"
          style={{ marginBottom: 20 }}
          onTap={() => {
            if (
              confirm(
                'Delete every player, team, series and ball on this device? The database is not touched.',
              )
            )
              resetAll();
          }}
        >
          Clear this device
        </Btn>
      </div>

      {panel === 'admins' && <AdminsSheet onClose={() => setPanel('none')} />}
      {panel === 'activity' && <ActivitySheet onClose={() => setPanel('none')} />}
      {panel === 'pool' && <PoolSheet onClose={() => setPanel('none')} />}
      {panel === 'settings' && <SettingsSheet onClose={() => setPanel('none')} />}
      {panel === 'series' && <NewSeriesSheet onClose={() => setPanel('none')} />}

      <TabBar active="admin" signedIn />
    </div>
  );
}

/** R1 / R35a — add in under 5 seconds (name only), soft-delete if he has stats. */
function PoolSheet({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const mutate = useMutate();
  const [name, setName] = useState('');
  const [q, setQ] = useState('');

  const list = db.players
    .filter((p) => p.deleted_at === null && p.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <Sheet title="Player pool" onClose={onClose}>
      <div className="row" style={{ marginBottom: 10 }}>
        <input
          className="field"
          placeholder="Add a player — name is enough"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Btn
          className="btn primary"
          style={{ width: 80 }}
          disabled={name.trim().length === 0}
          onTap={() => {
            mutate((d) => addPlayer(d, name));
            setName('');
          }}
        >
          Add
        </Btn>
      </div>

      <div className="pickerhead">
        <input
          className="field"
          placeholder="Search the pool"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="pickerlist">
      {list.map((p) => (
        <div key={p.id} className="row" style={{ padding: '9px 2px', borderBottom: '1px solid #1B2A22' }}>
          <span style={{ fontSize: 14, flex: 1 }}>{p.name}</span>
          <Btn
            className="btn ghost"
            style={{ width: 66, padding: '7px 4px', fontSize: 12 }}
            onTap={() => {
              const next = prompt('New name', p.name);
              if (next && next.trim()) mutate((d) => renamePlayer(d, p.id, next));
            }}
          >
            Rename
          </Btn>
          <Btn
            className="btn danger"
            style={{ width: 72, padding: '7px 4px', fontSize: 12 }}
            onTap={() => mutate((d) => deletePlayer(d, p.id))}
          >
            Delete
          </Btn>
        </div>
      ))}
      </div>
      <div className="hint" style={{ marginTop: 12 }}>
        A player who has already played is hidden rather than wiped, so old scorecards never
        break.
      </div>
    </Sheet>
  );
}

function SettingsSheet({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const mutate = useMutate();
  const [rules, setRules] = useState<RulesConfig>(fill(generalSettings(db)));

  return (
    <Sheet title="General settings" onClose={onClose}>
      <div className="hint" style={{ marginBottom: 12 }}>
        Set once, as the baseline. A series starts from these, and a match starts from the
        series — each level re-shows them pre-filled.
      </div>
      <RulesEditor value={rules} onChange={setRules} />
      <Btn
        className="btn primary"
        style={{ marginTop: 12 }}
        onTap={() => {
          mutate((d) => saveGeneralSettings(d, rules));
          onClose();
        }}
      >
        Save general settings
      </Btn>
    </Sheet>
  );
}

/** R1 — pick two existing jerseys or make new ones; squads are filled next. */
function NewSeriesSheet({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const mutate = useMutate();
  const [name, setName] = useState('');
  const [planned, setPlanned] = useState(3);
  const [a, setA] = useState(db.jerseys[0]?.id ?? '');
  const [b, setB] = useState(db.jerseys[1]?.id ?? '');
  const [newJersey, setNewJersey] = useState('');
  const [isTest, setIsTest] = useState(false);
  const [rules, setRules] = useState<RulesConfig>(fill(generalSettings(db)));

  return (
    <Sheet title="Start a series" onClose={onClose}>
      <div className="lbl">Series name</div>
      <input className="field" placeholder="Week 7" value={name} onChange={(e) => setName(e.target.value)} />

      <div className="lbl">Matches planned</div>
      <NumberPicker
        label="Matches planned"
        value={planned}
        quick={[1, 3, 5, 7]}
        min={1}
        max={50}
        width={80}
        onChange={setPlanned}
      />

      <div className="lbl">The two jerseys this week</div>
      <div className="grid2">
        {[
          [a, setA] as const,
          [b, setB] as const,
        ].map(([value, setValue], i) => (
          <select
            key={i}
            className="field"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          >
            {db.jerseys
              .filter((j) => j.deleted_at === null)
              .map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
          </select>
        ))}
      </div>

      <div className="row" style={{ marginTop: 9 }}>
        <input
          className="field"
          placeholder="or create a new team name"
          value={newJersey}
          onChange={(e) => setNewJersey(e.target.value)}
        />
        <Btn
          className="btn"
          style={{ width: 92 }}
          disabled={newJersey.trim().length === 0}
          onTap={() => {
            mutate((d) => addJersey(d, newJersey, '#ffb627'));
            setNewJersey('');
          }}
        >
          Create
        </Btn>
      </div>

      <div className="card" style={{ padding: '11px 13px', marginTop: 16 }}>
        <div className="row">
          <div style={{ flex: 1, fontSize: 13 }}>
            Test series
            <div className="sub" style={{ fontSize: 10.5, marginTop: 2 }}>
              For trying things out. A test series — and every match and ball in it — can be
              deleted outright later. Leave this off for a real weekend: those can never be
              deleted.
            </div>
          </div>
          <Toggle on={isTest} onTap={() => setIsTest(!isTest)} />
        </div>
      </div>

      <div className="lbl" style={{ marginTop: 18 }}>
        Settings for this series — pre-filled from general
      </div>
      <RulesEditor value={rules} onChange={setRules} />

      <Btn
        className="btn primary"
        style={{ marginTop: 12 }}
        disabled={name.trim().length === 0 || a === b}
        onTap={() => {
          mutate((d) => createSeries(d, name, planned, rules, a, b, isTest).db);
          onClose();
        }}
      >
        {a === b ? 'Pick two different teams' : 'Create series'}
      </Btn>
    </Sheet>
  );
}

/**
 * Sign in, or set a password for the first time.
 *
 * There is no open sign-up: the database refuses to create an account for an
 * email the super admin has not added. So the same form does both jobs — the
 * first time you use it, the password you type becomes your password.
 */
function SignIn({ email }: { email: string | null }) {
  const signIn = useSignInWithPassword();
  const signOut = useSignOut();
  const [value, setValue] = useState(email ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Without a database there is no way to check anybody, so there is no way in.
  if (!isRemote) {
    return (
      <div className="app">
        <TopBar title="Admin" back="/" />
        <div className="pad">
          <div className="note" style={{ borderColor: 'var(--strike)' }}>
            <b>Sign in is unavailable here.</b> This copy of the app cannot reach the scorebook,
            so there is no way to check who you are. Everything public still works.
          </div>
        </div>
        <TabBar active="admin" />
      </div>
    );
  }

  const ready = /.+@.+\..+/.test(value) && password.length >= 6;

  return (
    <div className="app">
      <TopBar title="Admin sign in" back="/" />
      <div className="pad">
        <div className="note" style={{ marginBottom: 14 }}>
          Only people the administrator has added can sign in. The first time you sign in, the
          password you type here becomes your password.
        </div>

        <div className="lbl">Your email</div>
        <input
          className="field"
          placeholder="you@example.com"
          inputMode="email"
          autoComplete="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />

        <div className="lbl">Password</div>
        <input
          className="field"
          type="password"
          placeholder="at least 6 characters"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {message && (
          <div className="note" style={{ marginTop: 12, borderColor: 'var(--strike)' }}>
            {message}
          </div>
        )}

        <Btn
          className="btn primary"
          style={{ marginTop: 14 }}
          disabled={!ready || busy}
          onTap={() => {
            setBusy(true);
            setMessage(null);
            void signIn(value, password).then((r) => {
              setBusy(false);
              if (!r.ok) setMessage(r.message ?? 'Could not sign in.');
            });
          }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </Btn>

        {email && (
          <Btn className="btn ghost" style={{ marginTop: 9 }} onTap={() => void signOut()}>
            Sign out of {email}
          </Btn>
        )}
      </div>
      <TabBar active="admin" />
    </div>
  );
}

/**
 * The allowlist. Adding an email here is the only way anyone gets an account —
 * they then set their own password on first sign-in. Nothing is emailed.
 */
function AdminsSheet({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Array<{ email: string; created_at: string }>>([]);
  const [signedUp, setSignedUp] = useState<Set<string>>(new Set());
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = /.+@.+\..+/.test(email.trim());

  const load = useCallback(async () => {
    const client = supabase();
    const [list, profiles] = await Promise.all([
      client.from('allowed_admins').select('email, created_at').order('created_at'),
      client.from('profiles').select('email'),
    ]);
    if (list.error) setError(list.error.message);
    setRows((list.data ?? []) as Array<{ email: string; created_at: string }>);
    setSignedUp(
      new Set(
        ((profiles.data ?? []) as Array<{ email: string | null }>)
          .map((p) => (p.email ?? '').toLowerCase())
          .filter(Boolean),
      ),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Sheet title="Who can sign in" onClose={onClose}>
      <div className="hint" style={{ marginBottom: 12 }}>
        Add an email and tell that person to open Admin and pick their own password. Nobody who
        is not on this list can create an account, and no invitation is sent.
      </div>

      {rows.map((r) => {
        const isSuper = r.email.toLowerCase() === SUPER_ADMIN;
        return (
          <div key={r.email} className="row" style={{ padding: '9px 2px', borderBottom: '1px solid #1B2A22' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.email}</div>
              <div className="sub" style={{ fontSize: 10.5 }}>
                {isSuper ? 'super admin' : signedUp.has(r.email.toLowerCase()) ? 'signed up' : 'has not signed in yet'}
              </div>
            </div>
            {!isSuper && (
              <Btn
                className="btn danger"
                style={{ width: 84, padding: '7px 4px', fontSize: 12 }}
                onTap={() => {
                  void supabase()
                    .from('allowed_admins')
                    .delete()
                    .eq('email', r.email)
                    .then(() => load());
                }}
              >
                Remove
              </Btn>
            )}
          </div>
        );
      })}

      {error && (
        <div className="note" style={{ marginTop: 10, borderColor: 'var(--strike)' }}>{error}</div>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <input
          className="field"
          placeholder="teammate@example.com"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Btn
          className="btn primary"
          style={{ width: 84 }}
          disabled={!valid || busy}
          onTap={() => {
            setBusy(true);
            setError(null);
            void supabase()
              .from('allowed_admins')
              .insert({ email: email.trim().toLowerCase() } as never)
              .then(async ({ error: e }) => {
                setBusy(false);
                if (e) setError(e.message);
                else {
                  setEmail('');
                  await load();
                }
              });
          }}
        >
          Add
        </Btn>
      </div>

      <div className="hint" style={{ marginTop: 10 }}>
        Removing someone stops them signing in from here on. It does not delete what they already
        scored — that stays attributed to them.
      </div>
    </Sheet>
  );
}

/** Who changed what, newest first. */
function ActivitySheet({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const rows = activity(db);

  return (
    <Sheet title="Activity" onClose={onClose}>
      <div className="hint" style={{ marginBottom: 12 }}>
        Every setup change and every voided ball, with the email that made it. Scored balls
        themselves are stamped on the delivery and show in the ball-by-ball.
      </div>
      {rows.length === 0 && <div className="note">Nothing recorded yet.</div>}
      {rows.map((r) => (
        <div key={r.id} style={{ padding: '9px 2px', borderBottom: '1px solid #1B2A22' }}>
          <div className="row">
            <span style={{ fontSize: 13 }}>{r.action.replace(/_/g, ' ')}</span>
            <span className="sub" style={{ fontSize: 10.5 }}>
              {new Date(r.at).toLocaleString()}
            </span>
          </div>
          <div className="sub" style={{ marginTop: 2 }}>{r.detail}</div>
          <div className="sub" style={{ marginTop: 2, color: 'var(--sodium)', fontSize: 10.5 }}>
            {r.actor ?? 'unknown'}
          </div>
        </div>
      ))}
    </Sheet>
  );
}
