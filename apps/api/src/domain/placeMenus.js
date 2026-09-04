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

import { withTransaction } from '../db.js';
import * as placeMenus from '../repositories/placeMenus.js';

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
      const reads = await placeMenus.upsertPlaceMenu(client, {
        venueRef, venueLabel: venueLabel ?? null, sourceUrl: read.sourceUrl, sourceKind: read.kind,
        currency: read.currency ?? null, note: read.note ?? null,
        sectionCount: read.sections.length, itemCount: items.length,
      });
      await placeMenus.clearPlaceMenuItems(client, venueRef);
      let position = 0;
      for (const item of items) {
        // No description: theirs, and it stays with the household that fetched it.
        await placeMenus.insertPlaceMenuItem(client, venueRef, {
          position: position += 1, section: item.section, sectionNote: item.sectionNote, name: item.name,
          price: Number.isFinite(Number(item.price)) ? Number(item.price) : null,
          priceText: typeof item.price === 'string' ? item.price : null,
          kcal: item.kcal ?? null, allergens: item.allergens ?? null, vegetarian: item.vegetarian ?? null,
        });
      }
      return { stored: true, items: items.length, reads };
    });
  } catch (err) {
    console.warn(`place menu not recorded for ${venueRef}: ${err.message}`);
    return { stored: false };
  }
}

/** The menu Roam knows for a place, whoever read it, or null. */
export async function knownMenu(venueRef) {
  const m = await placeMenus.placeMenu(venueRef);
  if (!m) return null;
  const items = await placeMenus.placeMenuItems(venueRef);
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
  return placeMenus.datasetSummary();
}
