/**
 * Somewhere to sleep, now that there is a price on it.
 *
 * The Stay tab joins two sources that answer different questions — the open map
 * knows where the beds are, LiteAPI knows what they cost — and the value of the
 * screen is entirely in the join. So what is tested here is the join and the
 * arithmetic around it: that one hotel in both lists is one row and not two,
 * that the row we keep is the open one, that a child's age is worked out rather
 * than guessed, and that a night is a night whatever the clocks did.
 *
 * No network. The rates call is answered by a stubbed fetch, which also pins
 * the request body: LiteAPI rejects a search with no nationality or currency,
 * and that is the kind of thing that is only ever found in production.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBeds } from '../src/sources/stays.js';
import { occupanciesFor, nightsBetween, ratesNear, liteapiKeyKind } from '../src/sources/liteapi.js';
import { partyForStay, ageOn, rankStays } from '../src/domain/stays.js';

// ---------------------------------------------------------------------------
// one hotel, two sources
// ---------------------------------------------------------------------------

const osmBed = (name, lat, lng) => ({ name, lat, lng, venueRef: `osm:node/${name.length}`, source: 'osm', stars: null });
const licensed = (name, lat, lng, total) => ({
  name, lat, lng, venueRef: `liteapi:lp_${name.length}`, source: 'liteapi', stars: 4,
  offer: { total, currency: 'GBP', perNight: total / 2 },
});

test('a hotel the map and the price source both hold is one row, and the row is the open one', () => {
  const out = mergeBeds(
    [osmBed('Premier Inn Windsor', 51.4800, -0.6100)],
    [licensed('Premier Inn Windsor Town Centre', 51.4801, -0.6101, 210)],
  );
  assert.equal(out.length, 1);
  // The reference we keep, the name we show and the address are OpenStreetMap's:
  // those are ours for good. All the licensed record adds is the price.
  assert.equal(out[0].venueRef, 'osm:node/19');
  assert.equal(out[0].name, 'Premier Inn Windsor');
  assert.equal(out[0].offer.total, 210);
  assert.equal(out[0].bookRef, 'liteapi:lp_31');
});

test('a hotel nobody has mapped still gets a row, carrying its own reference', () => {
  const out = mergeBeds([], [licensed('Sir Christopher Wren', 51.482, -0.609, 340)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].venueRef, 'liteapi:lp_20');
  assert.equal(out[0].offer.total, 340);
});

test('two different hotels with a word in common are two hotels', () => {
  // Both are "Premier"; neither is the other, and merging them would put one
  // hotel's price on another one's door.
  const out = mergeBeds(
    [osmBed('Premier Inn Windsor', 51.4800, -0.6100)],
    [licensed('Premier Suites Windsor', 51.4802, -0.6102, 400)],
  );
  assert.equal(out.length, 2);
});

test('the same name across town is not the same hotel', () => {
  const out = mergeBeds(
    [osmBed('The Castle Hotel', 51.4800, -0.6100)],
    [licensed('The Castle Hotel', 51.5200, -0.6100, 180)],
  );
  assert.equal(out.length, 2);
});

test('one licensed hotel cannot claim two open beds', () => {
  const out = mergeBeds(
    [osmBed('Castle Hotel', 51.4800, -0.6100), osmBed('Castle Hotell', 51.4801, -0.6100)],
    [licensed('Castle Hotel', 51.48005, -0.6100, 180)],
  );
  assert.equal(out.length, 2);
  assert.equal(out.filter((b) => b.offer).length, 1);
});

// ---------------------------------------------------------------------------
// the price does not change the ranking
// ---------------------------------------------------------------------------

test('a bed is still ranked by how much of the week is on foot from its door', () => {
  const anchors = [{ label: 'Windsor Castle', lat: 51.4839, lng: -0.6044 }];
  const [first] = rankStays(
    [
      { name: 'Miles away, cheap', lat: 51.52, lng: -0.61, offer: { total: 90 } },
      { name: 'On the doorstep', lat: 51.4840, lng: -0.6045, offer: { total: 400 } },
    ],
    { anchors, centre: anchors[0], mode: 'walking' },
  );
  // The cheap one is not the answer, and the price never entered the sort.
  assert.equal(first.name, 'On the doorstep');
});

// ---------------------------------------------------------------------------
// who the room is for
// ---------------------------------------------------------------------------

test('a child is priced by age, from whichever of the two birthdays we hold', () => {
  assert.equal(ageOn({ birth_date: '2018-03-01' }, '2026-10-10'), 8);
  // The day before the birthday is still the younger age.
  assert.equal(ageOn({ birth_date: '2018-03-01' }, '2026-02-28'), 7);
  // A year alone cannot say whether the birthday has been; the younger, safer
  // answer is the one taken.
  assert.equal(ageOn({ birth_year: 2016 }, '2026-10-10'), 9);
  assert.equal(ageOn({ birth_year: null, birth_date: null }, '2026-10-10'), null);
});

test('the party is the people coming, and an age we had to assume is named', () => {
  const p = partyForStay([
    { name: 'Roger', is_minor: false, birth_year: 1980 },
    { name: 'Nina', is_minor: true, birth_date: '2018-03-01' },
    { name: 'Sam', is_minor: true },
  ], { on: '2026-10-10' });
  assert.equal(p.adults, 1);
  assert.deepEqual(p.childAges, [8, 10]);
  // Never a silent guess: the screen has to be able to offer to fix it.
  assert.deepEqual(p.assumed, ['Sam']);
});

test('nobody named yet is two adults, and says it was not derived', () => {
  const p = partyForStay([]);
  assert.equal(p.adults, 2);
  assert.equal(p.derived, false);
});

test('a seventeen-year-old is a child to a hotel even though Roam calls them an adult', () => {
  const p = partyForStay([{ name: 'Alex', is_minor: false, birth_year: 2010 }], { on: '2026-10-10' });
  assert.deepEqual(p.childAges, [15]);
  // And a room of children alone is never asked for.
  assert.equal(p.adults, 1);
});

test('rooms take the adults between them and never leave one empty', () => {
  assert.deepEqual(occupanciesFor({ adults: 2, childAges: [8, 11], rooms: 1 }), [{ adults: 2, children: [8, 11] }]);
  assert.deepEqual(occupanciesFor({ adults: 4, childAges: [], rooms: 2 }), [{ adults: 2, children: [] }, { adults: 2, children: [] }]);
  assert.deepEqual(occupanciesFor({ adults: 3, childAges: [], rooms: 2 }), [{ adults: 2, children: [] }, { adults: 1, children: [] }]);
  assert.deepEqual(occupanciesFor({ adults: 1, childAges: [], rooms: 2 }), [{ adults: 1, children: [] }, { adults: 1, children: [] }]);
});

test('nights are counted in days, so British Summer Time cannot lose one', () => {
  assert.equal(nightsBetween('2026-10-23', '2026-10-26'), 3);
  assert.equal(nightsBetween('2026-10-23', '2026-10-23'), 0);
  assert.equal(nightsBetween(null, '2026-10-26'), 0);
});

// ---------------------------------------------------------------------------
// what comes back off the wire
// ---------------------------------------------------------------------------

const RATES_BODY = {
  data: [{
    hotelId: 'lp1',
    roomTypes: [
      {
        offerId: 'dear', offerRetailRate: { amount: 540, currency: 'GBP' },
        rates: [{ name: 'Suite', boardName: 'Room only', cancellationPolicies: { refundableTag: 'NRFN' } }],
      },
      {
        offerId: 'cheap', offerRetailRate: { amount: 312.5, currency: 'GBP' },
        rates: [{
          name: 'Family room', boardName: 'Breakfast included',
          cancellationPolicies: { refundableTag: 'RFN', cancelPolicyInfos: [{ amount: 0, cancelTime: '2026-10-20 23:59:00' }] },
        }],
      },
    ],
  }],
};

test('the cheapest room at a hotel is the one on the row, with the terms it comes on', async (t) => {
  process.env.LITEAPI_KEY = 'sand_test';
  let sent = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body), key: init.headers['X-API-Key'] };
    return { ok: true, status: 200, json: async () => RATES_BODY };
  };
  t.after(() => { globalThis.fetch = real; delete process.env.LITEAPI_KEY; });

  const { offers, nights } = await ratesNear({ lat: 51.48, lng: -0.61 }, 2, {
    checkin: '2026-10-23', checkout: '2026-10-26',
    occupancies: [{ adults: 2, children: [8] }],
  });

  assert.equal(nights, 3);
  const offer = offers.get('lp1');
  assert.equal(offer.total, 312.5);
  assert.equal(offer.perNight, 104.17);
  assert.equal(offer.board, 'Breakfast included');
  assert.equal(offer.refundable, true);
  assert.equal(offer.freeUntil, '2026-10-20 23:59:00');

  // The request LiteAPI actually needs: the key in its own header (never a
  // query string, never the browser), a radius in metres at or above their
  // minimum, and the currency and nationality that decide the price.
  assert.equal(sent.key, 'sand_test');
  assert.match(sent.url, /\/v3\.0\/hotels\/rates$/);
  assert.equal(sent.body.radius, 2000);
  assert.equal(sent.body.currency, 'GBP');
  assert.equal(sent.body.guestNationality, 'GB');
  assert.deepEqual(sent.body.occupancies, [{ adults: 2, children: [8] }]);
  // A sandbox key is invented inventory at invented prices, and the app has to
  // be able to say so.
  assert.equal(liteapiKeyKind(), 'sandbox');
});

test('a radius under LiteAPI’s minimum is raised rather than rejected', async (t) => {
  process.env.LITEAPI_KEY = 'prod_test';
  let sent = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
  t.after(() => { globalThis.fetch = real; delete process.env.LITEAPI_KEY; });
  // 0.8 km is the "10 min walk" ring, which is the one a household without a
  // car reaches for first.
  await ratesNear({ lat: 51.48, lng: -0.61 }, 0.8, { checkin: '2026-10-23', checkout: '2026-10-24', occupancies: [{ adults: 2, children: [] }] });
  assert.equal(sent.radius, 1000);
  assert.equal(liteapiKeyKind(), 'production');
});
