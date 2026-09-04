/**
 * What is inside a place: the forty rides in a theme park, the aviary and the
 * lions in a zoo.
 *
 * All of it owned, all of it from sources whose licences do not run out —
 * OpenStreetMap, Wikidata and Wikipedia — which is why it is stored in full
 * rather than fetched at display like a provider's record would be. The
 * attribution each row carries is part of the licence, not decoration.
 */

import { query } from '../db.js';

export async function contentsState(parentRef) {
  const { rows } = await query('select contents_state, contents_at from place_records where venue_ref = $1', [parentRef]);
  return rows[0] ?? null;
}

/** Say the research has started, so two requests do not both do it. */
export async function markResearching(parentRef, name, lat, lng) {
  await query(
    `insert into place_records (venue_ref, name, lat, lng, contents_state)
     values ($1,$2,$3,$4,'pending')
     on conflict (venue_ref) do update set contents_state = 'pending'`,
    [parentRef, name ?? null, lat, lng],
  );
}

export async function markResearchFailed(parentRef) {
  await query('update place_records set contents_state = $2 where venue_ref = $1', [parentRef, 'failed']);
}

export async function markResearchDone(parentRef, count) {
  await query(
    `update place_records set contents_state = 'done', contents_count = $2, contents_at = now(), updated_at = now() where venue_ref = $1`,
    [parentRef, count],
  );
}

export async function upsertContent(parentRef, c) {
  await query(
    `insert into place_contents (parent_ref, item_ref, name, kind, kind_label, lat, lng, facts, summary, summary_source, website, wikidata_id, wikipedia_url, attribution, provenance, position, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
     on conflict (parent_ref, item_ref) do update set
       name = excluded.name, kind = excluded.kind, kind_label = excluded.kind_label,
       lat = excluded.lat, lng = excluded.lng, facts = excluded.facts,
       summary = excluded.summary, summary_source = excluded.summary_source, website = excluded.website,
       wikidata_id = excluded.wikidata_id, wikipedia_url = excluded.wikipedia_url,
       attribution = excluded.attribution, provenance = excluded.provenance,
       position = excluded.position, updated_at = now()`,
    [parentRef, c.itemRef, c.name, c.kind, c.kindLabel, c.lat, c.lng,
      JSON.stringify(c.facts), c.summary ?? null, c.summarySource ?? null,
      c.website ?? null, c.wikidataId ?? null, c.wikipediaUrl ?? null,
      JSON.stringify(c.attribution), JSON.stringify(c.provenance), c.position],
  );
}

export async function contentsRows(parentRef) {
  const { rows } = await query(
    `select item_ref, name, kind, kind_label, lat, lng, facts, summary, summary_source, website, wikidata_id, wikipedia_url, attribution
       from place_contents where parent_ref = $1 order by position`,
    [parentRef],
  );
  return rows;
}

/**
 * What the park itself says about who may ride, written onto a ride already
 * held. Only the facts and the attribution move; the ride keeps its place.
 */
export async function updateFacts(parentRef, itemRef, facts, sources = []) {
  await query(
    `update place_contents
        set facts = $3::jsonb,
            attribution = case when $4::jsonb = '[]'::jsonb then attribution
                               else (select jsonb_agg(distinct a) from jsonb_array_elements(attribution || $4::jsonb) a) end,
            provenance = provenance || '{"restrictions":"venue"}'::jsonb,
            updated_at = now()
      where parent_ref = $1 and item_ref = $2`,
    [parentRef, itemRef, JSON.stringify(facts), JSON.stringify(sources.length ? [`${parentName(sources)}`] : [])],
  );
}

/** The line that credits the park's own pages. */
const parentName = (sources) => `Published by the venue: ${sources[0]}`;
