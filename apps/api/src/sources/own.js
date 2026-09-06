// Owning a place (owner, 4 Sep 2026).
//
// "We don't need to store all this data for every single search of every single
// record that's returned. What would be good to store is the shortlisted
// venues, the activities, hotels, and restaurants that they've actually visited
// previously… once they add that action to store it, or say we visited it, we
// go off and get our own research… that way we then own it, and we're building
// up that store."
//
// So this module does not cache anybody's search results. It waits for a
// household to do something that means *this one matters* — shortlist it, save
// it, mark it special, or say they went — and only then goes and researches it
// from scratch, using sources whose licences let us keep the answer for good:
//
//   OpenStreetMap  the same place in the open map: name, category, cuisine,
//                  diets, hours, address, phone, website. ODbL, ours to keep,
//                  attribution required.
//   Their own site the schema.org block a business publishes for machines:
//                  phone, address, hours, price band, booking link, menu.
//   Wikipedia      a description for the places that have an article, CC BY-SA.
//   Wikidata       official website, the year it opened. CC0.
//
// None of it is Google's, none of it is Tripadvisor's, and none of it expires.
// The rented record is used only as a description of what to go and look for —
// a name and a point on the map — and is never written down here.
//
// Everything researched lands in two places: place_facts, which remembers the
// source, the licence and the moment a fact would have to be discarded, and
// place_records, which is composed from the facts that never have to be. Only
// place_records goes to the device.

import * as owned from '../repositories/ownedPlaces.js';
import * as providerCalls from '../repositories/providerCalls.js';
import { matchOsm } from './openMatch.js';
import { venueFromOsmElement, OSM_ATTRIBUTION } from './osm.js';
import { encyclopediaFor } from './encyclopedia.js';
import { siteFacts } from './site.js';
import { reverseGeocode } from './geocode.js';
import { googleSource } from './google.js';
// Whether the owner has a key for it, and has not switched it off in Settings:
// asking a source the owner has turned off is not ours to do.
import { sourceHasKey, sourceOff } from './index.js';
// The picture ladder: a mark, a Commons photograph or a street-level frame of
// the front door — never a photograph of somebody's food that we did not take.
import { sweepPictures } from './placePicture.js';
// The last resort when no open source and no licensed one can say where a
// claimed place's own page is (owner, 5 Sep 2026).
import { searchWeb } from '../claude.js';

// How long a failed attempt waits before it is tried again. Overpass rate-limits
// by IP and a restaurant's website goes down for an afternoon; neither is a
// reason to give up on a place the household has told us it cares about.
const BACKOFF_MIN = [5, 30, 180, 720, 2880];
const MAX_ATTEMPTS = 6;
// A place where nothing at all was found is a different case from one that
// errored, and it is usually not the truth. Overpass under load answers "no
// results" rather than refusing, so "no match in OpenStreetMap" can mean the
// map was not really asked. Somewhere with no OSM entry, no website and no
// article does exist, but it is rare — so an empty answer is tried again a few
// times, slowly, rather than being written off for ever.
const EMPTY_BACKOFF_MIN = [60, 360, 1440];
// One at a time. This is background work nobody is waiting on, and the whole
// cost of it is somebody else's patience: Overpass, Wikipedia and a restaurant's
// own server, none of whom are being paid.
const CONCURRENCY = 1;
// A record is re-researched twice a year, so a restaurant that changed its
// phone number is not wrong for ever.
const REFRESH_AFTER_DAYS = 180;
// How many places the picture ladder looks at per tick. Small: each one can be
// three requests to three different strangers' servers, and there is nobody
// waiting on the answer.
const PICTURE_BATCH = 6;

/**
 * What the research can do, as a number.
 *
 * Bumped whenever the researcher learns something the records already made
 * would have benefited from. The background pass picks up anything made by an
 * older version and does it again, so improving the research is all it takes to
 * improve every record — rather than the improvement only ever reaching places
 * claimed after it shipped.
 *
 *   1  the first version: the open map, the venue's own page, the encyclopedias
 *   2  asks the place ID what a place is when nothing of ours says; takes the
 *      street address from the point alone; reads a phone number printed
 *      without markup; lets what we already know decide if there is a menu
 *   3  replaces rather than erases: a source that comes back empty no longer
 *      throws away what it said last time
 */
const RESEARCH_VERSION = 3;

const LICENCE = {
  osm: { licence: 'ODbL 1.0', retention: 'indefinite', attribution: OSM_ATTRIBUTION },
  site: { licence: "the venue's own published page", retention: 'indefinite', attribution: null },
  wikipedia: { licence: 'CC BY-SA 4.0', retention: 'indefinite', attribution: 'Wikipedia, CC BY-SA 4.0' },
  wikidata: { licence: 'CC0 1.0', retention: 'indefinite', attribution: 'Wikidata, CC0' },
  // The street address a point sits at. Nominatim is OpenStreetMap, so this is
  // the same licence as the map itself, and it is the one fact we can establish
  // for a place whatever else fails: everything else needs the place to be
  // *findable*, and this only needs it to be somewhere.
  nominatim: { licence: 'ODbL 1.0', retention: 'indefinite', attribution: OSM_ATTRIBUTION },
};

