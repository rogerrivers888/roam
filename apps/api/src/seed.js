// Seeds the founding household (Requirements §3, "Create the household record").
// Idempotent: does nothing if a household already exists, unless run with --force.

import { pool, withTransaction } from './db.js';
import * as households from './repositories/households.js';

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
    name: 'Roger', isMinor: false, relationship: 'parent', typicalVisitMinutes: 90,
    constraints: [['dislike', 'italian'], ['like', 'ramen']],
  },
  {
    name: 'Jules', isMinor: false, relationship: 'partner', typicalVisitMinutes: 75,
    constraints: [['allergen', 'shellfish'], ['like', 'seafood']],
  },
  {
    name: 'Sam', isMinor: false, relationship: 'child', birthYear: 2010, typicalVisitMinutes: 60,
    constraints: [['like', 'italian'], ['dislike', 'pub']],
  },
  {
    // Under 13 — profile creation and editing require a consenting adult
    // (Epic 1 C8), and COPPA verifiable parental consent gates any voice
    // capture against this profile (Technical Constraints L1).
    name: 'Ada', isMinor: true, relationship: 'child', birthYear: 2015, typicalVisitMinutes: 45,
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
  const seeded = await households.anyHouseholdExists();

  if (seeded && !force) {
    console.log('household already seeded — pass --force to reseed');
    await pool.end();
    return;
  }

  await withTransaction(async (client) => {
    if (force) await households.deleteAllHouseholds(client);

    const householdId = await households.createHousehold(client, HOUSEHOLD);

    const memberIds = [];
    for (const member of MEMBERS) {
      const memberId = await households.createMember(client, householdId, member);
      memberIds.push(memberId);
      for (const [kind, value] of member.constraints) await households.createConstraint(client, memberId, kind, value);
    }

    void memberIds; // trips are created by the household, not seeded

    console.log(`seeded household ${householdId} with ${MEMBERS.length} members`);
  });

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
