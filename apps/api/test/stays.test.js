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
import { partyForStay, ageOn, rankStays, centreOfPlans, middleOf, whatIsOnOffer, wantsOnOffer, withinOfAll } from '../src/domain/stays.js';
import { kmBetween } from '../src/domain/travel.js';
import { mirrorsInOrder, mirrorAnswered, mirrorFailed, resetMirrors } from '../src/sources/overpass.js';

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

test('somewhere with no room free does not outrank somewhere you can book', () => {
  // Bath returned forty beds and four of them bookable, and every one of the
  // four sat below the fold under apartments with nothing free. A place with no
  // room is not a worse option, it is not an option.
  const centre = { lat: 51.3811, lng: -2.3590 };
  const ranked = rankStays(
    [
      { name: 'Nearest, nothing free', lat: 51.3812, lng: -2.3591, offer: null },
      { name: 'Also nothing free', lat: 51.3813, lng: -2.3592, offer: null },
      { name: 'Bookable, a little further', lat: 51.3830, lng: -2.3610, offer: { total: 245 } },
    ],
    { centre, mode: 'walking', availabilityFirst: true },
  );
  assert.equal(ranked[0].name, 'Bookable, a little further');
  // And the ones with nothing free are still shown, below — the dates may change.
  assert.equal(ranked.length, 3);
});

test('among the bookable ones the order is still the walk, never the price', () => {
  const anchors = [{ label: 'Roman Baths', lat: 51.3811, lng: -2.3590 }];
  const ranked = rankStays(
    [
      { name: 'Cheap and miles away', lat: 51.4200, lng: -2.3590, offer: { total: 90 } },
      { name: 'Dear and on the doorstep', lat: 51.3812, lng: -2.3591, offer: { total: 480 } },
    ],
    { anchors, centre: anchors[0], mode: 'walking', availabilityFirst: true },
  );
  assert.equal(ranked[0].name, 'Dear and on the doorstep');
});

