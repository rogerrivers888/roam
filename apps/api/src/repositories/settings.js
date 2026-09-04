/**
 * Non-secret settings the owner changes from the app: which sources are
 * switched off.
 *
 * A provider key never lands here — keys come from Doppler at runtime
 * (CLAUDE.md). This is the switch beside the key, not the key.
 */

import { query } from '../db.js';

export async function sourcesOff() {
  const { rows } = await query("select value from app_settings where key = 'sources.off'");
  return Array.isArray(rows[0]?.value) ? rows[0].value.map(String) : [];
}

export async function setSourcesOff(keys) {
  await query(
    `insert into app_settings (key, value, updated_at) values ('sources.off', $1, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify(keys)],
  );
}
