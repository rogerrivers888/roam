import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from './db.js';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

/** The number a migration file leads with: `017` of `017_scores_and_where.sql`. */
export const numberOf = (file) => file.slice(0, file.indexOf('_'));

/**
 * Numbers that have already been used twice in this repository's history.
 *
 * Six collisions happened before there was anything to stop them. Every one is
 * applied wherever it matters, they are ordered deterministically by full
 * filename, and renaming an applied file would make it run a second time — so
 * they are history, listed here once, and everything else must be unique.
 *
 * The list is explicit rather than derived from what a database has applied,
 * because "has this been applied" is a different answer in every environment:
 * an empty database has applied none of them, and a guard that inferred history
 * from that would refuse to build a database from scratch.
 */
const HISTORICAL_DUPLICATES = new Set(['009', '019', '021', '028', '029', '030']);

/**
 * Refuse a *new* migration whose number is already taken.
 *
 * Two files sharing a number is how two branches quietly disagree about the
 * order the schema was built in. It is caught here, while renumbering is still
 * free, rather than on the day two environments disagree.
 */
export function assertNoNewDuplicateNumbers(files) {
  const taken = new Map();
  for (const file of files) {
    const n = numberOf(file);
    if (!n) continue;
    const seen = taken.get(n);
    if (seen && !HISTORICAL_DUPLICATES.has(n)) {
      throw new Error(
        `two migrations share the number ${n}: ${seen} and ${file}. `
        + 'Renumber the new one — a duplicate number is how environments start disagreeing about the order.',
      );
    }
    if (!seen) taken.set(n, file);
  }
}

async function main() {
  await query(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const { rows } = await query('select name from schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  assertNoNewDuplicateNumbers(files);

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
      console.log(`applied ${file}`);
      ran += 1;
    } catch (err) {
      await client.query('rollback');
      console.error(`failed ${file}: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(ran === 0 ? 'migrations up to date' : `${ran} migration(s) applied`);
  await pool.end();
}

// Only when run as a command. Imported — by a test, or by anything that wants
// `assertNoNewDuplicateNumbers` — this file must not migrate a database.
if (process.argv[1] && path.basename(process.argv[1]) === 'migrate.js') {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
