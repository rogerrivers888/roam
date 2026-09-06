// Why a source did not answer, in the household's words.
//
// The owner, 5 Sep 2026:
//
// > "I also see this on a lot of pages: Google Places 429 error code 429
// > message: 'Exceeded your metric.' I should never see that on the phone app.
// > I can see it on the desktop app, but not on the phone app."
//
// A provider's error text is written for whoever holds the account. It names
// the metric, the project number and the quota, and it belongs in the back
// office and in the logs, where somebody can act on it. What goes to a device
// is one plain sentence: who could not be asked, and what that means for what
// is on the screen.
//
// The raw text is never dropped — the caller logs it and `provider_calls` holds
// the attribution — it just does not travel.

const NAMES = {
  google: 'Google',
  'google-places': 'Google',
  tripadvisor: 'Tripadvisor',
  osm: 'The open map',
  'osm-overpass': 'The open map',
  'osm-nominatim': 'The open map',
  photon: 'The open map',
  wikipedia: 'Wikipedia',
  wikidata: 'Wikidata',
  ticketmaster: 'Ticketmaster',
  predicthq: 'PredictHQ',
  datathistle: 'Data Thistle',
  seatgeek: 'SeatGeek',
  liteapi: 'The hotel prices',
  scout: 'The local scout',
  fixtures: 'Sample data',
};

export const sourceName = (key) => NAMES[key] ?? String(key || 'That source').replace(/-/g, ' ');

/**
 * One sentence for a screen. `err` may be an Error or the text of one.
 *
 * "Over its allowance" is the one worth separating out, because it is the only
 * one where the answer is not "try again in a minute" — it is somebody's to
 * raise in a console, and until then the place reads from what Roam owns.
 */
export function whySourceFailed(key, err) {
  const who = sourceName(key);
  const text = String(err?.message ?? err ?? '');
  if (/quota|RESOURCE_EXHAUSTED|\b429\b|rate.?limit/i.test(text)) return `${who} has used up today's allowance — showing what Roam knows itself.`;
  if (/not set|no key|missing key|unauthor|401|403/i.test(text)) return `${who} is not switched on here.`;
  if (/timed? ?out|AbortError|TimeoutError|ETIMEDOUT/i.test(text)) return `${who} did not answer in time.`;
  return `${who} could not be reached just now.`;
}
