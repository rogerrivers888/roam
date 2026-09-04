import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../.env'), quiet: true });

// DATE columns come back as 'YYYY-MM-DD', not a local-midnight Date that shifts with timezone.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://roam:roam@localhost:5432/roam',
});

export const query = (text, params) => pool.query(text, params);

/**
 * Is the database answering?
 *
 * The one statement outside `repositories/` on purpose: it is not a question
 * about anything the household owns, it is the connection saying it is alive,
 * and it belongs with the pool it is testing.
 */
export const ping = () => pool.query('select 1');

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
