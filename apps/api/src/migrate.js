import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from './db.js';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
