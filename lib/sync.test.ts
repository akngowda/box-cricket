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
    const merged = mergeTables(local, { innings: [innings('i1', 'complete', 1), innings('i2', 'in_progress', 2)] }, new Set());
    expect(merged.innings.find((i) => i.id === 'i1')?.status).toBe('complete');
    expect(merged.innings).toHaveLength(2);

    // And when the push was refused, local wins outright rather than losing it.
    const refused = mergeTables(local, server, new Set(['innings']));
    expect(refused.innings.find((i) => i.id === 'i1')?.status).toBe('complete');
    expect(refused.innings.find((i) => i.id === 'i2')).toBeDefined();
  });

  it('rows only the server has are still picked up', () => {
    const local: DB = { ...EMPTY, innings: [innings('i1', 'complete', 1)] };
    const server = { innings: [innings('i1', 'complete', 1), innings('i9', 'in_progress', 2)] };

    expect(mergeTables(local, server, new Set()).innings).toHaveLength(2);
    // Even for a refused table: another device's work is never dropped.
    expect(mergeTables(local, server, new Set(['innings'])).innings).toHaveLength(2);
  });

  it('a ball scored offline survives a refused push', () => {
    const ball = { id: 'd1', innings_id: 'i1', seq: 1 } as unknown as DB['deliveries'][number];
    const local: DB = { ...EMPTY, deliveries: [ball] };
    const merged = mergeTables(local, { deliveries: [] }, new Set(['deliveries']));
    expect(merged.deliveries).toHaveLength(1);
  });
});
