// The table half of an evening (owner, 4 Sep 2026).
//
//   GET  /api/menu?ref=…          the menu we hold for this place, if we hold one
//   POST /api/menu/read           read it now from their own page (sources/menuRead.js)
//   GET  /api/menu/openers        which openers this machine has (does it have a browser?)
//   GET  /api/orders?ref=…        the order in progress here
//   POST /api/orders              write the order (who is having what)
//   POST /api/orders/:id/eaten    we ate it: makes the visit
//   POST /api/orders/:id/ratings  stars on the dishes that stood out
//
// The rating rule is the owner's, and it is not the three-way take: "if I
// review something and give it a number of stars, that means it's good. If I
// don't, then it's okay… if it's not great, I'll probably give it a negative
// review". So stars are only ever written for a dish somebody starred, a dish
// nobody touched is left with no row at all — silence means fine and costs
// nothing to say — and "not great" is its own one-tap answer. The planner still
// learns from the three-way take underneath, which the score decides.

import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { recordMenuRead, knownMenu } from '../domain/placeMenus.js';
import { currentHousehold, loadMembers } from './household.js';
import { recallVenue } from '../sources/index.js';
import { findMenuUrl } from '../sources/menuLink.js';
import { readMenu, chromePath, renderProbe, describeDish } from '../sources/menuRead.js';
import { resolveConcept, matchConcepts, conceptByKey } from '../domain/concepts.js';
import { upsertHouseholdPlace } from './atlas.js';

export const menu = Router();
export const orders = Router();

// A menu older than this is still shown, with its date, and its prices marked
// as printed then rather than now (Epic 6 C8; the threshold was the owner's to
// set and 30 days is the standing suggestion until he moves it).
export const STALE_DAYS = Number(process.env.ROAM_MENU_STALE_DAYS || 30);

const SYMBOLS = { GBP: '£', '£': '£', EUR: '€', '€': '€', USD: '$', $: '$' };
/**
 * A price as a menu would print it. Sites often draw the number alone and let
 * the page's currency do the rest ("17.5"), so the symbol is put back and the
 * pennies are made to look like pennies — "£17.50", and "£7.50 / £9.50" for a
 * wine sold three ways.
 */
const priceLabel = (raw, currency) => {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/[£€$]/.test(text)) return text;
  const symbol = SYMBOLS[String(currency ?? '').toUpperCase()] ?? SYMBOLS[String(currency ?? '')] ?? '£';
  return text.replace(/\d+(?:[.,]\d{1,2})?/g, (n) => {
    const v = Number(n.replace(',', '.'));
    return `${symbol}${Number.isInteger(v) ? v : v.toFixed(2)}`;
  });
};
const money = (text) => {
  const m = String(text ?? '').match(/(\d+(?:[.,]\d{1,2})?)/);
  return m ? Number(m[1].replace(',', '.')) : null;
};

async function menuPayload(menuId) {
  const { rows } = await query('select * from menus where id = $1', [menuId]);
  const m = rows[0];
  if (!m) return null;
  const { rows: items } = await query('select * from menu_items where menu_id = $1 order by position', [menuId]);
  const sections = [];
  for (const i of items) {
    let section = sections.find((s) => s.title === i.section);
    if (!section) sections.push((section = { title: i.section, note: i.section_note, items: [] }));
    section.items.push({
      id: i.id, name: i.name, description: i.description, price: i.price == null ? null : Number(i.price),
      priceText: priceLabel(i.price_text, m.currency), kcal: i.kcal, allergens: i.allergens, vegetarian: i.vegetarian,
    });
  }
  const ageDays = Math.floor((Date.now() - new Date(m.fetched_at).getTime()) / 86_400_000);
  return {
    id: m.id, venueRef: m.venue_ref, venueLabel: m.venue_label, sourceUrl: m.source_url, sourceKind: m.source_kind,
    how: m.how ?? [], currency: m.currency, note: m.note, fetchedAt: m.fetched_at,
    ageDays, stale: ageDays >= STALE_DAYS, staleAfterDays: STALE_DAYS,
    items: items.length, sections,
  };
}

/** The dish concept a menu name carries: certain, likely, or neither. */
function conceptOf(name) {
  const sure = resolveConcept(name, { kinds: ['dish'] });
  if (sure) return { concept: { key: sure.key, label: sure.label }, conceptSuggestion: null };
  const [near] = matchConcepts(name, { kinds: ['dish'], limit: 1 });
  return { concept: null, conceptSuggestion: near && near.score >= 0.6 ? { key: near.key, label: near.label, score: near.score } : null };
}

