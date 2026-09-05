'use client';

/**
 * Phase 3 — the admin hub: the player pool, the general settings (R0) and the
 * weekend series list.
 *
 * There is no login yet (Supabase Auth arrives with Phase 5), so this is open.
 * The RLS in supabase/migrations/0002_rls.sql is what will gate it for real.
 */

import Link from 'next/link';
import { useState } from 'react';
import {
  isAdmin,
  isSuperAdmin,
  normalise,
  signOut,
  SUPER_ADMIN,
  useCurrentEmail,
  useSignIn,
} from '../../lib/auth';
import { fill, RulesEditor } from '../../lib/settings';
import {
  activity,
  addAdmin,
  addJersey,
  addPlayer,
  createSeries,
  deletePlayer,
  generalSettings,
  removeAdmin,
  resetAll,
  saveGeneralSettings,
  squadMembers,
  useDB,
  useMutate,
} from '../../lib/store';
import { Btn, NumberPicker, Sheet, TabBar, TopBar } from '../../lib/ui';
import type { RulesConfig } from '../../src/engine/types';

type Panel = 'none' | 'pool' | 'settings' | 'series' | 'jersey' | 'admins' | 'activity';

export default function Admin() {
  const db = useDB();
  const email = useCurrentEmail();
  const [panel, setPanel] = useState<Panel>('none');

  const activePlayers = db.players.filter((p) => p.deleted_at === null);

  // Everything behind this screen changes matches and stats, so it needs a
  // name against it. Signing in is what makes the activity log meaningful.
  if (!isAdmin(email, db.admins)) return <SignIn email={email} knownAdmins={db.admins} />;

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
          <Btn className="btn ghost" style={{ width: 90, padding: '7px 4px', fontSize: 12 }} onTap={signOut}>
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
                {db.admins.length + 1} with access
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
                      <div className="tcode">{s.name}</div>
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

        <Btn
          className="btn ghost"
          style={{ marginBottom: 20 }}
          onTap={() => {
            if (confirm('Wipe all local data and reseed the pool?')) resetAll();
          }}
        >
          Reset local data
        </Btn>
      </div>

      {panel === 'admins' && <AdminsSheet onClose={() => setPanel('none')} />}
      {panel === 'activity' && <ActivitySheet onClose={() => setPanel('none')} />}
      {panel === 'pool' && <PoolSheet onClose={() => setPanel('none')} />}
      {panel === 'settings' && <SettingsSheet onClose={() => setPanel('none')} />}
      {panel === 'series' && <NewSeriesSheet onClose={() => setPanel('none')} />}

      <TabBar active="admin" />
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
          <span style={{ fontSize: 14 }}>{p.name}</span>
          <Btn
            className="btn danger"
            style={{ width: 78, padding: '7px 4px', fontSize: 12 }}
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

      <div className="lbl" style={{ marginTop: 18 }}>
        Settings for this series — pre-filled from general
      </div>
      <RulesEditor value={rules} onChange={setRules} />

      <Btn
        className="btn primary"
        style={{ marginTop: 12 }}
        disabled={name.trim().length === 0 || a === b}
        onTap={() => {
          mutate((d) => createSeries(d, name, planned, rules, a, b).db);
          onClose();
        }}
      >
        {a === b ? 'Pick two different teams' : 'Create series'}
      </Btn>
    </Sheet>
  );
}

/**
 * No password yet — this records who you are so every change is attributable.
 * When Supabase Auth lands, this screen becomes the real login and the rest of
 * the app does not change.
 */
function SignIn({ email, knownAdmins }: { email: string | null; knownAdmins: string[] }) {
  const signIn = useSignIn();
  const [value, setValue] = useState(email ?? '');
  const known = normalise(value) === SUPER_ADMIN || knownAdmins.map(normalise).includes(normalise(value));

  return (
    <div className="app">
      <TopBar title="Admin sign in" back="/" />
      <div className="pad">
        <div className="note" style={{ marginBottom: 14 }}>
          Admin can set up series, build squads, run the toss and score. Every change is stamped
          with the email you use here and shows up in <b>Activity</b>.
        </div>

        <div className="lbl">Your email</div>
        <input
          className="field"
          placeholder="you@example.com"
          inputMode="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />

        {value.length > 0 && !known && (
          <div className="note" style={{ marginTop: 10, borderColor: 'var(--strike)' }}>
            That email has no admin access. Ask {SUPER_ADMIN} to add it.
          </div>
        )}

        <Btn
          className="btn primary"
          style={{ marginTop: 14 }}
          disabled={!known}
          onTap={() => signIn(value)}
        >
          Continue
        </Btn>

        {email && (
          <Btn className="btn ghost" style={{ marginTop: 9 }} onTap={signOut}>
            Sign out of {email}
          </Btn>
        )}
      </div>
      <TabBar active="admin" />
    </div>
  );
}

/** Only the super admin sees this. He cannot remove himself. */
function AdminsSheet({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const mutate = useMutate();
  const [email, setEmail] = useState('');
  const valid = /.+@.+\..+/.test(email.trim());

  return (
    <Sheet title="Admins" onClose={onClose}>
      <div className="hint" style={{ marginBottom: 12 }}>
        Anyone listed here can run the admin area and score matches. Their email is recorded
        against every change they make.
      </div>

      <div className="row" style={{ padding: '9px 2px', borderBottom: '1px solid #1B2A22' }}>
        <span style={{ fontSize: 13.5 }}>{SUPER_ADMIN}</span>
        <span className="chip amber">super admin</span>
      </div>

      {db.admins.map((a) => (
        <div key={a} className="row" style={{ padding: '9px 2px', borderBottom: '1px solid #1B2A22' }}>
          <span style={{ fontSize: 13.5 }}>{a}</span>
          <Btn
            className="btn danger"
            style={{ width: 84, padding: '7px 4px', fontSize: 12 }}
            onTap={() => mutate((d) => removeAdmin(d, a))}
          >
            Remove
          </Btn>
        </div>
      ))}

      <div className="row" style={{ marginTop: 14 }}>
        <input
          className="field"
          placeholder="new admin email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Btn
          className="btn primary"
          style={{ width: 84 }}
          disabled={!valid}
          onTap={() => {
            mutate((d) => addAdmin(d, email));
            setEmail('');
          }}
        >
          Add
        </Btn>
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
