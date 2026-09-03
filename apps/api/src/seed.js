// Seeds the founding household (Requirements §3, "Create the household record").
// Idempotent: does nothing if a household already exists, unless run with --force.

import { pool, query, withTransaction } from './db.js';

const HOUSEHOLD = {
  name: 'Founding household',
  defaultVisitMinutes: 75,
  maxTravelMinutes: 45,
  defaultIntensity: 'balanced',
};

// Allergens exclude; dislikes and likes only rank. The set below is chosen to
// exercise all three paths plus the Epic 1 C6 conflict case: Roger dislikes
// italian while Sam likes it, so both must surface against the same candidate.
const MEMBERS = [
  {
    name: 'Roger', isMinor: false, typicalVisitMinutes: 90,
    constraints: [['dislike', 'italian'], ['like', 'ramen']],
  },
  {
    name: 'Jules', isMinor: false, typicalVisitMinutes: 75,
    constraints: [['allergen', 'shellfish'], ['like', 'seafood']],
  },
  {
    name: 'Sam', isMinor: false, typicalVisitMinutes: 60,
    constraints: [['like', 'italian'], ['dislike', 'pub']],
  },
  {
    // Under 13 — profile creation and editing require a consenting adult
    // (Epic 1 C8), and COPPA verifiable parental consent gates any voice
    // capture against this profile (Technical Constraints L1).
    name: 'Ada', isMinor: true, typicalVisitMinutes: 45,
    constraints: [['allergen', 'tree nuts'], ['dislike', 'barbecue']],
  },
];

function nextSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  return d;
}

async function main() {
  const force = process.argv.includes('--force');
  const { rows: existing } = await query('select id from households limit 1');

  if (existing.length && !force) {
    console.log('household already seeded — pass --force to reseed');
    await pool.end();
    return;
  }

  await withTransaction(async (client) => {
    if (force) await client.query('delete from households');

    const { rows } = await client.query(
      `insert into households (name, default_visit_minutes, max_travel_minutes, default_intensity)
       values ($1, $2, $3, $4) returning id`,
      [HOUSEHOLD.name, HOUSEHOLD.defaultVisitMinutes, HOUSEHOLD.maxTravelMinutes, HOUSEHOLD.defaultIntensity],
    );
    const householdId = rows[0].id;

    const memberIds = [];
    for (const member of MEMBERS) {
      const { rows: created } = await client.query(
        `insert into members (household_id, name, is_minor, typical_visit_minutes)
         values ($1, $2, $3, $4) returning id`,
        [householdId, member.name, member.isMinor, member.typicalVisitMinutes],
      );
      memberIds.push(created[0].id);
      for (const [kind, value] of member.constraints) {
        await client.query(
          'insert into member_constraints (member_id, kind, value) values ($1, $2, $3)',
          [created[0].id, kind, value],
        );
      }
    }

    // One trip to open on, shaped like the motivating example in §1: a fixed
    // commitment with time either side of it.
    const saturday = nextSaturday();
    const departAt = new Date(saturday);
    departAt.setHours(11, 0, 0, 0);
    const returnAt = new Date(saturday);
    returnAt.setHours(18, 30, 0, 0);

    const { rows: trip } = await client.query(
      `insert into trips (household_id, title, origin_label, origin_lat, origin_lng,
                          destination_label, destination_lat, destination_lng,
                          depart_at, return_at, travel_mode, intensity)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [householdId, 'Saturday matinée', 'Home', 42.3529, -71.0621,
       'Tidewater Maritime Museum', 42.3548, -71.0480,
       departAt.toISOString(), returnAt.toISOString(), 'transit', 'balanced'],
    );

    for (const memberId of memberIds) {
      await client.query('insert into trip_attendees (trip_id, member_id) values ($1, $2)', [
        trip[0].id, memberId,
      ]);
    }

    console.log(`seeded household ${householdId} with ${MEMBERS.length} members and 1 trip`);
  });

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