async function orderPayload(orderId) {
  const { rows } = await query('select * from orders where id = $1', [orderId]);
  const o = rows[0];
  if (!o) return null;
  const { rows: items } = await query(
    `select oi.*, m.name as member_name,
            (select json_agg(json_build_object('memberId', r.member_id, 'score', r.score, 'take', r.take, 'comment', r.comment))
               from ratings r where r.order_item_id = oi.id) as ratings
       from order_items oi left join members m on m.id = oi.member_id
      where oi.order_id = $1 order by oi.position`,
    [orderId],
  );
  return {
    id: o.id, clientId: o.client_id, venueRef: o.venue_ref, venueLabel: o.venue_label, menuId: o.menu_id,
    visitId: o.visit_id, createdAt: o.created_at, updatedAt: o.updated_at,
    items: items.map((i) => ({
      id: i.id, menuItemId: i.menu_item_id, memberId: i.member_id, member: i.member_name,
      name: i.name, price: i.price == null ? null : Number(i.price), priceText: i.price_text, note: i.note,
      ratings: (i.ratings ?? []).map((r) => ({ ...r, score: r.score == null ? null : Number(r.score) })),
      // What this dish is, in the household's own vocabulary. A menu writes
      // "Spaghettoni al Ragù" where the family says bolognese; that is a match
      // worth offering and never one to make silently (Epic 2 C7), so a sure
      // one is `concept` and a likely one is `conceptSuggestion` for a tap.
      ...conceptOf(i.name),
    })),
    total: items.reduce((n, i) => n + (i.price == null ? 0 : Number(i.price)), 0),
  };
}

/** GET /api/menu?ref=… — what we hold, and where their menu is if we hold nothing. */
menu.get('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const ref = String(req.query.ref || '').trim();
    if (!ref) return res.status(400).json({ error: 'ref_required' });
    const { rows } = await query(
      'select id from menus where household_id = $1 and venue_ref = $2 order by fetched_at desc limit 1',
      [household.id, ref],
    );
    const held = rows[0] ? await menuPayload(rows[0].id) : null;
    let link = null;
    if (!held) {
      const venue = recallVenue(ref);
      const website = String(req.query?.website || venue?.website || '').trim();
      if (website) {
        let locality = venue?.locality ?? null;
        let address = typeof venue?.address === 'string' ? venue.address : venue?.address?.line1 ?? null;
        if (!locality && !address) {
          const { rows: at } = await query('select locality, postcode from household_places where household_id = $1 and venue_ref = $2', [household.id, ref]);
          if (at[0]) { locality = at[0].locality ?? null; address = at[0].postcode ?? null; }
        }
        link = await findMenuUrl({ website, name: venue?.name ?? '', locality, address });
      }
    }
    res.json({ menu: held, link });
  } catch (err) { next(err); }
});

