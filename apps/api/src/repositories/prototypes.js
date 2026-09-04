/**
 * The owner's verdict on each mock-up.
 *
 * A page with no row here is "new": "to review" is simply what has no verdict,
 * which is why ruling something back to new deletes rather than updates.
 */

import { query } from '../db.js';

export async function allReviews() {
  const { rows } = await query('select file, status, note, updated_at from prototype_reviews');
  return rows;
}

export async function clearReview(file) {
  await query('delete from prototype_reviews where file = $1', [file]);
}

export async function saveReview(file, status, note) {
  const { rows } = await query(
    `insert into prototype_reviews (file, status, note, updated_at) values ($1, $2, $3, now())
     on conflict (file) do update set status = excluded.status, note = excluded.note, updated_at = now()
     returning file, status, note, updated_at`,
    [file, status, note],
  );
  return rows[0];
}
