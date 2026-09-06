/**
 * Teaching Roam which shelf a place belongs on.
 *
 * The owner, 5 Sep 2026, looking at the home screen: "currently, on the
 * homepage under the adrenaline section, it's showing football stadiums. That's
 * not what I consider adrenaline… I would like to be able to train it on
 * anything that appears in the categorisation where I believe it's wrong. I
 * think we need an admin section in the back office where we can train it on
 * categories."
 *
 * So this is that section's API, and it is built around the thing he actually
 * does: open a shelf, find something on it that does not belong, and say so.
 *
 *   GET  /shelf     the shelf exactly as the home screen composes it, each
 *                   place carrying *why* it is there
 *   GET  /places    the same answer for a place found by name, for when the
 *                   card he objected to has scrolled away
 *   PUT  /rules     teach one: these shelves, these weights, and this reason
 *   POST /read      the same thing said in a sentence, turned into weights
 *   DELETE /rules   take a rule back
 *
 * Two things it deliberately is not. It is not a second classifier: the atlas's
 * own eight words for what a thing *is* stay where they are (the Atlas screen's
 * "What counts as somewhere to go"), and this only decides what a day there is
 * like. And it is not a per-place chore: every place carries the Wikidata types
 * it was harvested with, so "this is not adrenaline" can be taught once against
 * `association football venue` and answer for every ground in the country.
 */

import { Router } from 'express';
import { requires } from '../access.js';
import { query } from '../db.js';
import * as lib from '../repositories/library.js';
import * as shelfRules from '../repositories/shelfRules.js';
import * as taxonomy from '../repositories/shelfTaxonomy.js';
import { currentHousehold } from './household.js';
import {
  BY_ATLAS_CATEGORY, BY_EXPERIENCE, MAX_SHELVES, SHELF_FLOOR,
  shelvesForAtlas,
} from '../domain/moods.js';
import { kindLabels } from '../sources/wikimedia.js';
import { readTeaching } from '../domain/teaching.js';
import { kmBetween } from '../domain/travel.js';

export const shelves = Router();

const actorOf = (req) => req.account?.email ?? 'the owner (passcode)';
const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'bad_request' });

/** Where the owner is looking, defaulting to home like the home screen does. */
async function centreOf(req) {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, label: req.query.label || null };
  const household = await currentHousehold();
  if (household?.home_lat == null) return null;
  return { lat: household.home_lat, lng: household.home_lng, label: household.home_label };
}

/**
 * One attraction, as the home screen sees it plus the reasoning behind it.
 *
 * `kinds` comes back named and with whatever has been taught about each,
 * because the useful move on this screen is almost never "fix this one place" —
 * it is "fix the type, and every place of that type with it".
 */
function explain(row, rules, kindNames, vocab) {
  const ref = row.osm_ref ? `osm:${row.osm_ref}` : `wikidata:${row.wikidata_id}`;
  const { weights, shelves: on, because, category, subcategory, confident } = shelvesForAtlas(
    { ref, category: row.category, kinds: row.kinds ?? [] }, rules, vocab,
  );
  return {
    ref,
    id: row.id,
    name: row.name,
    region: row.region_name ?? row.region_slug,
    category: row.category,
    // Enough to know which Wembley this is, and no more: the shelf answer
    // carries a hundred and fifty of these and a full encyclopedia paragraph
    // each turns a back-office list into a third of a megabyte.
    summary: row.summary ? `${row.summary.slice(0, 160).trim()}${row.summary.length > 160 ? '…' : ''}` : null,
    score: row.score,
    lat: row.lat,
    lng: row.lng,
    imageId: row.image_id ?? row.hero_id ?? null,
    shelves: on,
    // The one it is filed under, and the drawer inside it. `shelves` keeps the
    // old shape — a list of one — so nothing that draws shelves has to change.
    shelf: category,
    subcategory,
    confident,
    weights,
    because,
    kinds: (row.kinds ?? []).map((qid) => ({
      qid,
      label: kindNames.get(qid)?.label ?? null,
      category: kindNames.get(qid)?.category ?? null,
      rule: rules.kind.get(qid) ?? null,
    })),
    rule: rules.place.get(ref) ?? null,
  };
}