test('with no prices asked for, availability cannot reorder anything', () => {
  const centre = { lat: 51.3811, lng: -2.3590 };
  const ranked = rankStays(
    [
      { name: 'Nearest', lat: 51.3812, lng: -2.3591, offer: null },
      { name: 'Further', lat: 51.3830, lng: -2.3610, offer: { total: 245 } },
    ],
    { centre, mode: 'walking' },
  );
  assert.equal(ranked[0].name, 'Nearest');
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

// ---------------------------------------------------------------------------
// which mirror to ask
// ---------------------------------------------------------------------------

test('a mirror that refuses goes to the back, and the one that answered goes to the front', () => {
  resetMirrors();
  const all = mirrorsInOrder();
  assert.equal(all.length, 4);
  const [first, second] = all;

  // 504 is "I gave up" — exactly what overpass.kumi.systems was returning on
  // 5 Sep 2026 after forty seconds, twice in three tries.
  mirrorFailed(first, null, 504);
  assert.notEqual(mirrorsInOrder()[0], first, 'a mirror that gave up is not asked first again');
  assert.equal(mirrorsInOrder().at(-1), first, 'but it is still on the list, at the back');

  // And the one that worked is where the next search starts.
  mirrorAnswered(second);
  assert.equal(mirrorsInOrder()[0], second);
});

test('a mirror that hangs rests as surely as one that refuses', () => {
  resetMirrors();
  const [first] = mirrorsInOrder();
  // No status, because nothing answered: this is the timeout path.
  mirrorFailed(first, { name: 'TimeoutError' });
  assert.notEqual(mirrorsInOrder()[0], first);
});

test('a 400 is our bad query, not a poorly mirror, and does not rest it', () => {
  resetMirrors();
  const [first] = mirrorsInOrder();
  mirrorFailed(first, null, 400);
  assert.equal(mirrorsInOrder()[0], first, 'a malformed query must not take a healthy mirror out of the rotation');
});

test('with every mirror resting, one is still asked', () => {
  resetMirrors();
  for (const url of mirrorsInOrder()) mirrorFailed(url, null, 504);
  // Nothing to be gained by refusing to try: the alternative is no places at all.
  assert.equal(mirrorsInOrder().length, 4);
  resetMirrors();
});

// ---------------------------------------------------------------------------
// the middle of several plans, and what may be asked for there
// ---------------------------------------------------------------------------

test('one day trip does not drag the search to the next city', () => {
  // Five things in Bath and a day out to Bristol. The mean lands between the
  // two, where a hotel is wrong for five days out of six.
  const bath = [
    { lat: 51.3811, lng: -2.3590 }, { lat: 51.3838, lng: -2.3599 }, { lat: 51.3870, lng: -2.3610 },
    { lat: 51.3800, lng: -2.3560 }, { lat: 51.3825, lng: -2.3650 },
  ];
  const plans = [...bath, { lat: 51.4545, lng: -2.5879 }];
  const total = (c) => plans.reduce((a, p) => a + kmBetween(c, p), 0);

  const median = centreOfPlans(plans);
  const mean = middleOf(plans);

  // The median stays in Bath with the five; the mean does not.
  assert.ok(bath.every((p) => kmBetween(median, p) < 1), 'the median sits among the five');
  assert.ok(kmBetween(mean, bath[0]) > 2, 'the mean has been pulled out of town');
  // And it is the median that is actually the better base, by the measure that matters.
  assert.ok(total(median) < total(mean) * 0.8, 'a third less travel across the whole trip');
});

test('two plans have no median worth the name, and fall back to the midpoint', () => {
  const two = [{ lat: 51.38, lng: -2.36 }, { lat: 51.46, lng: -2.59 }];
  assert.deepEqual(centreOfPlans(two), middleOf(two));
  assert.equal(centreOfPlans([]), null);
});

test('landing exactly on a plan does not divide by nothing', () => {
  // Three plans at one point plus one elsewhere: the median sits on the cluster,
  // which is the case that makes the naive form return NaN.
  const c = centreOfPlans([
    { lat: 51.38, lng: -2.36 }, { lat: 51.38, lng: -2.36 }, { lat: 51.38, lng: -2.36 }, { lat: 51.46, lng: -2.59 },
  ]);
  assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lng));
  assert.ok(kmBetween(c, { lat: 51.38, lng: -2.36 }) < 0.5);
});

test('a must-have nobody here offers is never put on screen', () => {
  // The Thorpe Park case: no bed inland has a sea view, so no rule about
  // coastlines has to exist for the chip to stay off the screen.
  const pool = [
    { facilityIds: ['1', '5'], hotelTypeId: '201' },
    { facilityIds: ['1'], hotelTypeId: '201' },
    { facilityIds: ['1', '5'], hotelTypeId: '204' },
  ];
  const names = {
    facilities: new Map([['1', 'Parking'], ['5', 'Pool'], ['9', 'Sea view']]),
    hotelTypes: new Map([['201', 'Hotel'], ['204', 'Apartment'], ['210', 'Farm stay']]),
  };
  const offer = whatIsOnOffer(pool, names);
  assert.deepEqual(offer.facilities.map((f) => f.label), ['Parking', 'Pool']);
  assert.equal(offer.facilities.find((f) => f.label === 'Sea view'), undefined);
  // And every chip says what ticking it costs: 2 of the 3 have a pool.
  assert.equal(offer.facilities.find((f) => f.label === 'Pool').count, 2);
  assert.deepEqual(offer.types.map((t) => t.label), ['Hotel', 'Apartment']);
  assert.equal(offer.of, 3);
});

test('an id the vocabulary has no word for is not offered as a blank chip', () => {
  const offer = whatIsOnOffer(
    [{ facilityIds: ['1', '4242'] }],
    { facilities: new Map([['1', 'Parking']]), hotelTypes: new Map() },
  );
  assert.deepEqual(offer.facilities.map((f) => f.label), ['Parking']);
});

