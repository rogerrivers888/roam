/**
 * The teaching table: what the owner has told Roam about which shelf a place
 * belongs on.
 *
 * Read on every home-screen answer, so it is cached in the process for a few
 * seconds rather than joined per place. It is a handful of small rows and it
 * changes when somebody types in the back office, not on a clock — the cache
 * is cleared the moment a rule is written, so a correction made on the Shelves
 * screen shows up on the next refresh of the home screen rather than in a
 * minute's time. Which is the whole point of a screen for teaching it: the
 * owner has to be able to see the answer change.
 */

import { query } from '../db.js';
import { MOOD_KEYS } from '../domain/moods.js';

export const SCOPES = ['place', 'kind', 'category', 'experience'];

/**
 * Keep only real shelves and real numbers, and drop a shelf claimed at zero.
 *
 * Weights arrive from a form and from a model, and neither is trusted: a rule
 * carrying `{ "advntre": 3 }` would otherwise sit in the table looking like it
 * did something.
 */
export function cleanWeights(input) {
  const out = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!MOOD_KEYS.includes(key)) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) continue;
    out[key] = Math.min(1, Math.round(n * 100) / 100);
  }
  return out;
}

let cache = null;
let cachedAt = 0;
const TTL_MS = 5000;

/** Everything taught, in the shape `domain/moods.js` walks. */
export async function rules() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const { rows } = await query('select * from shelf_rules');
  const byScope = Object.fromEntries(SCOPES.map((s) => [s, new Map()]));
  for (const r of rows) byScope[r.scope]?.set(r.subject, r);
  cache = byScope;
  cachedAt = Date.now();
  return cache;
}

/** Say the next read must go to the database. Called by every write below. */
export const forget = () => { cache = null; };

export async function list({ scope = null, q = null } = {}) {
  const where = []; const args = [];
  if (scope) { args.push(scope); where.push(`scope = $${args.length}`); }
  if (q) { args.push(`%${q}%`); where.push(`(subject ilike $${args.length} or subject_label ilike $${args.length} or reason ilike $${args.length})`); }
  const { rows } = await query(
    `select * from shelf_rules ${where.length ? `where ${where.join(' and ')}` : ''}
      order by scope, coalesce(subject_label, subject)`, args);
  return rows;
}

/**
 * Write one rule. Teaching the same subject twice is a correction, not a
 * second rule, so it replaces what was there — including the reason, which is
 * what makes the row auditable at all.
 */
export async function teach({ scope, subject, subjectLabel, weights, reason, by }) {
  if (!SCOPES.includes(scope)) throw Object.assign(new Error(`unknown scope ${scope}`), { status: 400 });
  const clean = cleanWeights(weights);
  if (!Object.keys(clean).length) {
    throw Object.assign(new Error('A rule with no shelf on it would hide the place everywhere. Give it at least one.'), { status: 400 });
  }
  const { rows } = await query(
    `insert into shelf_rules (scope, subject, subject_label, weights, reason, taught_by, seeded)
     values ($1,$2,$3,$4,$5,$6,false)
     on conflict (scope, subject) do update
        set subject_label = coalesce(excluded.subject_label, shelf_rules.subject_label),
            weights = excluded.weights,
            reason = excluded.reason,
            taught_by = excluded.taught_by,
            seeded = false,
            updated_at = now()
     returning *`,
    [scope, String(subject), subjectLabel ?? null, JSON.stringify(clean), reason ?? null, by ?? null]);
  forget();
  return rows[0];
}

/** Take a rule back. The subject falls to whatever the tables underneath say. */
export async function forgetRule(id) {
  const { rows } = await query('delete from shelf_rules where id = $1 returning *', [id]);
  forget();
  return rows[0] ?? null;
}

export const ruleById = async (id) =>
  (await query('select * from shelf_rules where id = $1', [id])).rows[0] ?? null;