/** When a fact under these terms must be gone. Null means never (§4). */
export function expiryFor(retention) {
  if (retention === 'indefinite') return null;
  const days = /^days:(\d+)$/.exec(retention || '');
  if (days) return new Date(Date.now() + Number(days[1]) * 86_400_000);
  return new Date(0); // 'none' — not storable at all; swept on the next pass
}

// ---------------------------------------------------------------------------
// facts
// ---------------------------------------------------------------------------

const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

/** One established fact, with the terms it came under. */
async function putFact(venueRef, field, source, value, confidence = null) {
  if (empty(value)) return;
  const terms = LICENCE[source] ?? { licence: 'unknown', retention: 'none' };
  await owned.putFact(venueRef, {
    field, source, value, licence: terms.licence, retention: terms.retention,
    confidence, expiresAt: expiryFor(terms.retention),
  });
}

/**
 * Forget what a source told us last time, before it is asked again.
 *
 * Only called once that source has actually answered. A match that turns out to
 * have been wrong — Wikipedia's article on the Bath constituency, attached to a
 * hotel with "Bath" in its name — has to be able to go away, and it cannot if a
 * re-check only ever writes over the fields it happens to find this time. A
 * source that could not be reached keeps what it said before, because silence
 * is not a correction.
 */
const forgetSource = (venueRef, sources) => owned.forgetSourceFacts(venueRef, sources).catch(() => null);

// Which source wins each field, in order. A mapper who wrote the opening hours
// into OpenStreetMap and a restaurant who publishes them in their own markup
// will disagree; the business's own page is right about the business, and the
// map is right about where things are and what they are.
const PRECEDENCE = {
  name: ['osm', 'wikipedia'],
  category: ['osm'],
  lat: ['osm'], lng: ['osm'],
  address: ['site', 'osm', 'nominatim'],
  postcode: ['site', 'osm', 'nominatim'],
  website: ['site', 'osm', 'wikidata'],
  phone: ['site', 'osm'],
  email: ['site', 'osm'],
  booking_url: ['site'],
  menu_url: ['site'], menu_label: ['site'],
  opening_hours: ['site', 'osm'],
  price_range: ['site'],
  cuisines: ['osm', 'site'],
  experiences: ['osm'],
  dietary_options: ['osm'],
  accessibility: ['osm'],
  socials: ['site'],
  good_for_children: ['osm'],
  summary: ['wikipedia', 'site'], summary_source: ['wikipedia', 'site'],
  image_url: ['wikipedia'],
  osm_ref: ['osm'],
  wikidata_id: ['wikipedia'],
  wikipedia_url: ['wikipedia'],
};
// These columns are `not null` with a default, because a record with no cuisines
// means "none known", not "unknown shape": callers iterate them without checking.
const JSON_DEFAULTS = { cuisines: [], experiences: [], dietary_options: [], accessibility: {}, socials: {} };
const JSON_FIELDS = new Set(Object.keys(JSON_DEFAULTS));

/**
 * Build the record from the facts that never expire, and write it.
 *
 * A fact with an expiry is deliberately skipped: place_records is the offline
 * record and the offline record must not hold anything that has to be thrown
 * away on a device we cannot reach.
 */
async function compose(venueRef) {
  const rows = await owned.liveFacts(venueRef);
  const bySource = new Map();
  for (const r of rows) bySource.set(`${r.field}|${r.source}`, r.value);

  const record = {};
  const provenance = {};
  for (const [field, order] of Object.entries(PRECEDENCE)) {
    for (const source of order) {
      const v = bySource.get(`${field}|${source}`);
      if (empty(v)) continue;
      record[field] = v;
      provenance[field] = source;
      break;
    }
  }

  const attribution = [...new Set(rows.map((r) => LICENCE[r.source]?.attribution).filter(Boolean))];
  if (record.wikipedia_url) attribution.push(record.wikipedia_url);

  const cols = Object.keys(PRECEDENCE);
  const values = cols.map((c) => {
    if (JSON_FIELDS.has(c)) return JSON.stringify(record[c] ?? JSON_DEFAULTS[c]);
    return record[c] === undefined ? null : record[c];
  });
  await owned.writeRecord(venueRef, cols, values, attribution, provenance);
  return { fields: Object.keys(provenance).length, provenance };
}

// ---------------------------------------------------------------------------
// research
// ---------------------------------------------------------------------------

/**
 * What to go looking for. The rented record is the description of the place we
 * want to find in the open world — a name and a point — and it is read here and
 * nowhere else. Nothing on this object is stored.
 */