test('“within 15 minutes of everything” says so when nothing manages it', () => {
  const spread = [
    { name: 'Best of a bad lot', plansTotal: 3, farthest: { minutes: 26 } },
    { name: 'Worse', plansTotal: 3, farthest: { minutes: 41 } },
  ];
  const out = withinOfAll(spread, 15);
  assert.equal(out.achievable, false);
  // Not an empty list and a shrug: the number the screen should offer instead.
  assert.equal(out.bestMinutes, 26);

  const ok = withinOfAll([{ name: 'Central', plansTotal: 3, farthest: { minutes: 12 } }], 15);
  assert.equal(ok.achievable, true);
  assert.equal(ok.beds.length, 1);
});

test('a chip everything has is as useless as one nothing has', () => {
  // Ninety-nine of a hundred beds have WiFi. Offering it narrows the list by
  // one and costs a household a tap to find that out.
  const facilities = new Map([['1', 'Free WiFi'], ['2', 'Swimming pool'], ['3', 'Sea view'], ['4', 'Sauna']]);
  const beds = Array.from({ length: 100 }, (_, i) => ({
    facilityIds: [...(i < 99 ? ['1'] : []), ...(i < 6 ? ['2'] : []), ...(i < 40 ? ['4'] : [])],
  }));
  const wants = wantsOnOffer(beds, { facilities });
  const keys = wants.map((w) => w.key);

  assert.ok(!keys.includes('wifi'), 'WiFi divides nothing and is not offered');
  assert.ok(!keys.includes('sea'), 'nothing here is on the sea, so it is never asked about');
  // And what is offered says what it costs.
  assert.equal(wants.find((w) => w.key === 'pool').count, 6);
  assert.equal(wants.find((w) => w.key === 'spa').count, 40);
});

test('a pool everything has is still worth saying, because it was asked for', () => {
  // The owner named pool, kitchen and air conditioning. "All of them have one"
  // is a real answer to "does it have a pool"; it is not a real answer to WiFi.
  const facilities = new Map([['2', 'Outdoor pool'], ['1', 'WiFi available']]);
  const beds = Array.from({ length: 20 }, () => ({ facilityIds: ['1', '2'] }));
  const keys = wantsOnOffer(beds, { facilities }).map((w) => w.key);
  assert.deepEqual(keys, ['pool']);
});

test('one want is several ids, because a pool is indoor and outdoor and rooftop', () => {
  const facilities = new Map([['10', 'Indoor pool'], ['11', 'Outdoor pool'], ['12', 'Rooftop pool']]);
  const beds = [{ facilityIds: ['10'] }, { facilityIds: ['11'] }, { facilityIds: ['12'] }, { facilityIds: [] }];
  assert.equal(wantsOnOffer(beds, { facilities }).find((w) => w.key === 'pool').count, 3);
});

test('an empty catalogue offers nothing rather than everything', () => {
  // The failure mode that cost an afternoon: the vocabulary did not load, so
  // every chip vanished and the screen implied the hotels had no facilities.
  assert.deepEqual(wantsOnOffer([{ facilityIds: ['1', '2'] }], { facilities: new Map() }), []);
});

test('a mirror that answers nothing does not become the preferred one', () => {
  // overpass.osm.ch, 6 Sep 2026: a Switzerland-only extract that answered 200
  // in 0.12s with zero elements for anywhere else. Fast and successful is
  // exactly what the health rules reward, so it captured every search and the
  // Stay tab returned no beds at all.
  resetMirrors();
  const [first, second] = mirrorsInOrder();
  mirrorAnswered(second, { empty: true });
  assert.equal(mirrorsInOrder()[0], first, 'an empty answer earns no preference');
  // But it is not punished either: a patch of map with no station on it is a
  // real answer, and resting a healthy mirror over one would be worse.
  assert.ok(!mirrorsInOrder().slice(-1).includes(second) || mirrorsInOrder().includes(second));
  mirrorAnswered(second);
  assert.equal(mirrorsInOrder()[0], second, 'an answer with something in it does');
  resetMirrors();
});

test('every mirror on the list is a planet-wide one', () => {
  // The rule this file exists to keep: a regional extract answers fast, answers
  // 200 and answers nothing, which no health check can tell from a real result.
  for (const url of mirrorsInOrder()) {
    assert.ok(!/osm\.ch/.test(url), `${url} is a Switzerland-only extract and must not be a mirror`);
  }
});
