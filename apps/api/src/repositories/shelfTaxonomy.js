/**
 * The two levels, as data.
 *
 * They used to be a list in `domain/moods.js`, which made "add a subcategory" a
 * deploy. The owner, 5 Sep 2026: "we probably need a settings page where we can
 * add the subcategories manually… a settings page where I can see those
 * categories and subcategories." So the vocabulary lives in two tables and the
 * code reads whatever is in them.
 *
 * Read on every home-screen answer, so it is cached in the process for a few
 * seconds and the cache is dropped the moment anything is written — a rename in
 * the back office shows up on the next refresh rather than in a minute's time.
 *
 * **The no-duplication rule lives in the schema, not here.**
 * `shelf_subcategories.key` is unique across the whole table, so a drawer
 * belongs to exactly one cabinet and the database refuses to be told otherwise.
 * Everything in this file can therefore assume it.
 */

import { query } from '../db.js';
import { vocabularyOf } from '../domain/moods.js';

const TTL_MS = 5000;
let cache = null;
let cachedAt = 0;

export const forget = () => { cache = null; };

/** Everything, in one read, in the shapes the resolver and the screens want. */
export async function taxonomy() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const [cats, subs] = await Promise.all([
    query('select * from shelf_categories order by position, label'),
    query('select * from shelf_subcategories order by position, label'),
  ]);
  const categories = cats.rows;
  const subcategories = subs.rows;
  cache = {
    categories,
    subcategories,
    // Only the live ones reach a household; a category switched off in the back
    // office stops being a chip without anything being deleted.
    active: {
      categories: categories.filter((c) => c.active),
      subcategories: subcategories.filter((s) => s.active),
    },
    vocab: vocabularyOf(categories.filter((c) => c.active), subcategories.filter((s) => s.active)),
    byKey: new Map(categories.map((c) => [c.key, c])),
    subByKey: new Map(subcategories.map((s) => [s.key, s])),
  };
  cachedAt = Date.now();
  return cache;
}

const slug = (text) => String(text || '').toLowerCase().trim()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'bad_request' });

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

/**
 * Add or change a category.
 *
 * A new key is minted from the label, and the eight seeded keys are what
 * everything already taught is keyed by — so renaming one is a label change and
 * never a key change. Nothing that has been taught is orphaned by a rename.
 */
export async function saveCategory({ key, label, blurb, icon, position, isDoor, active, by }) {
  const k = key ? String(key) : slug(label);
  if (!k) throw bad('A category needs a name.');
  const { rows } = await query(
    `insert into shelf_categories (key, label, blurb, icon, position, is_door, active, seeded)
     values ($1, $2, $3, $4, coalesce($5, 100), coalesce($6,false), coalesce($7,true), false)
     on conflict (key) do update
        set label    = coalesce($2, shelf_categories.label),
            blurb    = coalesce($3, shelf_categories.blurb),
            icon     = coalesce($4, shelf_categories.icon),
            position = coalesce($5, shelf_categories.position),
            is_door  = coalesce($6, shelf_categories.is_door),
            active   = coalesce($7, shelf_categories.active),
            updated_at = now()
     returning *`,
    [k, label ?? null, blurb ?? null, icon ?? null, position ?? null,
     isDoor == null ? null : Boolean(isDoor), active == null ? null : Boolean(active)]);
  forget();
  return rows[0];
}

/**
 * Take a category away.
 *
 * Refused while anything is still filed under it, because deleting a cabinet
 * with drawers in it would silently drop every place they hold off the home
 * screen. Switch it off instead — that is what `active` is for, and it is
 * reversible.
 */
export async function removeCategory(key) {
  const { rows: subs } = await query('select count(*)::int as n from shelf_subcategories where category_key = $1', [key]);
  if (subs[0].n) throw bad(`${key} still has ${subs[0].n} subcategor${subs[0].n === 1 ? 'y' : 'ies'} in it. Move or delete those first, or switch the category off instead.`);
  const { rows } = await query('delete from shelf_categories where key = $1 returning *', [key]);
  forget();
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// subcategories
// ---------------------------------------------------------------------------

/**
 * Add or change a subcategory.
 *
 * Moving one to another category is allowed and is a single update — the key
 * does not change, so every rule already pointing at it follows it across, and
 * every place filed in that drawer moves shelf with it. That is the intended
 * way to reorganise: move the drawer, not the hundred places inside it.
 */
export async function saveSubcategory({ id, key, categoryKey, label, blurb, position, active, by }) {
  if (!categoryKey && !id) throw bad('A subcategory has to belong to a category.');
  const k = key ? slug(key) : slug(label);
  if (!k && !id) throw bad('A subcategory needs a name.');

  if (id) {
    const { rows } = await query(
      `update shelf_subcategories
          set category_key = coalesce($2, category_key),
              label        = coalesce($3, label),
              blurb        = coalesce($4, blurb),
              position     = coalesce($5, position),
              active       = coalesce($6, active),
              updated_at   = now()
        where id = $1 returning *`,
      [id, categoryKey ?? null, label ?? null, blurb ?? null, position ?? null,
       active == null ? null : Boolean(active)]);
    forget();
    return rows[0] ?? null;
  }

  const { rows } = await query(
    `insert into shelf_subcategories (category_key, key, label, blurb, position, seeded)
     values ($1, $2, $3, $4, coalesce($5, 100), false)
     on conflict (key) do update
        set category_key = excluded.category_key,
            label        = excluded.label,
            blurb        = coalesce(excluded.blurb, shelf_subcategories.blurb),
            position     = coalesce($5, shelf_subcategories.position),
            updated_at   = now()
     returning *`,
    [categoryKey, k, label ?? k, blurb ?? null, position ?? null]);
  forget();
  return rows[0];
}

/**
 * Take a subcategory away.
 *
 * The rules pointing at it are not deleted with it: the foreign key is `on
 * delete set null`, so they keep their weights and simply stop naming a drawer.
 * A place filed there falls back to whichever category its weights earn, which
 * is the same place it would have been before anybody made the drawer.
 */
export async function removeSubcategory(id) {
  const { rows } = await query('delete from shelf_subcategories where id = $1 returning *', [id]);
  forget();
  return rows[0] ?? null;
}

/** How many places each drawer is holding, so the settings page is not a guess. */
export async function subcategoryUse() {
  const { rows } = await query(
    `select subcategory, count(*)::int as rules
       from shelf_rules where subcategory is not null group by subcategory`);
  return new Map(rows.map((r) => [r.subcategory, r.rules]));
}