async function seedFor(venueRef, given = {}, { householdId = null } = {}) {
  if (given.name && given.lat != null) return given;
  const r = await owned.seedFromHousehold(venueRef);
  // What we already worked out about this place last time. A category is what
  // decides whether we go looking for a menu, and the household's own row often
  // has none — so a restaurant we had already identified as a restaurant was
  // being researched again as if we knew nothing about it.
  const known = await owned.knownCategory(venueRef);
  const shortlist = r ? null : await owned.seedFromShortlist(venueRef);
  const base = r ?? shortlist ?? {};
  const seed = {
    name: given.name ?? (base.label && base.label !== venueRef ? base.label : null),
    category: given.category ?? base.category ?? known.category ?? null,
    lat: given.lat ?? base.lat ?? null,
    lng: given.lng ?? base.lng ?? null,
    website: given.website ?? base.venue?.website ?? known.website ?? null,
    // Which town this one is in, and the street we already worked out. Two
    // branches of one group share a website, so the town is the only thing that
    // tells their menus apart — and with it left out, Sebastian's in Windsor was
    // given Sebastian's in Richmond's menu (found 6 Sep 2026).
    locality: given.locality ?? base.locality ?? null,
    address: given.address ?? known.address ?? null,
  };
  if (seed.name && seed.lat != null) return seed;

  // Nothing of ours says which place this is. That happens when a place was
  // shortlisted on a trip that has since been deleted: the claim outlives the
  // row it was made from, and the research then had nothing to go looking with
  // — fifteen of one household's thirty-one places were written off this way
  // (found 4 Sep 2026).
  //
  // The place ID is still there, and the place ID is the one field the licence
  // lets us keep. Turning it back into a name and a point costs one request on
  // the narrowest field mask there is, and none of it is written down: it is
  // used to search the open map and the encyclopedias, and dropped.
  const [source, ...rest] = String(venueRef).split(':');
  if (source === 'google' && sourceHasKey('google') && !sourceOff('google')) {
    try {
      const meter = {};
      const brief = await googleSource.brief(rest.join(':'), { meter });
      if (brief?.lat != null) {
        await providerCalls.record(householdId, 'google', 'own.seed', JSON.stringify(meter)).catch(() => null);
        return { ...seed, name: seed.name ?? brief.name, lat: brief.lat, lng: brief.lng, website: seed.website ?? brief.website };
      }
    } catch (err) {
      console.warn(`own: could not ask what ${venueRef} is: ${err.message}`);
    }
  }
  return seed;
}

const logCall = (householdId, provider, purpose) =>
  providerCalls.record(householdId, provider, purpose, JSON.stringify({ [provider]: 1 })).catch(() => null);

/**
 * The last resort: go and find their page.
 *
 * A restaurant that OpenStreetMap has never heard of and whose licensed source
 * is over its allowance has, until now, been a street address and nothing else
 * — no hours, no phone, no menu, for ever. Sebastian's on Peascod Street is one
 * (owner, 5 Sep 2026: "the menu does not come up. It says 'No website for the
 * place'… anything that's in my places or my trips, we need to make sure we
 * have the proper detail, all of it, including the menus").
 *
 * The owner has already put this tool on the table for exactly this gap, 5 Sep
 * 2026: "Can we not use Claude to then get descriptions and information that we
 * can layer on and use, given that it's pretty low volume?" So this asks for
 * one thing only — the address of the venue's own website — and everything that
 * is then kept is read off that page by `siteFacts`, which is the same
 * published-for-republication material as every other place's.
 *
 * Three guards, because this is the one step here that costs money:
 *   - only for a place a household actually claimed, never for a swept one;
 *   - only when the open map and the source's own lead have both come back
 *     empty, which is a few places in a household rather than all of them;
 *   - only once — the answer is stored, so the next open is free.
 */
const FIND_PAGE_SYSTEM = `You are finding one thing: the address of a venue's own website.

You will be given a venue's name and where it is. Search for it and answer with the URL of the venue's own site — the site the business itself runs.

Rules:
- Answer with the URL alone, on one line, and nothing else.
- If it is a chain or a group, give the page for THIS branch if they have one, otherwise the group's site.
- Never answer with a directory, an aggregator or a review site: not TripAdvisor, Yelp, Google, Facebook, Instagram, OpenTable, Resy, Deliveroo, Just Eat, Uber Eats, Yell, or any "best restaurants in…" list.
- If you cannot find a site the business itself runs, answer with the single word NONE.
- If the venue appears to have closed, answer with the single word CLOSED.`;

const NOT_THEIR_SITE = /(tripadvisor|yelp|facebook|instagram|twitter|x\.com|google\.|opentable|resy|deliveroo|just-?eat|ubereats|yell\.com|foursquare|zomato|thefork|bookatable|linkedin|wikipedia|tiktok)/i;

