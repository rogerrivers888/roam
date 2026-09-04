/**
 * A database of its own, built from the migrations, for the tests to ruin.
 *
 * Never the development database. These tests delete households to prove the
 * cascades behave, and the local `roam` database is somebody's working copy —
 * so this creates `roam_test` beside it, runs every migration into it from
 * nothing, and hands back a pool pointed at that.
 *
 * Building it from the migration files is half the point: "the migrations apply
 * cleanly from an empty database" is the one thing a deploy depends on and
 * nothing else here checks.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../../.env'), quiet: true });

const BASE = process.env.DATABASE_URL || 'postgres://roam:roam@localhost:5434/roam';

/**
 * One database per test file.
 *
 * `node --test` runs files in parallel, and two of them dropping and rebuilding
 * the same database is a race that fails in a different place every time. The
 * name comes from the file being run, so the suites cannot collide and a
 * leftover from a crashed run is reused rather than accumulating.
 */
const suite = (process.argv[1] || 'suite').split('/').pop().replace(/\.test\.js$/, '').replace(/[^a-z0-9]/gi, '_').toLowerCase();
const TEST_DB = process.env.ROAM_TEST_DB || `roam_test_${suite}`;

const urlFor = (database) => {
  const u = new URL(BASE);
  u.pathname = `/${database}`;
  return u.toString();
};

let ready = null;

/**
 * The test database, migrated and empty. Safe to call from every test file:
 * the work happens once per process.
 */
export function testDatabase() {
  if (ready) return ready;
  ready = (async () => {
    // `postgres` is the database that always exists; connect there to make ours.
    const admin = new pg.Pool({ connectionString: urlFor('postgres') });
    try {
      await admin.query(`drop database if exists ${TEST_DB} with (force)`);
      await admin.query(`create database ${TEST_DB}`);
    } finally {
      await admin.end();
    }

    // Everything downstream reads DATABASE_URL when it is first imported, so it
    // is set before any of it is.
    process.env.DATABASE_URL = urlFor(TEST_DB);

    const { pool, query, withTransaction } = await import('../../src/db.js');
    const dir = path.resolve(here, '../../migrations');
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      try {
        await query(sql);
      } catch (err) {
        throw new Error(`migration ${file} failed against an empty database: ${err.message}`);
      }
    }
    return { pool, query, withTransaction, migrations: files.length };
  })();
  return ready;
}

/** A household with one member, enough to hang a visit and a rating from. */
export async function aHousehold(query, name = `test-${Math.random().toString(36).slice(2, 8)}`) {
  const { rows: [household] } = await query('insert into households (name) values ($1) returning *', [name]);
  const { rows: [member] } = await query(
    'insert into members (household_id, name, is_minor) values ($1, $2, false) returning *',
    [household.id, 'Test person'],
  );
  return { household, member };
}
