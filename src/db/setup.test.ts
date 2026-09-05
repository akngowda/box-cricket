import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('setup.sql', () => {
  it('runs clean on an empty database, and again on top of itself', async () => {
    const db = new PGlite();
    await db.exec(readFileSync('supabase/tests/00_auth_stub.sql', 'utf8'));
    const sql = readFileSync('supabase/setup.sql', 'utf8');
    await db.exec(sql);
    await db.exec(sql); // re-running must not fail
    const t = await db.query(
      `select count(*)::int as n from information_schema.tables where table_schema='public'`,
    );
    expect((t.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(12);
  });
});