async function findTheirPage({ venueRef, name, locality, address, category, householdId }) {
  if (!name) return null;
  if (!process.env.ANTHROPIC_API_KEY?.trim() && !process.env.ANTHROPIC_AUTH_TOKEN?.trim()) return null;
  // A swept place is not a claimed one. The area sweep queues hundreds of these
  // and none of them is anybody's yet.
  if (!(await owned.isClaimed(venueRef).catch(() => false))) return null;
  const meta = {};
  const { text } = await searchWeb({
    system: FIND_PAGE_SYSTEM,
    prompt: [name, category ? `a ${category}` : null, address, locality].filter(Boolean).join('\n'),
    householdId, sessionId: null, purpose: 'own.findPage',
    maxSearches: 3, maxFetches: 1, effort: 'low', meta,
  });
  const line = String(text || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const url = (line.match(/https?:\/\/[^\s"'<>)]+/) ?? [])[0] ?? null;
  // Asked and answered is a different thing from never asked: the caller writes
  // both down, and only the first one costs anything to find out twice.
  if (!url || NOT_THEIR_SITE.test(url)) return { url: null };
  try { new URL(url); } catch { return { url: null }; }
  return { url };
}

/**
 * Whether a record says which place this is, rather than only where it is.
 *
 * The name, the open-map reference and the website are the three fields that
 * mean somebody found *this place*; an address and a postcode come from a point
 * on the map and would be there for a field in the middle of nowhere.
 */
export function isIdentified(provenance) {
  return ['name', 'osm_ref', 'website'].some((f) => provenance?.[f]);
}

/**
 * The address of a place's own page, from the source that identified it.
 *
 * One request on the narrowest field mask there is — an id, a name, a point and
 * a website — which is the same call `seedFor` makes to turn a bare place ID
 * back into something searchable. Nothing it returns is stored: the website is
 * followed, their page is read, and what *they* publish is what lands in
 * `place_records` (Technical Constraints §13.10).
 *
 * Returns `{ website, name }`, or `{ problem }` when the source would not
 * answer, so that "we could not ask" is on the record as its own reason and is
 * tried again rather than being mistaken for "they have no website".
 */
async function websiteLead(venueRef, householdId) {
  const [source, ...rest] = String(venueRef).split(':');
  if (source !== 'google' || !sourceHasKey('google') || sourceOff('google')) return null;
  try {
    const meter = {};
    const brief = await googleSource.brief(rest.join(':'), { meter });
    await providerCalls.record(householdId, 'google', 'own.lead', JSON.stringify(meter)).catch(() => null);
    if (!brief?.website) return { website: null, name: brief?.name ?? null };
    return { website: brief.website, name: brief.name ?? null };
  } catch (err) {
    // Attributed whether or not it answered, the same as the open map above.
    await providerCalls.record(householdId, 'google', 'own.lead', JSON.stringify({ google: 1 })).catch(() => null);
    return { problem: `where their page is: ${String(err?.message || err).slice(0, 120)}` };
  }
}

/**
 * Research one place and write what we may keep.
 *
 * Returns `{ state, fields, matched }`. Never throws — a place that cannot be
 * researched today is left for the next attempt with the reason on the row.
 */
export async function enrich(venueRef, { householdId = null, seed: given = {}, force = false, replace = force } = {}) {
  await owned.ensureRecord(venueRef);
  const before = await owned.enrichStateOf(venueRef);
  if (!force) {
    const row = before;
    const fresh = row?.enriched_at && Date.now() - new Date(row.enriched_at).getTime() < REFRESH_AFTER_DAYS * 86_400_000
      // A record made by an older researcher is not fresh, however recent it is.
      && (row?.research_version ?? 0) >= RESEARCH_VERSION;
    // "Already researched" has to mean we found out which place this is. A
    // record that came back empty is not done with, and this guard was quietly
    // cancelling the catch-up that had just queued it: one said ask again, the
    // other said we asked recently, and the empty record stayed empty (found
    // 4 Sep 2026). A street address is not an identification either — that let
    // a reverse-geocode stand in for the research (owner, 5 Sep 2026).
    if (row?.enrich_state === 'done' && fresh && isIdentified(row?.provenance)) return { state: 'done', skipped: 'already researched' };
  }

  const seed = await seedFor(venueRef, given, { householdId });
  // Whether we can ask a well-formed question at all. Without a name and a
  // point there is nothing to search the open map or the encyclopedias for, and
  // "we could not ask" must never be mistaken for "they said no" — see
  // `forgetSource`.
  const canAsk = Boolean(seed.name && seed.lat != null);
  const matched = {};
  const problems = [];
  // Whether we ever worked out *which place this is* — which is not the same
  // question as whether anything came back. A reverse-geocode answers for any
  // point on earth, so a place nobody could identify still got a street
  // address, and that one field was enough to call the research done and stop
  // it being tried again: Kokoro sat empty for two days with a perfectly good
  // OpenStreetMap entry five metres away, because Overpass happened to be busy
  // on the afternoon it was claimed (owner, 5 Sep 2026).
  let identified = 0;
  // Going out to look for a venue's own page is the one step here that costs
  // money, so it is remembered: once a month at the very most, and never twice
  // because somebody opened the drawer twice.
  const askedBefore = before?.matched?.search ?? null;
  if (askedBefore) matched.search = askedBefore;
  const askAgain = !askedBefore?.at || Date.now() - new Date(askedBefore.at).getTime() > 30 * 86_400_000;

  // 1. The same place in the open map. Everything else is easier once this
  //    lands, because OSM carries the website the other two need.
  let osm = null;
  try {
    // Attributed whether or not it answers: a refused request still went out,
    // and provider_calls is the record of what we asked of whom, not of what we
    // got back (Technical Constraints §2).
    try { osm = await matchOsm({ venueRef, name: seed.name, lat: seed.lat, lng: seed.lng, locality: seed.locality ?? null, address: seed.address ?? null }); }
    finally { await logCall(householdId, 'osm-overpass', 'own.match'); }
    // Replace, do not erase.
    //
    // A source's facts are superseded when it comes back with something. They
    // are not thrown away because it came back with nothing: Overpass under
    // load answers "no results" rather than refusing, and a batch of thirty-two
    // re-reads took this household's matched places from ten to four before
    // anyone noticed (found 4 Sep 2026). An empty answer is not evidence of
    // absence.
    //
    // A match that was wrong still has to be removable, and that is what
    // `replace` is for — the drawer's "Look again", and the six-monthly
    // refresh. Asked deliberately, we clear first and take whatever comes back.
    //
    // Which is why it is not the same flag as `force`. Asking again sooner than
    // scheduled is one decision; throwing away what we know before we ask is
    // another, and doing both automatically means an hour when Overpass is
    // down erases every claimed place somebody happens to open. Kokoro lost the
    // open-map entry it had matched an hour earlier, that way (6 Sep 2026).
    if (osm || replace) await forgetSource(venueRef, ['osm']);
    if (osm) {
      const v = venueFromOsmElement({ type: osm.ref.split('/')[0], id: osm.ref.split('/')[1], lat: osm.lat, lon: osm.lng, tags: osm.tags });
      const t = osm.tags;
      matched.osm = { ref: osm.ref, distanceM: osm.distanceM, confidence: osm.confidence, how: osm.how };
      const put = (field, value) => putFact(venueRef, field, 'osm', value, osm.confidence);
      await Promise.all([
        put('osm_ref', osm.ref),
        put('name', v?.name ?? t.name),
        put('category', v?.category ?? null),
        put('lat', osm.lat), put('lng', osm.lng),
        put('address', v?.address ?? null),
        put('postcode', t['addr:postcode'] ?? null),
        put('website', v?.website ?? null),
        put('phone', t.phone ?? t['contact:phone'] ?? null),
        put('email', t.email ?? t['contact:email'] ?? null),
        put('opening_hours', v?.openingHours ?? null),
        put('cuisines', v?.cuisines ?? []),
        put('experiences', v?.experiences ?? []),
        put('dietary_options', v?.dietaryOptions ?? []),
        put('good_for_children', v?.goodForChildren),
        put('accessibility', {
          wheelchair: t.wheelchair ?? null,
          wheelchairToilet: t['toilets:wheelchair'] ?? null,
          stepFree: t['wheelchair:description'] ?? null,
        }),
      ]);
      identified += 1;
      if (!seed.website) seed.website = v?.website ?? null;
      // The map has just said what kind of place this is, and that is what
      // decides whether their page is worth reading for a menu.
      if (v?.category) seed.category = v.category;
    } else {
      problems.push('no match in OpenStreetMap');
    }
  } catch (err) {
    problems.push(`OpenStreetMap: ${String(err?.message || err).slice(0, 120)}`);
  }

  // 1a. Where their own page is, when the open map does not know this place.
  //
  //     Everything below this line needs a website, and until now the only
  //     source of one was OpenStreetMap. A restaurant the open map has never
  //     heard of — Sebastian's, 134 Peascod Street, which is a real restaurant
  //     with a real menu — therefore got an address and nothing else, for ever
  //     (owner, 5 Sep 2026: "the menu does not come up. It says 'No website for
  //     the place'").
  //
  //     The licence position is the one `seedFor` already takes and the one at
  //     the top of this file: the rented record is a description of what to go
  //     and find. So we ask for the narrowest thing there is — the address of
  //     their own page — read that page, and store what *they* publish. Nothing
  //     Google returns is written down, and the call is attributed like every
  //     other (Technical Constraints §13.10).
  if (!seed.website) {
    const lead = await websiteLead(venueRef, householdId);
    if (lead?.website) seed.website = lead.website;
    if (lead && !seed.name) seed.name = lead.name ?? seed.name;
    if (lead?.problem) problems.push(lead.problem);
  }
  // Still nothing, and somebody asked for this place by name: go and find it.
  if (!seed.website && !osm && askAgain) {
    try {
      const asked = await findTheirPage({
        venueRef, name: seed.name, category: seed.category,
        locality: seed.locality ?? null,
        address: seed.address ?? (await ownedRecord(venueRef).catch(() => null))?.address ?? null,
        householdId,
      });
      // Written down whichever way it went: "we looked and there is nothing" is
      // an answer, and it is the answer that stops us paying to look again.
      if (asked) {
        matched.search = { url: asked.url, at: new Date().toISOString() };
        if (asked.url) seed.website = asked.url;
        else problems.push('no website found for it anywhere');
      }
    } catch (err) {
      problems.push(`looking for their page: ${String(err?.message || err).slice(0, 120)}`);
    }
  } else if (!seed.website && !osm && askedBefore?.url) {
    seed.website = askedBefore.url;
  }

  // 2. Their own page: the facts a business publishes to be republished.
  if (seed.website) {
    try {
      const site = await siteFacts({ website: seed.website, name: seed.name, category: seed.category ?? null, locality: seed.locality ?? null, knownAddress: seed.address ?? null });
      // Replace, do not erase — a site that would not answer this afternoon has
      // not withdrawn what it said this morning.
      if (site || replace) await forgetSource(venueRef, ['site']);
      if (site) {
        matched.site = { url: site.sourceUrl ?? seed.website, how: site.how ?? null };
        const put = (field, value) => putFact(venueRef, field, 'site', value, 1);
        await Promise.all([
          put('phone', site.phone), put('email', site.email),
          put('address', site.address), put('postcode', site.postcode),
          put('opening_hours', site.openingHours),
          put('cuisines', site.cuisines ?? []),
          put('price_range', site.priceRange),
          put('booking_url', site.bookingUrl),
          put('socials', site.socials ?? {}),
          // The page we actually reached, not the address a provider gave us for it.
          put('website', site.sourceUrl),
          put('menu_url', site.menu?.url ?? null),
          put('menu_label', site.menu?.label ?? null),
          put('summary', site.summary),
          put('summary_source', site.summary ? (site.sourceUrl ?? seed.website) : null),
        ]);
        identified += 1;
      } else {
        problems.push('their website did not answer');
      }
    } catch (err) {
      problems.push(`their website: ${String(err?.message || err).slice(0, 120)}`);
    }
  }

  // 3. Where it is, from the point alone.
  //
  //    Everything above needs the place to be findable — matched in the map, or
  //    reachable at a website. This only needs it to be somewhere. So the one
  //    thing a household most wants standing outside with no signal, the street
  //    address, is the one we can get for nearly every place rather than the
  //    one in six we were managing (owner, 4 Sep 2026).
  const point = { lat: osm?.lat ?? seed.lat, lng: osm?.lng ?? seed.lng };
  if (point.lat != null && point.lng != null) {
    try {
      const geo = await reverseGeocode(point.lat, point.lng, { zoom: 18 });
      await logCall(householdId, 'osm-nominatim', 'own.where');
      if (geo) {
        matched.nominatim = { formatted: geo.formatted ?? null };
        await forgetSource(venueRef, ['nominatim']);
        await Promise.all([
          putFact(venueRef, 'address', 'nominatim', geo.formatted || null, 1),
          putFact(venueRef, 'postcode', 'nominatim', geo.address?.postcode ?? null, 1),
        ]);
      }
    } catch (err) {
      problems.push(`the address lookup: ${String(err?.message || err).slice(0, 120)}`);
    }
  }

  // 4. The encyclopedias, for the places that have an article.
  try {
    let enc;
    try { enc = await encyclopediaFor({ name: seed.name, lat: osm?.lat ?? seed.lat, lng: osm?.lng ?? seed.lng }); }
    finally { await logCall(householdId, 'wikipedia', 'own.encyclopedia'); }
    // Wikidata is a second service and gets its own line, so the usage table
    // says who was actually asked.
    if (enc?.wikidataId) await logCall(householdId, 'wikidata', 'own.encyclopedia');
    if (enc || replace) await forgetSource(venueRef, ['wikipedia', 'wikidata']);
    if (enc) {
      matched.wikipedia = { title: enc.title, url: enc.url, distanceM: enc.distanceM, confidence: enc.confidence };
      await Promise.all([
        putFact(venueRef, 'summary', 'wikipedia', enc.summary, enc.confidence),
        putFact(venueRef, 'summary_source', 'wikipedia', enc.attribution, enc.confidence),
        putFact(venueRef, 'wikipedia_url', 'wikipedia', enc.url, enc.confidence),
        putFact(venueRef, 'wikidata_id', 'wikipedia', enc.wikidataId, enc.confidence),
        putFact(venueRef, 'image_url', 'wikipedia', enc.imageUrl, enc.confidence),
        putFact(venueRef, 'name', 'wikipedia', enc.displayTitle ?? enc.title, enc.confidence),
        putFact(venueRef, 'website', 'wikidata', enc.officialWebsite, enc.confidence),
      ]);
      identified += 1;
    }
  } catch (err) {
    problems.push(`Wikipedia: ${String(err?.message || err).slice(0, 120)}`);
  }

  const { fields } = await compose(venueRef);
  // Three outcomes, not two. Something was found: done, and left alone until the
  // next refresh. A source refused: failed, and tried again soon. Every source
  // answered and none of them knew this place: partial — probably true, possibly
  // a bad afternoon on a free service, so tried again a few times over the next
  // day and then let be.
  const refused = problems.some((p) => !/no match|did not answer|no website found/.test(p));
  // "Done" has to mean we know which place this is. An address on its own is a
  // consolation prize, not an answer, so a record that got no further is left
  // as partial and comes back round rather than being written off on the
  // strength of a postcode.
  const state = identified ? 'done' : refused ? 'failed' : 'partial';

  const attempts = await owned.recordAttempt(venueRef, {
    state, error: problems.length ? problems.join('; ') : null, matched, researchVersion: RESEARCH_VERSION,
  });
  const schedule = state === 'failed' ? BACKOFF_MIN : state === 'partial' ? EMPTY_BACKOFF_MIN : null;
  const giveUpAfter = state === 'failed' ? MAX_ATTEMPTS : EMPTY_BACKOFF_MIN.length + 1;
  await owned.scheduleRetry(venueRef, schedule && attempts < giveUpAfter
    ? new Date(Date.now() + schedule[Math.min(attempts - 1, schedule.length - 1)] * 60_000)
    : null);
  return { state, fields, matched, problems };
}

// ---------------------------------------------------------------------------
// the queue
// ---------------------------------------------------------------------------

const waiting = [];
const queued = new Set();
let running = 0;

function pump() {
  while (running < CONCURRENCY && waiting.length) {
    const job = waiting.shift();
    queued.delete(job.venueRef);
    running += 1;
    enrich(job.venueRef, job)
      .catch((err) => console.warn(`own: ${job.venueRef} failed: ${err.message}`))
      .finally(() => { running -= 1; pump(); });
  }
}

/** Put a place in line to be researched. Returns immediately; nothing waits on this. */
export function queueEnrichment(venueRef, opts = {}) {
  if (!venueRef || queued.has(venueRef)) return;
  queued.add(venueRef);
  waiting.push({ venueRef, ...opts });
  pump();
}

// A place somebody has open in front of them is researched again there and
// then, whatever the background loop had scheduled — but not more often than
// this, or flicking in and out of a drawer would drive the queue.
const OPEN_AGAIN_MS = 10 * 60_000;
const openedAt = new Map();

/**
 * Somebody has just opened this place.
 *
 * The owner, 5 Sep 2026: "we should call the API as soon as a user opens a
 * record to make sure that we get the correct data in." A record that never got
 * as far as identifying the place is researched again now — the backoff a
 * failed afternoon left behind is for the background loop, not for somebody
 * standing in front of the drawer waiting to see a menu.
 *
 * Returns true when research has started, so the screen can come back for the
 * answer rather than showing the gap and staying there.
 */
export async function researchOnOpen(venueRef, { householdId = null, seed = {} } = {}) {
  if (!venueRef) return false;
  // Only for a place this household actually holds. Looking at something in a
  // search is not the act that makes it matter — shortlisting it, saving it or
  // going there is (Technical Constraints §13.10) — and researching everything
  // anybody glanced at would fill the owned layer with places nobody chose.
  if (!(await owned.isClaimed(venueRef).catch(() => false))) return false;
  const row = await owned.enrichStateOf(venueRef).catch(() => null);
  // Nothing to chase: we know which place this is.
  if (row && isIdentified(row.provenance)) return false;
  const last = openedAt.get(venueRef) ?? 0;
  if (Date.now() - last < OPEN_AGAIN_MS) return queued.has(venueRef) || running > 0;
  openedAt.set(venueRef, Date.now());
  await owned.ensureRecord(venueRef).catch(() => null);
  queueEnrichment(venueRef, { householdId, seed, force: true, replace: false });
  return true;
}

/**
 * A household has said this place matters. Records why, makes sure there is a
 * record for it, and starts the research.
 *
 * `reason` is one of saved | special | shortlisted | visited | planned — kept
 * because it is the evidence that we only own what somebody actually chose.
 */
export async function claimPlace(householdId, venueRef, reason, seed = {}) {
  if (!venueRef || !householdId) return;
  try {
    await owned.claim(householdId, venueRef, reason);
  } catch (err) {
    console.warn(`own: could not claim ${venueRef}: ${err.message}`);
    return;
  }
  queueEnrichment(venueRef, { householdId, seed });

  // And put the menu in line (owner, 5 Sep 2026: "a user can request the menu
  // if they add it to a trip, and then we can go get the menu as soon as it's
  // added"). Only the acts that mean somebody intends to eat there — being
  // somewhere once is not a reason to pay to read its menu — and only ever a
  // queue: nothing here waits, and the household's own tap on the Menu tab
  // still reads it there and then.
  if (['shortlisted', 'saved', 'special', 'planned'].includes(reason)) {
    import('./scoutArea.js')
      .then((m) => m.wantMenu(venueRef, householdId))
      .catch((err) => console.warn(`own: could not queue the menu for ${venueRef}: ${err.message}`));
  }
}

// ---------------------------------------------------------------------------
// reading, sweeping, catching up
// ---------------------------------------------------------------------------

const publicRecord = (r) => ({
  venueRef: r.venue_ref,
  name: r.name, category: r.category, lat: r.lat, lng: r.lng,
  address: r.address, postcode: r.postcode,
  website: r.website, phone: r.phone, email: r.email,
  bookingUrl: r.booking_url, menuUrl: r.menu_url, menuLabel: r.menu_label,
  openingHours: r.opening_hours, priceRange: r.price_range,
  cuisines: r.cuisines ?? [], experiences: r.experiences ?? [], dietaryOptions: r.dietary_options ?? [],
  accessibility: r.accessibility ?? {}, socials: r.socials ?? {}, goodForChildren: r.good_for_children,
  summary: r.summary, summarySource: r.summary_source, imageUrl: r.image_url,
  osmRef: r.osm_ref, wikidataId: r.wikidata_id, wikipediaUrl: r.wikipedia_url,
  attribution: r.attribution ?? [], matched: r.matched ?? {}, provenance: r.provenance ?? {},
  researchedAt: r.enriched_at, state: r.enrich_state, why: r.enrich_error,
  updatedAt: r.updated_at,
});

/** The owned record for one place, or null. */
export async function ownedRecord(venueRef) {
  const row = await owned.recordFor(venueRef);
  return row ? publicRecord(row) : null;
}

/** Owned records for many places, keyed by venue ref. */
export async function ownedRecords(refs) {
  if (!refs?.length) return {};
  const rows = await owned.recordsFor(refs);
  return Object.fromEntries(rows.map((r) => [r.venue_ref, publicRecord(r)]));
}

/**
 * Throw away every fact whose licence says its time is up, and rebuild the
 * records that lost one. Nothing in the table today expires — every source here
 * is indefinite — but the moment a 30-day source is enabled this is what keeps
 * the promise, and it must already work before that day (L7).
 */
export async function sweepExpired() {
  const discarded = await owned.discardExpiredFacts();
  const refs = [...new Set(discarded)];
  for (const ref of refs) await compose(ref).catch(() => null);
  return { discarded: discarded.length, recomposed: refs.length };
}

/** Places claimed but never researched, or due to be tried again. */
export async function catchUp({ limit = 8 } = {}) {
  const refs = await owned.dueForResearch(limit, MAX_ATTEMPTS, RESEARCH_VERSION);
  for (const ref of refs) queueEnrichment(ref);
  return refs.length;
}

/** How much of the household's research is owned, for Settings and the offline card. */
export async function ownedSummary(householdId) {
  return (await owned.summaryFor(householdId, RESEARCH_VERSION))
    ?? { claimed: 0, researched: 0, in_open_map: 0, described: 0, waiting: 0, failed: 0, last_change: null };
}

/**
 * The background loop. Catches up on anything claimed but not yet researched,
 * sweeps expired facts, and goes looking for a picture for the places that have
 * a record but no card image. Started by the server; slow on purpose, because
 * nothing here is urgent and Overpass is somebody else's machine.
 *
 * The picture pass runs last and in a small batch, because it is the least
 * urgent of the three and the most likely to be waiting on somebody's slow
 * server. A place that has just been researched has a website and a point on
 * the map for the first time, which is exactly what the ladder needs — so it is
 * worth running in the same tick rather than on a clock of its own.
 */
export function startOwnLoop({ everyMs = 5 * 60_000, pictures = PICTURE_BATCH } = {}) {
  const tick = async () => {
    try { await sweepExpired(); } catch (err) { console.warn(`own: sweep failed: ${err.message}`); }
    try { await catchUp(); } catch (err) { console.warn(`own: catch-up failed: ${err.message}`); }
    if (pictures > 0) {
      try { await sweepPictures({ limit: pictures }); } catch (err) { console.warn(`own: picture sweep failed: ${err.message}`); }
    }
  };
  // A first pass a minute after boot, so a deploy does not race the migration.
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, everyMs);
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
