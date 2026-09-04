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

import { query } from '../db.js';
import { matchOsm } from './openMatch.js';
import { venueFromOsmElement, OSM_ATTRIBUTION } from './osm.js';
import { encyclopediaFor } from './encyclopedia.js';
import { siteFacts } from './site.js';
import { googleSource } from './google.js';
// Whether the owner has a key for it, and has not switched it off in Settings:
// asking a source the owner has turned off is not ours to do.
import { sourceHasKey, sourceOff } from './index.js';

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

const LICENCE = {
  osm: { licence: 'ODbL 1.0', retention: 'indefinite', attribution: OSM_ATTRIBUTION },
  site: { licence: "the venue's own published page", retention: 'indefinite', attribution: null },
  wikipedia: { licence: 'CC BY-SA 4.0', retention: 'indefinite', attribution: 'Wikipedia, CC BY-SA 4.0' },
  wikidata: { licence: 'CC0 1.0', retention: 'indefinite', attribution: 'Wikidata, CC0' },
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
  await query(
    `insert into place_facts (venue_ref, field, source, value, licence, retention, confidence, fetched_at, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7, now(), $8)
     on conflict (venue_ref, field, source) do update set
       value = excluded.value, licence = excluded.licence, retention = excluded.retention,
       confidence = excluded.confidence, fetched_at = now(), expires_at = excluded.expires_at`,
    [venueRef, field, source, JSON.stringify(value), terms.licence, terms.retention, confidence, expiryFor(terms.retention)],
  );
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
const forgetSource = (venueRef, sources) =>
  query('delete from place_facts where venue_ref = $1 and source = any($2)', [venueRef, sources]).catch(() => null);

// Which source wins each field, in order. A mapper who wrote the opening hours
// into OpenStreetMap and a restaurant who publishes them in their own markup
// will disagree; the business's own page is right about the business, and the
// map is right about where things are and what they are.
const PRECEDENCE = {
  name: ['osm', 'wikipedia'],
  category: ['osm'],
  lat: ['osm'], lng: ['osm'],
  address: ['site', 'osm'],
  postcode: ['site', 'osm'],
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
  const { rows } = await query('select field, source, value, confidence from place_facts where venue_ref = $1 and expires_at is null', [venueRef]);
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
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  await query(
    `update place_records set ${sets},
       attribution = $${cols.length + 2}, provenance = $${cols.length + 3}, updated_at = now()
     where venue_ref = $1`,
    [venueRef, ...values, JSON.stringify(attribution), JSON.stringify(provenance)],
  );
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
  const { rows } = await query(
    `select label, category, lat, lng, venue from household_places
      where venue_ref = $1 and lat is not null order by last_seen desc limit 1`,
    [venueRef],
  );
  const r = rows[0];
  const shortlist = r ? null : (await query(
    `select venue_label as label, category, lat, lng, venue from trip_shortlist where venue_ref = $1 and lat is not null order by added_at desc limit 1`,
    [venueRef],
  )).rows[0];
  const base = r ?? shortlist ?? {};
  const seed = {
    name: given.name ?? (base.label && base.label !== venueRef ? base.label : null),
    category: given.category ?? base.category ?? null,
    lat: given.lat ?? base.lat ?? null,
    lng: given.lng ?? base.lng ?? null,
    website: given.website ?? base.venue?.website ?? null,
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
        await query('insert into provider_calls (household_id, provider, purpose, units) values ($1,$2,$3,$4)', [householdId, 'google', 'own.seed', JSON.stringify(meter)]).catch(() => null);
        return { ...seed, name: seed.name ?? brief.name, lat: brief.lat, lng: brief.lng, website: seed.website ?? brief.website };
      }
    } catch (err) {
      console.warn(`own: could not ask what ${venueRef} is: ${err.message}`);
    }
  }
  return seed;
}

const logCall = (householdId, provider, purpose) =>
  query('insert into provider_calls (household_id, provider, purpose, units) values ($1,$2,$3,$4)', [householdId, provider, purpose, JSON.stringify({ [provider]: 1 })]).catch(() => null);