/** Name every type these rows mention, in one read. */
const namesFor = (rows) => lib.kindsByQid([...new Set(rows.flatMap((r) => r.kinds ?? []))]);

// ---------------------------------------------------------------------------
// the vocabulary, and everything taught so far
// ---------------------------------------------------------------------------

shelves.get('/', requires('view_library'), async (_req, res, next) => {
  try {
    const [rules, taught, tax, use] = await Promise.all([
      shelfRules.rules(), shelfRules.list(), taxonomy.taxonomy(), taxonomy.subcategoryUse(),
    ]);
    res.json({
      // Both levels, straight from the tables, so the screens draw whatever the
      // settings page last said rather than a list compiled into the bundle.
      shelves: tax.categories.map((c) => ({ ...c, subcategories: tax.subcategories.filter((s) => s.category_key === c.key) })),
      subcategories: tax.subcategories.map((s) => ({ ...s, rules: use.get(s.key) ?? 0 })),
      floor: SHELF_FLOOR,
      maxShelves: MAX_SHELVES,
      // What a subject falls back to when nothing has been taught about it, so
      // the screen can show the starting point beside the correction.
      defaults: { category: BY_ATLAS_CATEGORY, experience: BY_EXPERIENCE },
      rules: taught,
      counts: Object.fromEntries(shelfRules.SCOPES.map((s) => [s, rules[s].size])),
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// what is on a shelf right now
// ---------------------------------------------------------------------------

/**
 * GET /shelf?mood=adrenaline&lat=&lng=&km=
 *
 * The home screen's own answer, composed the same way from the same table, so
 * what this screen shows and what he objected to are the same list. `km`
 * matches the home screen's default reach.
 */
shelves.get('/shelf', requires('view_library'), async (req, res, next) => {
  try {
    const tax = await taxonomy.taxonomy();
    const mood = String(req.query.mood || 'adrenaline');
    if (!tax.byKey.has(mood)) throw bad(`${mood} is not one of the categories`);
    // Narrow to one drawer, which is what the second row of chips does.
    const drawer = req.query.subcategory ? String(req.query.subcategory) : null;
    const centre = await centreOf(req);
    if (!centre) throw bad('Set a home address, or pass lat and lng, and Roam will look around it.');
    const km = Math.min(200, Math.max(1, Number(req.query.km) || 60));

    const rules = await shelfRules.rules();
    const near = await lib.publishedNear({ lat: centre.lat, lng: centre.lng, km, limit: 400 });
    const names = await namesFor(near);

    const all = near
      .filter((r) => r.lat != null && kmBetween(centre, r) <= km)
      .map((r) => ({ ...explain(r, rules, names, tax.vocab), distanceKm: Number(kmBetween(centre, r).toFixed(1)) }));

    const on = all.filter((i) => i.shelf === mood);

    res.json({
      mood,
      subcategory: drawer,
      place: centre,
      km,
      // Everything within reach, split into what this shelf holds and what it
      // nearly holds. The second list is the one that answers "why is that not
      // on there" — a place at 0.3 on Adrenaline is a rule away from being on it.
      items: drawer ? on.filter((i) => i.subcategory === drawer) : on,
      // How the shelf divides up, so the drawers can be drawn as counts rather
      // than as a list somebody has to scan. `null` is the unsorted pile, which
      // is the work queue.
      drawers: tax.subcategories
        .filter((sc) => sc.category_key === mood)
        .map((sc) => ({ ...sc, count: on.filter((i) => i.subcategory === sc.key).length }))
        .concat([{ key: null, label: 'Not sorted yet', category_key: mood, count: on.filter((i) => !i.subcategory).length }]),
      nearly: all
        .filter((i) => i.shelf !== mood && (i.weights[mood] ?? 0) > 0)
        .sort((a, b) => (b.weights[mood] ?? 0) - (a.weights[mood] ?? 0))
        .slice(0, 30),
      pool: all.length,
    });
  } catch (err) { next(err); }
});

/** GET /places?q= — find the card by name when it is no longer on screen. */
shelves.get('/places', requires('view_library'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ places: [] });
    const [rules, tax] = await Promise.all([shelfRules.rules(), taxonomy.taxonomy()]);
    const rows = await lib.listAttractions({ q, limit: 40 });
    const names = await namesFor(rows);
    res.json({ places: rows.map((r) => explain(r, rules, names, tax.vocab)) });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// teaching
// ---------------------------------------------------------------------------

/**
 * PUT /rules — this subject belongs on these shelves, with these weights,
 * because of this.
 *
 * The reason is not decoration. A weight without one is a number nobody can
 * argue with in six months, and this table is meant to be argued with.
 */
shelves.put('/rules', requires('manage_library'), async (req, res, next) => {
  try {
    const tax = await taxonomy.taxonomy();
    const rule = await shelfRules.teach({
      scope: req.body?.scope,
      subject: req.body?.subject,
      subjectLabel: req.body?.subjectLabel,
      weights: req.body?.weights,
      subcategory: req.body?.subcategory ?? null,
      reason: req.body?.reason,
      by: actorOf(req),
      known: tax.categories.map((c) => c.key),
    });
    await query(
      `insert into admin_audit (actor_id, actor_label, action, subject_type, subject_id, subject_label, after)
       values ($1,$2,'shelf.teach','shelf_rule',$3,$4,$5)`,
      [req.account?.id ?? null, actorOf(req), rule.id,
       `${rule.scope}: ${rule.subject_label ?? rule.subject}`,
       JSON.stringify({ weights: rule.weights, reason: rule.reason })]);
    res.json({ rule });
  } catch (err) { next(err); }
});

/**
 * PUT /place — the fast one.
 *
 * The owner, 5 Sep 2026: "I'd like a way to be able to, on the fly, just select
 * something and change the category or subcategory very quickly from the
 * shelves page." So this is one call, one row, no form: pick a drawer (or a
 * shelf) for one place and it is filed there on the next read.
 *
 * It writes a `place` rule, which is the narrowest scope and therefore always
 * wins — the point is that it is instant and unambiguous, not that it teaches a
 * general lesson. Teaching every place of a type is the other button, and it is
 * still the better move when the type is really the thing that is wrong.
 *
 * Naming a subcategory is enough on its own: a drawer belongs to exactly one
 * cabinet, so the category comes with it and the two can never disagree.
 */
shelves.put('/place', requires('manage_library'), async (req, res, next) => {
  try {
    const ref = String(req.body?.ref || '').trim();
    if (!ref) throw bad('Which place?');
    const tax = await taxonomy.taxonomy();

    const drawer = req.body?.subcategory ? String(req.body.subcategory) : null;
    if (drawer && !tax.subByKey.has(drawer)) throw bad(`There is no subcategory called ${drawer}.`);

    // The shelf, if one was asked for outright. When a drawer is named it is
    // the drawer's own cabinet, whatever else was sent — the two levels agree
    // by construction rather than by the caller remembering to make them.
    const asked = drawer ? tax.subByKey.get(drawer).category_key
      : req.body?.category ? String(req.body.category) : null;
    if (!asked) throw bad('Pick a category or a subcategory.');
    if (!tax.byKey.has(asked)) throw bad(`There is no category called ${asked}.`);

    const rule = await shelfRules.teach({
      scope: 'place',
      subject: ref,
      subjectLabel: req.body?.label ?? null,
      // Full marks for the one it was moved to, and nothing else. A hand move
      // is a statement, not a nudge, and the next read should not have to
      // weigh it against whatever the type says.
      weights: { [asked]: 1 },
      subcategory: drawer,
      reason: req.body?.reason?.trim() || `Moved to ${tax.byKey.get(asked).label}${drawer ? ` · ${tax.subByKey.get(drawer).label}` : ''} by hand from the shelves page.`,
      by: actorOf(req),
      known: tax.categories.map((c) => c.key),
    });
    await query(
      `insert into admin_audit (actor_id, actor_label, action, subject_type, subject_id, subject_label, after)
       values ($1,$2,'shelf.move','shelf_rule',$3,$4,$5)`,
      [req.account?.id ?? null, actorOf(req), rule.id, req.body?.label ?? ref,
       JSON.stringify({ category: asked, subcategory: drawer })]);
    res.json({ rule, category: asked, subcategory: drawer });
  } catch (err) { next(err); }
});

shelves.delete('/rules/:id', requires('manage_library'), async (req, res, next) => {
  try {
    const rule = await shelfRules.forgetRule(req.params.id);
    if (!rule) return res.status(404).json({ error: 'not_found' });
    await query(
      `insert into admin_audit (actor_id, actor_label, action, subject_type, subject_id, subject_label, before)
       values ($1,$2,'shelf.forget','shelf_rule',$3,$4,$5)`,
      [req.account?.id ?? null, actorOf(req), rule.id,
       `${rule.scope}: ${rule.subject_label ?? rule.subject}`,
       JSON.stringify({ weights: rule.weights, reason: rule.reason })]);
    res.json({ removed: true, rule });
  } catch (err) { next(err); }
});

/**
 * POST /read — "this is a football ground, you watch, it's fun not adrenaline"
 * turned into weights.
 *
 * It proposes; it never writes. What comes back fills the same form the owner
 * could have filled by hand, he can move any of it, and nothing reaches the
 * table until he saves — because a rule he did not read is exactly the silent
 * guessing this screen exists to end.
 */
shelves.post('/read', requires('manage_library'), async (req, res, next) => {
  try {
    const said = String(req.body?.said || '').trim();
    if (!said) throw bad('Say what is wrong with it and Roam will turn that into weights.');
    const household = await currentHousehold();
    const proposal = await readTeaching({
      said,
      subject: req.body?.subject ?? null,
      subjectLabel: req.body?.subjectLabel ?? null,
      scope: req.body?.scope ?? null,
      current: req.body?.current ?? null,
      householdId: household.id,
    });
    res.json({ proposal });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// naming the types
// ---------------------------------------------------------------------------

/**
 * POST /kinds/name — give the Q-numbers their English names.
 *
 * The subclass walk that fills `place_kinds` returns identifiers only, and a
 * screen that asks somebody to rule on "Q1154710" is a screen nobody will use.
 * Wikidata's label service, keyless and free, in batches of three hundred.
 */
shelves.post('/kinds/name', requires('manage_library'), async (req, res, next) => {
  try {
    const missing = await lib.unlabelledKinds(Math.min(2000, Number(req.body?.limit) || 400));
    if (!missing.length) return res.json({ named: 0, asked: 0, remaining: 0 });
    const labels = await kindLabels(missing);
    const named = await lib.nameKinds(labels);
    res.json({ named, asked: missing.length, remaining: await lib.unlabelledKindCount() });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// the settings page: the two levels themselves
// ---------------------------------------------------------------------------
//
// The owner asked for somewhere to "see those categories and subcategories" and
// "add the subcategories manually". Renaming never changes a key, so nothing
// already taught is orphaned by a change of wording; moving a subcategory to
// another category moves every place in it, which is the point.

shelves.put('/categories', requires('manage_library'), async (req, res, next) => {
  try {
    const category = await taxonomy.saveCategory({
      key: req.body?.key, label: req.body?.label, blurb: req.body?.blurb,
      icon: req.body?.icon, position: req.body?.position,
      isDoor: req.body?.isDoor, active: req.body?.active, by: actorOf(req),
    });
    res.json({ category });
  } catch (err) { next(err); }
});

shelves.delete('/categories/:key', requires('manage_library'), async (req, res, next) => {
  try {
    const category = await taxonomy.removeCategory(req.params.key);
    if (!category) return res.status(404).json({ error: 'not_found' });
    res.json({ removed: true, category });
  } catch (err) { next(err); }
});

shelves.put('/subcategories', requires('manage_library'), async (req, res, next) => {
  try {
    const subcategory = await taxonomy.saveSubcategory({
      id: req.body?.id, key: req.body?.key, categoryKey: req.body?.categoryKey,
      label: req.body?.label, blurb: req.body?.blurb,
      position: req.body?.position, active: req.body?.active, by: actorOf(req),
    });
    if (!subcategory) return res.status(404).json({ error: 'not_found' });
    res.json({ subcategory });
  } catch (err) { next(err); }
});

shelves.delete('/subcategories/:id', requires('manage_library'), async (req, res, next) => {
  try {
    const subcategory = await taxonomy.removeSubcategory(req.params.id);
    if (!subcategory) return res.status(404).json({ error: 'not_found' });
    // The rules that named it keep their weights and stop naming a drawer, so
    // nothing disappears from the home screen — it just stops being sorted.
    res.json({ removed: true, subcategory });
  } catch (err) { next(err); }
});

export default shelves;
