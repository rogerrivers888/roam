/**
 * Menus, orders and the stars on each dish.
 *
 * A captured menu is the one place a provider's words are written down at
 * length, and the licence for it is different: it is the venue's own published
 * page, read from their own site, which is ours to keep (Technical Constraints
 * §13.10). Nothing here holds a third-party aggregator's content.
 *
 * An order in progress is a working note — the table changes its mind. An order
 * that has become a visit is the household's history and is never rewritten by
 * anything in this file except the stars.
 */

import { query } from '../db.js';

const on = (client) => (client ? (text, params) => client.query(text, params) : query);

// ---------------------------------------------------------------------------
// menus
// ---------------------------------------------------------------------------

export async function menuById(menuId) {
  const { rows } = await query('select * from menus where id = $1', [menuId]);
  return rows[0] ?? null;
}

export async function menuItems(menuId) {
  const { rows } = await query('select * from menu_items where menu_id = $1 order by position', [menuId]);
  return rows;
}

/** The most recent menu held for a place, if there is one. */
export async function latestMenuId(householdId, venueRef) {
  const { rows } = await query(
    'select id from menus where household_id = $1 and venue_ref = $2 order by fetched_at desc limit 1',
    [householdId, venueRef],
  );
  return rows[0]?.id ?? null;
}

export async function insertMenu(householdId, m, client) {
  const { rows } = await on(client)(
    `insert into menus (household_id, venue_ref, venue_label, source_url, source_kind, how, currency, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [householdId, m.venueRef, m.venueLabel, m.sourceUrl, m.sourceKind, JSON.stringify(m.how), m.currency, m.note],
  );
  return rows[0].id;
}

export async function insertMenuItem(menuId, item, client) {
  await on(client)(
    `insert into menu_items (menu_id, section, section_note, position, name, description, price, price_text, kcal, allergens, vegetarian)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [menuId, item.section, item.sectionNote ?? null, item.position, item.name, item.description ?? null,
      item.price ?? null, item.priceText ?? null, item.kcal ?? null, item.allergens ?? null, item.vegetarian ?? null],
  );
}