/**
 * Research one place and write what we may keep.
 *
 * Returns `{ state, fields, matched }`. Never throws — a place that cannot be
 * researched today is left for the next attempt with the reason on the row.
 */
export async function enrich(venueRef, { householdId = null, seed: given = {}, force = false } = {}) {
  await query('insert into place_records (venue_ref) values ($1) on conflict do nothing', [venueRef]);
  if (!force) {
    const { rows } = await query('select enrich_state, enriched_at from place_records where venue_ref = $1', [venueRef]);
    const row = rows[0];
    const fresh = row?.enriched_at && Date.now() - new Date(row.enriched_at).getTime() < REFRESH_AFTER_DAYS * 86_400_000;
    if (row?.enrich_state === 'done' && fresh) return { state: 'done', skipped: 'already researched' };
  }

  const seed = await seedFor(venueRef, given, { householdId });
  const matched = {};
  const problems = [];
  let found = 0;

  // 1. The same place in the open map. Everything else is easier once this
  //    lands, because OSM carries the website the other two need.
  let osm = null;
  try {
    // Attributed whether or not it answers: a refused request still went out,
    // and provider_calls is the record of what we asked of whom, not of what we
    // got back (Technical Constraints §2).
    try { osm = await matchOsm({ venueRef, name: seed.name, lat: seed.lat, lng: seed.lng }); }
    finally { await logCall(householdId, 'osm-overpass', 'own.match'); }
    // It answered, so whatever it said last time is superseded by what it says now.
    await forgetSource(venueRef, ['osm']);
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
      found += 1;
      if (!seed.website) seed.website = v?.website ?? null;
    } else {
      problems.push('no match in OpenStreetMap');
    }
  } catch (err) {
    problems.push(`OpenStreetMap: ${String(err?.message || err).slice(0, 120)}`);
  }

  // 2. Their own page: the facts a business publishes to be republished.
  if (seed.website) {
    try {
      const site = await siteFacts({ website: seed.website, name: seed.name, category: seed.category ?? null, locality: seed.locality ?? null, knownAddress: seed.address ?? null });
      await forgetSource(venueRef, ['site']);
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
        found += 1;
      } else {
        problems.push('their website did not answer');
      }
    } catch (err) {
      problems.push(`their website: ${String(err?.message || err).slice(0, 120)}`);
    }
  }

  // 3. The encyclopedias, for the places that have an article.
  try {
    let enc;
    try { enc = await encyclopediaFor({ name: seed.name, lat: osm?.lat ?? seed.lat, lng: osm?.lng ?? seed.lng }); }
    finally { await logCall(householdId, 'wikipedia', 'own.encyclopedia'); }
    // Wikidata is a second service and gets its own line, so the usage table
    // says who was actually asked.
    if (enc?.wikidataId) await logCall(householdId, 'wikidata', 'own.encyclopedia');
    await forgetSource(venueRef, ['wikipedia', 'wikidata']);
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
      found += 1;
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
  const refused = problems.some((p) => !/no match|did not answer/.test(p));
  const state = found ? 'done' : refused ? 'failed' : 'partial';

  const { rows } = await query(
    `update place_records set
       enrich_state = $2, enriched_at = now(), enrich_attempts = enrich_attempts + 1,
       enrich_error = $3, matched = $4, updated_at = now()
     where venue_ref = $1 returning enrich_attempts`,
    [venueRef, state, problems.length ? problems.join('; ') : null, JSON.stringify(matched)],
  );
  const attempts = rows[0]?.enrich_attempts ?? 1;
  const schedule = state === 'failed' ? BACKOFF_MIN : state === 'partial' ? EMPTY_BACKOFF_MIN : null;
  const giveUpAfter = state === 'failed' ? MAX_ATTEMPTS : EMPTY_BACKOFF_MIN.length + 1;
  await query(
    `update place_records set next_attempt_at = $2 where venue_ref = $1`,
    [venueRef, schedule && attempts < giveUpAfter
      ? new Date(Date.now() + schedule[Math.min(attempts - 1, schedule.length - 1)] * 60_000)
      : null],
  );
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
    await query('insert into place_claims (household_id, venue_ref, reason) values ($1,$2,$3) on conflict do nothing', [householdId, venueRef, reason]);
    await query('insert into place_records (venue_ref) values ($1) on conflict do nothing', [venueRef]);
  } catch (err) {
    console.warn(`own: could not claim ${venueRef}: ${err.message}`);
    return;
  }
  queueEnrichment(venueRef, { householdId, seed });
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
  const { rows } = await query('select * from place_records where venue_ref = $1', [venueRef]);
  return rows[0] ? publicRecord(rows[0]) : null;
}

