/**
 * What happens to the household's data when something is deleted, and what
 * happens to a write that fails halfway.
 *
 * These are the tests worth having. A screen that renders wrong is obvious; a
 * cascade that takes more than it should, or a half-finished write left behind
 * by an error, is silent and permanent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { aHousehold, testDatabase } from './helpers/db.js';

const { query, withTransaction, pool } = await testDatabase();

test.after(() => pool.end());

test('the migrations build the whole schema from nothing', async () => {
  const { rows } = await query(`
    select table_name from information_schema.tables
     where table_schema = 'public' order by table_name`);
  const tables = rows.map((r) => r.table_name);
  for (const expected of ['households', 'members', 'visits', 'ratings', 'trips', 'trip_stops', 'api_sessions', 'plan_sessions', 'provider_calls']) {
    assert.ok(tables.includes(expected), `${expected} is missing`);
  }
});

test('deleting a person takes their ratings and leaves everyone else alone', async () => {
  const { household, member } = await aHousehold(query);
  const { rows: [other] } = await query('insert into members (household_id, name, is_minor) values ($1, $2, false) returning *', [household.id, 'Someone else']);
  const { rows: [visit] } = await query(
    `insert into visits (household_id, venue_ref, venue_label, visited_on) values ($1, 'osm:node/1', 'A place', current_date) returning *`,
    [household.id],
  );
  await query(`insert into ratings (visit_id, member_id, subject, take) values ($1, $2, 'visit', 'loved')`, [visit.id, member.id]);
  await query(`insert into ratings (visit_id, member_id, subject, take) values ($1, $2, 'visit', 'fine')`, [visit.id, other.id]);

  // Epic 1 M3: deleting a member deletes their profile and rating history. It
  // is meant to take their ratings — the test is that it takes only theirs.
  await query('delete from members where id = $1', [member.id]);

  const { rows: left } = await query('select member_id from ratings where visit_id = $1', [visit.id]);
  assert.equal(left.length, 1, 'only the deleted person’s rating went');
  assert.equal(left[0].member_id, other.id);

  const { rows: visits } = await query('select id from visits where id = $1', [visit.id]);
  assert.equal(visits.length, 1, 'the visit itself survives losing one person’s take');
});

test('deleting the household takes everything of theirs and nobody else’s', async () => {
  const mine = await aHousehold(query, 'The one being deleted');
  const theirs = await aHousehold(query, 'The one that stays');

  for (const h of [mine, theirs]) {
    const { rows: [visit] } = await query(
      `insert into visits (household_id, venue_ref, venue_label, visited_on) values ($1, 'osm:node/2', 'A place', current_date) returning *`, [h.household.id]);
    await query(`insert into ratings (visit_id, member_id, subject, take) values ($1, $2, 'visit', 'loved')`, [visit.id, h.member.id]);
    await query(`insert into provider_calls (household_id, provider, purpose) values ($1, 'google-places', 'test')`, [h.household.id]);
  }

  await withTransaction(async (client) => {
    await client.query('delete from provider_calls where household_id = $1', [mine.household.id]);
    await client.query('delete from households where id = $1', [mine.household.id]);
  });

  const gone = async (sql, id) => (await query(sql, [id])).rows.length;
  assert.equal(await gone('select id from members where household_id = $1', mine.household.id), 0);
  assert.equal(await gone('select id from visits where household_id = $1', mine.household.id), 0);
  assert.equal(await gone('select id from provider_calls where household_id = $1', mine.household.id), 0);

  assert.equal(await gone('select id from members where household_id = $1', theirs.household.id), 1, 'the other household is untouched');
  assert.equal(await gone('select id from visits where household_id = $1', theirs.household.id), 1);
});

test('a write that fails halfway leaves nothing behind', async () => {
  const { household, member } = await aHousehold(query);
  const before = (await query('select id from visits where household_id = $1', [household.id])).rows.length;

  await assert.rejects(withTransaction(async (client) => {
    const { rows: [visit] } = await client.query(
      `insert into visits (household_id, venue_ref, venue_label, visited_on) values ($1, 'osm:node/3', 'Half a visit', current_date) returning *`,
      [household.id],
    );
    await client.query(`insert into ratings (visit_id, member_id, subject, take) values ($1, $2, 'visit', 'loved')`, [visit.id, member.id]);
    // The shape of a real failure: the second half of the write is rejected.
    await client.query(`insert into ratings (visit_id, member_id, subject, take) values ($1, $2, 'visit', 'not-a-take')`, [visit.id, member.id]);
  }));

  const after = (await query('select id from visits where household_id = $1', [household.id])).rows.length;
  assert.equal(after, before, 'the visit rolled back with the rating that failed');
  const orphans = await query('select r.id from ratings r left join visits v on v.id = r.visit_id where v.id is null');
  assert.equal(orphans.rows.length, 0, 'and left no rating behind it');
});

test('the connection is released even when the work throws', async () => {
  // A transaction that leaks its client on the error path exhausts the pool and
  // the API stops answering — under load, and never in development.
  for (let i = 0; i < 12; i += 1) {
    await assert.rejects(withTransaction(async () => { throw new Error('nope'); }));
  }
  const { rows } = await query('select 1 as ok');
  assert.equal(rows[0].ok, 1, 'the pool still has connections to give');
});