/** GET /api/menu/openers — which of the four ways of opening a menu this machine can use. */
menu.get('/openers', async (req, res, next) => {
  try {
    const browser = await chromePath();
    // ?probe=1 actually drives the browser once, because "the binary is there"
    // and "it runs in this container" are different questions.
    const probe = req.query.probe ? await renderProbe(String(req.query.probe)) : null;
    res.json({
      html: true,
      pdf: true,
      rendered: Boolean(browser),
      browser: browser ? browser.split('/').slice(-1)[0] : null,
      claude: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
      staleAfterDays: STALE_DAYS,
      probe,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/menu/read { ref, url?, label?, website? }
 *
 * Reads their menu into dishes. The address is followed from the website Google
 * gave us unless one is passed. This spends: one Claude call per menu, more if
 * the menu has to be read off the open web. It runs on a tap, never on a search.
 */
menu.post('/read', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const ref = String(req.body?.ref || '').trim();
    if (!ref) return res.status(400).json({ error: 'ref_required' });

    const venue = recallVenue(ref);
    const label = String(req.body?.label || venue?.name || '').trim() || null;
    const website = String(req.body?.website || venue?.website || '').trim();

    // Which town this one is in. A licensed venue is never held in memory, so
    // for a group with two restaurants the answer comes from the atlas — where
    // the place already carries its locality and postcode — or from the screen
    // that asked (owner, 4 Sep 2026: the Windsor menu was one click away).
    let locality = String(req.body?.locality || venue?.locality || '').trim() || null;
    let address = String(req.body?.address || (typeof venue?.address === 'string' ? venue.address : venue?.address?.line1) || '').trim() || null;
    if (!locality && !address) {
      const { rows } = await query('select locality, postcode from household_places where household_id = $1 and venue_ref = $2', [household.id, ref]);
      if (rows[0]) { locality = rows[0].locality ?? null; address = rows[0].postcode ?? null; }
    }

    let url = String(req.body?.url || '').trim();
    let found = null;
    if (!url) {
      found = await findMenuUrl({ website, name: label ?? '', locality, address });
      url = found?.url || '';
    }
    if (!url) {
      return res.status(404).json({
        error: 'no_menu_address',
        message: found?.why || 'No website for this place, so there is nothing to follow.',
      });
    }

    let read;
    try {
      read = await readMenu({
        url, venueLabel: label, householdId: household.id, sessionId: req.body?.sessionId ?? null,
        // { dryRun: true } opens the menu and stops before Claude: it says which
        // opener worked and how much text it got, and costs nothing.
        dryRun: req.body?.dryRun === true,
      });
      if (read.dryRun) return res.json({ dryRun: read });
    } catch (err) {
      if (err.status === 422) {
        return res.status(422).json({
          error: err.message,
          message: 'Their menu would not open — it may be a picture, or behind a booking flow. Photograph it instead.',
          how: err.steps ?? [],
          url,
        });
      }
      throw err;
    }

    const menuId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into menus (household_id, venue_ref, venue_label, source_url, source_kind, how, currency, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [household.id, ref, label, read.sourceUrl, read.kind, JSON.stringify(read.how), read.currency, read.note],
      );
      const id = rows[0].id;
      let position = 0;
      for (const section of read.sections) {
        for (const item of section.items) {
          await client.query(
            `insert into menu_items (menu_id, section, section_note, position, name, description, price, price_text, kcal, allergens, vegetarian)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [id, section.title, section.note ?? null, position += 1, item.name, item.description ?? null,
             money(item.price), item.price ?? null, item.kcal ?? null, item.allergens ?? null, item.vegetarian ?? null],
          );
        }
      }
      return id;
    });

    // The same read, recorded against the place as well as the household, so the
    // next family to open this restaurant sees what this one found and does not
    // pay to read it again (owner, 4 Sep 2026). Behind the response, and it
    // cannot fail the household's own copy.
    recordMenuRead({ venueRef: ref, venueLabel: label, read }).catch(() => null);

    res.status(201).json({ menu: await menuPayload(menuId) });
  } catch (err) { next(err); }
});

/**
 * GET /api/menu/known?ref=… — the menu Roam knows for a place, whoever read it.
 *
 * Not the household's own copy (that is GET /api/menu?ref=…, and it carries the
 * restaurant's descriptions). This is the pooled record: dish names, prices and
 * sections, kept for good and replaced whenever anyone reads the menu again.
 * Online only, on purpose — a menu is what you look at on the way in, and the
 * address of it is what the offline record carries.
 */
menu.get('/known', async (req, res, next) => {
  try {
    const ref = String(req.query.ref || '').trim();
    if (!ref) return res.status(400).json({ error: 'ref_required' });
    const known = await knownMenu(ref);
    if (!known) return res.status(404).json({ error: 'no_menu_known', message: 'Nobody has read this menu yet.' });
    res.json({ menu: known });
  } catch (err) { next(err); }
});

/**
 * POST /api/menu/dish { name, hint? } — "What's this?"
 *
 * A line about the dish itself, for a menu that gives only a name in another
 * language. Written once and kept for everyone: it is Roam's own words about a
 * dish in general, not the restaurant's copy, so the next household to ask a
 * question about supplì does not pay for the answer again.
 */
menu.post('/dish', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name_required' });
    const key = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

    const { rows } = await query('select * from dish_notes where name_key = $1', [key]);
    if (rows[0]) {
      const d = rows[0];
      return res.json({ dish: { name: d.name, known: d.known, what: d.what, origin: d.origin }, cached: true });
    }

    const note = await describeDish({
      name,
      hint: String(req.body?.hint || '').trim() || null,
      householdId: household.id,
      sessionId: req.body?.sessionId ?? null,
    });
    await query(
      `insert into dish_notes (name_key, name, known, what, origin, model)
       values ($1,$2,$3,$4,$5,$6) on conflict (name_key) do nothing`,
      [key, name, note.known !== false, note.what, note.origin ?? null, process.env.ROAM_MENU_MODEL || 'claude-sonnet-5'],
    );
    res.json({ dish: { name, known: note.known !== false, what: note.what, origin: note.origin ?? null }, cached: false });
  } catch (err) { next(err); }
});

/** GET /api/orders?ref=… — the order in progress at this place (the one not yet eaten). */
orders.get('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const ref = String(req.query.ref || '').trim();
    const { rows } = await query(
      `select id from orders where household_id = $1 ${ref ? 'and venue_ref = $2' : ''} order by created_at desc limit 1`,
      ref ? [household.id, ref] : [household.id],
    );
    res.json({ order: rows[0] ? await orderPayload(rows[0].id) : null });
  } catch (err) { next(err); }
});

/**
 * GET /api/orders/history?ref=… — what this household ate here before.
 *
 * The order is the record of the meal: who had what, and the stars anyone gave
 * it afterwards. It is what "our history here" should show (owner, 4 Sep 2026:
 * "I really want to see what they ordered… what each person loved"), and it is
 * what a table orders from when they come back and want the same again.
 */
orders.get('/history', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const ref = String(req.query.ref || '').trim();
    if (!ref) return res.status(400).json({ error: 'ref_required' });
    const { rows } = await query(
      `select o.id, o.visit_id, v.visited_on
         from orders o left join visits v on v.id = o.visit_id
        where o.household_id = $1 and o.venue_ref = $2 and o.visit_id is not null
        order by coalesce(v.visited_on, o.created_at::date) desc, o.created_at desc
        limit $3`,
      [household.id, ref, Math.min(Number(req.query.limit) || 5, 20)],
    );
    const past = await Promise.all(rows.map(async (r) => ({
      ...(await orderPayload(r.id)),
      visitedOn: r.visited_on,
    })));
    res.json({ orders: past.filter((o) => o.items.length) });
  } catch (err) { next(err); }
});

/**
 * POST /api/orders { clientId?, ref, label?, menuId?, items: [{ menuItemId?, memberId|null, name, priceText, note }] }
 *
 * The whole order every time: the phone holds the truth while the table is
 * choosing, and the same client id twice updates rather than duplicates, so a
 * retry after a basement dead spot cannot order two dinners (Epic 6 C5).
 */
orders.post('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const b = req.body || {};
    const ref = String(b.ref || '').trim();
    if (!ref) return res.status(400).json({ error: 'ref_required' });
    const members = await loadMembers(household.id);
    const items = (Array.isArray(b.items) ? b.items : []).filter((i) => String(i?.name || '').trim());

    const orderId = await withTransaction(async (client) => {
      let id = null;
      if (b.clientId) {
        const { rows } = await client.query('select id from orders where client_id = $1 and household_id = $2', [b.clientId, household.id]);
        id = rows[0]?.id ?? null;
      }
      if (id) {
        await client.query('update orders set menu_id = coalesce($2, menu_id), venue_label = coalesce($3, venue_label), updated_at = now() where id = $1',
          [id, b.menuId ?? null, b.label ?? null]);
        await client.query('delete from order_items where order_id = $1', [id]);
      } else {
        const { rows } = await client.query(
          'insert into orders (client_id, household_id, menu_id, venue_ref, venue_label) values ($1,$2,$3,$4,$5) returning id',
          [b.clientId ?? null, household.id, b.menuId ?? null, ref, b.label ?? null],
        );
        id = rows[0].id;
      }
      let position = 0;
      for (const item of items) {
        const memberId = members.some((m) => m.id === item.memberId) ? item.memberId : null;
        await client.query(
          `insert into order_items (order_id, menu_item_id, member_id, name, price, price_text, note, position)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, item.menuItemId ?? null, memberId, String(item.name).trim(), money(item.priceText ?? item.price),
           item.priceText ?? null, String(item.note || '').trim() || null, position += 1],
        );
      }
      return id;
    });

    res.status(201).json({ order: await orderPayload(orderId) });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/orders/:id — throw the order away.
 *
 * An order in progress is a working note, not a record: the table changes its
 * mind, or somebody taps the wrong face. An order that has become a visit stays,
 * because the visit and its stars are the household's history.
 */
orders.delete('/:id', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { rows } = await query('select * from orders where id = $1 and household_id = $2', [req.params.id, household.id]);
    if (!rows[0]) return res.status(404).json({ error: 'order_not_found' });
    if (rows[0].visit_id) return res.status(409).json({ error: 'already_eaten', message: 'This one became a visit. Change it there rather than here.' });
    await query('delete from orders where id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/orders/:id/eaten { visitedOn?, attendeeIds?, lat?, lng?, category? }
 *
 * We ate it. That makes the visit — the join between the rented place and
 * everything the household owns about it (Epic 7 C1) — and hangs the order off
 * it, so the stars have somewhere to live.
 */
orders.post('/:id/eaten', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { rows } = await query('select * from orders where id = $1 and household_id = $2', [req.params.id, household.id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    if (order.visit_id) return res.json({ order: await orderPayload(order.id), visitId: order.visit_id, already: true });

    const b = req.body || {};
    const members = await loadMembers(household.id);
    const attendeeIds = (Array.isArray(b.attendeeIds) && b.attendeeIds.length ? b.attendeeIds : members.map((m) => m.id))
      .filter((id) => members.some((m) => m.id === id));
    const venue = recallVenue(order.venue_ref);
    const visitedOn = b.visitedOn || new Date().toISOString().slice(0, 10);

    const visitId = await withTransaction(async (client) => {
      const { rows: made } = await client.query(
        `insert into visits (household_id, venue_ref, venue_label, category, lat, lng, visited_on)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [household.id, order.venue_ref, order.venue_label || venue?.name || 'Where we ate',
         b.category ?? venue?.category ?? 'restaurant', b.lat ?? venue?.lat ?? null, b.lng ?? venue?.lng ?? null, visitedOn],
      );
      const id = made[0].id;
      for (const memberId of attendeeIds) {
        await client.query('insert into visit_attendees (visit_id, member_id) values ($1,$2) on conflict do nothing', [id, memberId]);
      }
      const [source, ...rest] = order.venue_ref.split(':');
      await client.query('insert into place_ledger (household_id, source, source_place_id, status) values ($1,$2,$3,$4)',
        [household.id, source, rest.join(':'), 'visited']);
      await upsertHouseholdPlace(client, household.id, {
        venueRef: order.venue_ref, label: order.venue_label || venue?.name, category: b.category ?? venue?.category ?? 'restaurant',
        lat: b.lat ?? venue?.lat, lng: b.lng ?? venue?.lng, venue,
      });
      await client.query('update orders set visit_id = $2, updated_at = now() where id = $1', [order.id, id]);
      return id;
    });

    res.status(201).json({ order: await orderPayload(order.id), visitId });
  } catch (err) { next(err); }
});

/**
 * POST /api/orders/:id/ratings { ratings: [{ orderItemId, memberId, score?, notGreat?, comment? }] }
 *
 * Stars on what stood out. A dish nobody rated gets no row: silence is "fine",
 * which is the answer for most plates and should cost nobody a tap. Sending the
 * same dish again replaces what was there (Epic 7 M3).
 */
orders.post('/:id/ratings', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { rows } = await query('select * from orders where id = $1 and household_id = $2', [req.params.id, household.id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    if (!order.visit_id) return res.status(409).json({ error: 'not_eaten', message: 'Say you ate it first — the stars hang off the visit.' });

    const { rows: items } = await query('select id, name, member_id from order_items where order_id = $1', [order.id]);
    const members = await loadMembers(household.id);
    const list = Array.isArray(req.body?.ratings) ? req.body.ratings : [];

    await withTransaction(async (client) => {
      for (const r of list) {
        const item = items.find((i) => i.id === r.orderItemId);
        if (!item) continue;
        // Whoever had it, unless the order says it was for the table and the
        // screen names the person who is speaking.
        const memberId = members.some((m) => m.id === r.memberId) ? r.memberId : item.member_id;
        if (!memberId) continue;
        const score = Number(r.score);
        const stars = Number.isFinite(score) && score >= 0.5 && score <= 5 && Math.round(score * 2) === score * 2 ? score : null;
        await client.query('delete from ratings where order_item_id = $1 and member_id = $2', [item.id, memberId]);
        if (!stars && !r.notGreat) continue;   // untouched stays untouched: silence is fine
        const confirmed = r.conceptKey ? conceptByKey(r.conceptKey) : null;
        const concept = confirmed ?? resolveConcept(item.name, { kinds: ['dish'] });
        await client.query(
          `insert into ratings (visit_id, member_id, subject, take, comment, concept_key, score, order_item_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [order.visit_id, memberId, item.name, r.notGreat ? 'not_for_me' : 'loved',
           String(r.comment || '').trim() || null, concept?.key ?? null, r.notGreat ? null : stars, item.id],
        );
      }
    });

    res.json({ order: await orderPayload(order.id) });
  } catch (err) { next(err); }
});
