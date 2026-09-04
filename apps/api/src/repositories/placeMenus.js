/**
 * The menu Roam owns for a place, as against the copy one household captured.
 *
 * `menus` is a household's own fetch. `place_menus` is the shared record: read
 * from the venue's own published page, which is the licence that lets it be
 * kept at all (Technical Constraints §13.10). A provider's description of a
 * dish is never written here — only what the venue itself published, and the
 * description is deliberately left out.
 */

import { query } from '../db.js';

const on = (client) => (client ? (text, params) => client.query(text, params) : query);

/**
 * Record a read, replacing the items wholesale.
 *
 * The count of reads is kept because it is the evidence that a place is worth
 * holding a menu for at all.
 */
export async function upsertPlaceMenu(client, m) {
  const { rows } = await on(client)(
    `insert into place_menus (venue_ref, venue_label, source_url, source_kind, currency, note, section_count, item_count, read_at, reads)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now(), 1)
     on conflict (venue_ref) do update set
       venue_label = coalesce(excluded.venue_label, place_menus.venue_label),
       source_url = excluded.source_url, source_kind = excluded.source_kind,
       currency = coalesce(excluded.currency, place_menus.currency), note = excluded.note,
       section_count = excluded.section_count, item_count = excluded.item_count,
       read_at = now(), reads = place_menus.reads + 1
     returning reads`,
    [m.venueRef, m.venueLabel ?? null, m.sourceUrl, m.sourceKind, m.currency ?? null, m.note ?? null, m.sectionCount, m.itemCount],
  );
  return rows[0].reads;
}

/**
 * Clear the items so they can be written again.
 *
 * Only ever inside the transaction that immediately rewrites them: a menu is
 * replaced whole because half an old menu and half a new one is a menu that
 * never existed.
 */
export async function clearPlaceMenuItems(client, venueRef) {
  await on(client)('delete from place_menu_items where venue_ref = $1', [venueRef]);
}

export async function insertPlaceMenuItem(client, venueRef, item) {
  await on(client)(
    `insert into place_menu_items (venue_ref, position, section, section_note, name, price, price_text, kcal, allergens, vegetarian)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [venueRef, item.position, item.section, item.sectionNote, item.name,
      item.price, item.priceText, item.kcal ?? null, item.allergens ?? null, item.vegetarian ?? null],
  );
}

export async function placeMenu(venueRef) {
  const { rows } = await query('select * from place_menus where venue_ref = $1', [venueRef]);
  return rows[0] ?? null;
}

export async function placeMenuItems(venueRef) {
  const { rows } = await query('select * from place_menu_items where venue_ref = $1 order by position', [venueRef]);
  return rows;
}

/** How much of a menu dataset Roam has built, for the owner's own figures. */
export async function datasetSummary() {
  const { rows } = await query(
    `select count(*)::int as places, coalesce(sum(item_count), 0)::int as dishes,
            coalesce(sum(reads), 0)::int as reads, max(read_at) as last_read
       from place_menus`,
  );
  return rows[0];
}
