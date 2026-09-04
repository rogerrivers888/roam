// What Roam knows about a restaurant's menu, kept for everyone.
//
// The household's own copy of a menu it fetched lives in `menus` and stays
// there, household-scoped, exactly as before. This is the layer beside it: the
// same read, recorded against the place rather than the household, kept for
// good, and rewritten by whoever reads it next (migration 028).
//
// The restaurant's descriptive prose is deliberately not carried across — that
// is their writing, and pooling it is what Technical Constraints L9 gates on a
// copyright review. Names, prices, sections, calories and the allergen line
// are facts a menu publishes in order to be quoted, and they are the part that
// makes the dataset worth having.

import { query, withTransaction } from '../db.js';

/**
 * Record a menu read against the place, replacing whatever was known before.
 *
 * Newest read wins outright rather than merging: a menu that has lost a dish
 * has lost it, and a half-old half-new menu is a menu that never existed.
 * Never throws — the household's own copy is the thing they asked for, and the
 * shared record must not be able to fail their request.
 */
export async function recordMenuRead({ venueRef, venueLabel, read }) {
  if (!venueRef || !read?.sections?.length) return { stored: false };
  try {
    return await withTransaction(async (client) => {
      const items = read.sections.flatMap((s) => (s.items ?? []).map((item) => ({ ...item, section: s.title, sectionNote: s.note ?? null })));
      const { rows } = await client.query(
        `insert into place_menus (venue_ref, venue_label, source_url, source_kind, currency, note, section_count, item_count, read_at, reads)
         values ($1,$2,$3,$4,$5,$6,$7,$8, now(), 1)
         on conflict (venue_ref) do update set
           venue_label = coalesce(excluded.venue_label, place_menus.venue_label),
           source_url = excluded.source_url, source_kind = excluded.source_kind,
           currency = coalesce(excluded.currency, place_menus.currency), note = excluded.note,
           section_count = excluded.section_count, item_count = excluded.item_count,
           read_at = now(), reads = place_menus.reads + 1
         returning reads`,
        [venueRef, venueLabel ?? null, read.sourceUrl, read.kind, read.currency ?? null, read.note ?? null, read.sections.length, items.length],
      );
      await client.query('delete from place_menu_items where venue_ref = $1', [venueRef]);
      let position = 0;
      for (const item of items) {
        await client.query(
          `insert into place_menu_items (venue_ref, position, section, section_note, name, price, price_text, kcal, allergens, vegetarian)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          // No description: theirs, and it stays with the household that fetched it.
          [venueRef, position += 1, item.section, item.sectionNote, item.name,
           Number.isFinite(Number(item.price)) ? Number(item.price) : null,
           typeof item.price === 'string' ? item.price : null,
           item.kcal ?? null, item.allergens ?? null, item.vegetarian ?? null],
        );
      }
      return { stored: true, items: items.length, reads: rows[0].reads };
    });
  } catch (err) {
    console.warn(`place menu not recorded for ${venueRef}: ${err.message}`);
    return { stored: false };
  }
}

/** The menu Roam knows for a place, whoever read it, or null. */
export async function knownMenu(venueRef) {
  const { rows } = await query('select * from place_menus where venue_ref = $1', [venueRef]);
  const m = rows[0];
  if (!m) return null;
  const { rows: items } = await query('select * from place_menu_items where venue_ref = $1 order by position', [venueRef]);
  const sections = [];
  for (const i of items) {
    let section = sections.find((s) => s.title === i.section);
    if (!section) { section = { title: i.section, note: i.section_note, items: [] }; sections.push(section); }
    section.items.push({
      name: i.name,
      price: i.price == null ? null : Number(i.price),
      priceText: i.price_text,
      kcal: i.kcal, allergens: i.allergens, vegetarian: i.vegetarian,
    });
  }
  return {
    venueRef: m.venue_ref, venueLabel: m.venue_label,
    sourceUrl: m.source_url, sourceKind: m.source_kind,
    currency: m.currency, note: m.note,
    sections, itemCount: m.item_count,
    readAt: m.read_at, firstReadAt: m.first_read_at, reads: m.reads,
    // Said on screen rather than assumed: a menu read in June is not a promise
    // about tonight, and the descriptions are not here on purpose.
    terms: 'Dish names and prices as Roam last read them from the restaurant’s own menu. Their own descriptions of each dish stay with the household that fetched them.',
  };
}

/** How much of the menu dataset exists, for Settings and the owner's view. */
export async function menuDatasetSummary() {
  const { rows } = await query(
    `select count(*)::int as places, coalesce(sum(item_count), 0)::int as dishes,
            coalesce(sum(reads), 0)::int as reads, max(read_at) as last_read
       from place_menus`,
  );
  return rows[0];
}