/** Where a place is, when the screen that asked did not say — for finding their menu. */
export async function placeAddress(householdId, venueRef) {
  const { rows } = await query('select locality, postcode from household_places where household_id = $1 and venue_ref = $2', [householdId, venueRef]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// what a dish is
// ---------------------------------------------------------------------------

export async function dishNote(nameKey) {
  const { rows } = await query('select * from dish_notes where name_key = $1', [nameKey]);
  return rows[0] ?? null;
}

/**
 * Keep what a dish is, once.
 *
 * `do nothing` rather than `do update`: two tables asking about arrabbiata at
 * the same moment should cost one answer, and the first one written is as good
 * as the second.
 */
export async function saveDishNote(nameKey, name, note, model) {
  await query(
    `insert into dish_notes (name_key, name, known, what, origin, model)
     values ($1,$2,$3,$4,$5,$6) on conflict (name_key) do nothing`,
    [nameKey, name, note.known, note.what, note.origin ?? null, model],
  );
}

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------

export async function orderById(orderId) {
  const { rows } = await query('select * from orders where id = $1', [orderId]);
  return rows[0] ?? null;
}

export async function orderOfHousehold(orderId, householdId) {
  const { rows } = await query('select * from orders where id = $1 and household_id = $2', [orderId, householdId]);
  return rows[0] ?? null;
}

/** The items on an order, with who had each and what anybody said about it. */
export async function orderItems(orderId) {
  const { rows } = await query(
    `select oi.*, m.name as member_name,
            (select json_agg(json_build_object('memberId', r.member_id, 'score', r.score, 'take', r.take, 'comment', r.comment))
               from ratings r where r.order_item_id = oi.id) as ratings
       from order_items oi left join members m on m.id = oi.member_id
      where oi.order_id = $1 order by oi.position`,
    [orderId],
  );
  return rows;
}

export async function orderItemsPlain(orderId) {
  const { rows } = await query('select id, name, member_id from order_items where order_id = $1', [orderId]);
  return rows;
}

/** The order in progress at a place — the one not yet eaten. */
export async function latestOrderId(householdId, venueRef = null) {
  const { rows } = await query(
    `select id from orders where household_id = $1 ${venueRef ? 'and venue_ref = $2' : ''} order by created_at desc limit 1`,
    venueRef ? [householdId, venueRef] : [householdId],
  );
  return rows[0]?.id ?? null;
}

/** What this household ate here before: only orders that became visits. */
export async function pastOrders(householdId, venueRef, limit) {
  const { rows } = await query(
    `select o.id, o.visit_id, v.visited_on
       from orders o left join visits v on v.id = o.visit_id
      where o.household_id = $1 and o.venue_ref = $2 and o.visit_id is not null
      order by coalesce(v.visited_on, o.created_at::date) desc, o.created_at desc
      limit $3`,
    [householdId, venueRef, limit],
  );
  return rows;
}

export async function orderByClientId(clientId, householdId, client) {
  const { rows } = await on(client)('select id from orders where client_id = $1 and household_id = $2', [clientId, householdId]);
  return rows[0]?.id ?? null;
}

export async function insertOrder(householdId, o, client) {
  const { rows } = await on(client)(
    'insert into orders (client_id, household_id, menu_id, venue_ref, venue_label) values ($1,$2,$3,$4,$5) returning id',
    [o.clientId ?? null, householdId, o.menuId ?? null, o.venueRef, o.venueLabel ?? null],
  );
  return rows[0].id;
}

export async function updateOrder(id, o, client) {
  await on(client)(
    'update orders set menu_id = coalesce($2, menu_id), venue_label = coalesce($3, venue_label), updated_at = now() where id = $1',
    [id, o.menuId ?? null, o.venueLabel ?? null],
  );
}

/** Only ever inside the transaction that immediately writes the items again. */
export async function clearOrderItems(orderId, client) {
  await on(client)('delete from order_items where order_id = $1', [orderId]);
}

export async function insertOrderItem(orderId, item, client) {
  await on(client)(
    `insert into order_items (order_id, menu_item_id, member_id, name, price, price_text, note, position)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [orderId, item.menuItemId ?? null, item.memberId ?? null, item.name, item.price ?? null,
      item.priceText ?? null, item.note ?? null, item.position],
  );
}

export async function deleteOrder(id) {
  await query('delete from orders where id = $1', [id]);
}

export async function attachVisit(orderId, visitId, client) {
  await on(client)('update orders set visit_id = $2, updated_at = now() where id = $1', [orderId, visitId]);
}

// ---------------------------------------------------------------------------
// the meal itself
// ---------------------------------------------------------------------------

/** The visit an order becomes: the join between the rented place and what we own. */
export async function insertMealVisit(householdId, v, client) {
  const { rows } = await on(client)(
    `insert into visits (household_id, venue_ref, venue_label, category, lat, lng, visited_on)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [householdId, v.venueRef, v.venueLabel, v.category, v.lat ?? null, v.lng ?? null, v.visitedOn],
  );
  return rows[0].id;
}

/**
 * Stars on one dish, replacing whatever that person said before (Epic 7 M3).
 *
 * The delete and the insert are one act: sending the same dish again must
 * replace, and a dish nobody rates gets no row at all, because silence is
 * "fine" and should cost nobody a tap.
 */
export async function replaceDishRating(orderItemId, memberId, r, client) {
  await on(client)('delete from ratings where order_item_id = $1 and member_id = $2', [orderItemId, memberId]);
  if (!r) return;
  await on(client)(
    `insert into ratings (visit_id, member_id, subject, take, comment, concept_key, score, order_item_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [r.visitId, memberId, r.subject, r.take, r.comment ?? null, r.conceptKey ?? null, r.score ?? null, orderItemId],
  );
}
