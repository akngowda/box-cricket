/**
 * The merge is where sync can silently undo work, so it gets its own tests.
 *
 * The bug these were written for: marking the first innings complete changed an
 * existing row, the push only sent new rows, and the following pull handed the
 * stale copy back — so "Start the chase" appeared to do nothing at all.
 */

import { describe, expect, it } from 'vitest';
import { mergeTables } from './sync';
import type { DB } from './store';

const EMPTY: DB = {
  admins: [],
  audit: [],
  players: [],
  jerseys: [],
  series: [],
  squads: [],
  squad_players: [],
  matches: [],
  innings: [],
  deliveries: [],
  match_events: [],
  app_settings: [],
};

const innings = (id: string, status: 'in_progress' | 'complete', seq: 1 | 2) =>
  ({ id, status, seq }) as unknown as DB['innings'][number];

describe('sync merge', () => {
  it('a local change to an existing row is not rolled back by a stale server copy', () => {
    const local: DB = { ...EMPTY, innings: [innings('i1', 'complete', 1), innings('i2', 'in_progress', 2)] };
    // The server has only what it knew before the chase started.
    const server = { innings: [innings('i1', 'in_progress', 1)] };

    // Push succeeded, so the server is now authoritative — but a successful
    // push means it already holds the local version of i1.
    const merged = mergeTables(
      local,
      { innings: [innings('i1', 'complete', 1), innings('i2', 'in_progress', 2)] },
      new Set(),
    ).db;
    expect(merged.innings.find((i) => i.id === 'i1')?.status).toBe('complete');
    expect(merged.innings).toHaveLength(2);

    // And when the push was refused, local wins outright rather than losing it.
    const refused = mergeTables(local, server, new Set(['innings'])).db;
    expect(refused.innings.find((i) => i.id === 'i1')?.status).toBe('complete');
    expect(refused.innings.find((i) => i.id === 'i2')).toBeDefined();
  });

  it('rows only the server has are still picked up', () => {
    const local: DB = { ...EMPTY, innings: [innings('i1', 'complete', 1)] };
    const server = { innings: [innings('i1', 'complete', 1), innings('i9', 'in_progress', 2)] };

    expect(mergeTables(local, server, new Set()).db.innings).toHaveLength(2);
    // Even for a refused table: another device's work is never dropped.
    expect(mergeTables(local, server, new Set(['innings'])).db.innings).toHaveLength(2);
  });

  it('a ball scored offline survives a refused push', () => {
    const ball = { id: 'd1', innings_id: 'i1', seq: 1 } as unknown as DB['deliveries'][number];
    const local: DB = { ...EMPTY, deliveries: [ball] };
    const merged = mergeTables(local, { deliveries: [] }, new Set(['deliveries'])).db;
    expect(merged.deliveries).toHaveLength(1);
  });
});

describe('push strategy', () => {
  it('a ball already in the database is never re-sent', () => {
    // The append-only trigger rejects any edit to a stored ball, and an upsert
    // is one statement — so re-sending old balls also blocked the new ones.
    // This is the shape that broke: two stored, one fresh.
    const stored = [
      { id: 'd1', is_voided: false },
      { id: 'd2', is_voided: false },
    ];
    const local = [...stored, { id: 'd3', is_voided: false }];

    const storedIds = new Set(stored.map((r) => r.id));
    const fresh = local.filter((r) => !storedIds.has(r.id));
    expect(fresh.map((r) => r.id)).toEqual(['d3']);

    // And a void is the only later change that goes up.
    const voidedLocally = [{ id: 'd1', is_voided: true }, { id: 'd2', is_voided: false }];
    const toVoid = voidedLocally.filter(
      (r) => r.is_voided && stored.find((s) => s.id === r.id)?.is_voided === false,
    );
    expect(toVoid.map((r) => r.id)).toEqual(['d1']);
  });
});

describe('deletions made in the database', () => {
  it('a row this device knew about, now gone from the server, is dropped — not pushed back', () => {
    // This is what made clearing the scorebook impossible: the open app kept
    // helpfully restoring everything it had.
    const local: DB = {
      ...EMPTY,
      series: [{ id: 's1' }, { id: 's2' }] as unknown as DB['series'],
    };
    const known = { series: ['s1', 's2'] };

    const after = mergeTables(local, { series: [] }, new Set(), known);
    expect(after.db.series).toHaveLength(0);
    expect(after.known.series).toEqual([]);
  });

  it('a row never yet uploaded still survives an empty server', () => {
    const local: DB = { ...EMPTY, series: [{ id: 'fresh' }] as unknown as DB['series'] };
    // Nothing known: this has simply never been pushed.
    const after = mergeTables(local, { series: [] }, new Set(), {});
    expect(after.db.series).toHaveLength(1);
  });
});

describe('scoring while a sync is in flight', () => {
  it('a ball scored mid-sync is not written over by the sync that started before it', () => {
    // The sync pulled this from the server, and held it.
    const server = { deliveries: [{ id: 'd1' }] };
    const known = { deliveries: ['d1'] };

    // Meanwhile the scorer scored two more, so the device now holds three.
    const nowOnDevice: DB = {
      ...EMPTY,
      deliveries: [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }] as unknown as DB['deliveries'],
    };

    // Merging against the CURRENT device state keeps them.
    const merged = mergeTables(nowOnDevice, server, new Set(), known).db;
    expect(merged.deliveries.map((d) => d.id).sort()).toEqual(['d1', 'd2', 'd3']);
  });

  it('rapid additions to a squad all survive', () => {
    const server = { squad_players: [{ id: 'sp1' }] };
    const known = { squad_players: ['sp1'] };
    const device: DB = {
      ...EMPTY,
      squad_players: [{ id: 'sp1' }, { id: 'sp2' }, { id: 'sp3' }] as unknown as DB['squad_players'],
    };
    expect(mergeTables(device, server, new Set(), known).db.squad_players).toHaveLength(3);
  });
});