/** Owned records for many places, keyed by venue ref. */
export async function ownedRecords(refs) {
  if (!refs?.length) return {};
  const { rows } = await query('select * from place_records where venue_ref = any($1)', [refs]);
  return Object.fromEntries(rows.map((r) => [r.venue_ref, publicRecord(r)]));
}

/**
 * Throw away every fact whose licence says its time is up, and rebuild the
 * records that lost one. Nothing in the table today expires — every source here
 * is indefinite — but the moment a 30-day source is enabled this is what keeps
 * the promise, and it must already work before that day (L7).
 */
export async function sweepExpired() {
  const { rows } = await query('delete from place_facts where expires_at is not null and expires_at <= now() returning venue_ref');
  const refs = [...new Set(rows.map((r) => r.venue_ref))];
  for (const ref of refs) await compose(ref).catch(() => null);
  return { discarded: rows.length, recomposed: refs.length };
}

/** Places claimed but never researched, or due to be tried again. */
export async function catchUp({ limit = 25 } = {}) {
  const { rows } = await query(
    `select venue_ref from place_records
      where enrich_state = 'pending'
         or (enrich_state in ('failed', 'partial') and next_attempt_at is not null and next_attempt_at <= now())
         -- Written off by an earlier build, which called a place done the first
         -- time it found nothing. Those never had a second chance and would
         -- have stayed empty for good.
         or (enrich_state = 'done' and provenance = '{}'::jsonb and enrich_attempts < $2)
      order by enrich_attempts, first_owned limit $1`,
    [limit, MAX_ATTEMPTS],
  );
  for (const r of rows) queueEnrichment(r.venue_ref);
  return rows.length;
}

/** How much of the household's research is owned, for Settings and the offline card. */
export async function ownedSummary(householdId) {
  const { rows } = await query(
    `select count(*)::int as claimed,
            count(*) filter (where r.enrich_state = 'done')::int as researched,
            count(*) filter (where r.osm_ref is not null)::int as in_open_map,
            count(*) filter (where r.summary is not null)::int as described,
            count(*) filter (where r.enrich_state in ('pending', 'partial'))::int as waiting,
            count(*) filter (where r.enrich_state = 'failed')::int as failed,
            max(r.updated_at) as last_change
       from (select distinct venue_ref from place_claims where household_id = $1) c
       join place_records r on r.venue_ref = c.venue_ref`,
    [householdId],
  );
  return rows[0] ?? { claimed: 0, researched: 0, in_open_map: 0, described: 0, waiting: 0, failed: 0, last_change: null };
}

/**
 * The background loop. Catches up on anything claimed but not yet researched,
 * and sweeps expired facts. Started by the server; slow on purpose, because
 * nothing here is urgent and Overpass is somebody else's machine.
 */
export function startOwnLoop({ everyMs = 5 * 60_000 } = {}) {
  const tick = async () => {
    try { await sweepExpired(); } catch (err) { console.warn(`own: sweep failed: ${err.message}`); }
    try { await catchUp(); } catch (err) { console.warn(`own: catch-up failed: ${err.message}`); }
  };
  // A first pass a minute after boot, so a deploy does not race the migration.
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, everyMs);
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
