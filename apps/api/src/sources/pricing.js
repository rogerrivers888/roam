// What each provider gives free, what it charges past that, and where the
// owner reads the true figures (Technical Constraints §11 "Free evaluation
// allowances", §12 "Cost model", §14 "cost per source").
//
// These are Roam's own counts and list prices — an estimate, never an invoice.
// Every line carries the provider console link because that is where the real
// bill lives; the point of showing the estimate is to know when to look.
//
// A "line" is what Settings › Usage shows per row. Most map one-to-one to a
// source; Google is three because Google bills three things separately
// (Places requests, photos, Routes elements) and Claude is two because the
// local scout has its own purse.

import { HOUSEHOLD_MONTHLY_CALL_BOUND } from '../claude.js';
import { SCOUT_MONTHLY_RUNS } from './localscout.js';

const ANTHROPIC_CONSOLE = { label: 'Anthropic console', url: 'https://console.anthropic.com/' };

export const LINES = [
  {
    key: 'claude', label: 'Claude planner', source: 'anthropic', unit: 'call', unitPlural: 'calls',
    what: 'Understands what you said and refines the plan. Billed by tokens at list rates.',
    // Not a free allowance: Roam's own ceiling, so one household cannot run up
    // an unbounded bill (§14). It counts every call that could cost something,
    // whoever it went to — and only those, because the open map and the
    // encyclopedias cannot bill and a guard they can fill is a guard against
    // using Roam (owner, 6 Sep 2026).
    cap: { kind: 'monthly', limit: HOUSEHOLD_MONTHLY_CALL_BOUND, label: 'household cap on calls that can cost money', env: 'ROAM_HOUSEHOLD_MONTHLY_CALL_BOUND', countsEveryBillableCall: true },
    hardStop: 'The workspace spend limit in the Anthropic console is the hard stop.',
    console: ANTHROPIC_CONSOLE,
  },
  {
    key: 'scout', label: 'Local scout', source: 'scout', unit: 'run', unitPlural: 'runs',
    what: "Claude reads council, local-paper and venue what's-on pages with web search. Tokens plus $10 per 1,000 searches.",
    cap: { kind: 'monthly', limit: SCOUT_MONTHLY_RUNS, label: 'scout cap on runs', env: 'ROAM_SCOUT_MONTHLY_RUNS' },
    hardStop: 'Pauses at the cap; the Anthropic workspace limit is the hard stop.',
    console: ANTHROPIC_CONSOLE,
  },
  {
    key: 'google', label: 'Google Places', source: 'google', unit: 'request', unitPlural: 'requests',
    what: 'A browse makes one Nearby Search request per kind (food, things to do); a dish or name search makes one Text Search; opening a place makes one Place Details request.',
    allowance: { kind: 'monthly', limit: 5000, beyondUsd: 0.032, basis: "Google's Pro-tier free threshold for Nearby and Text Search (5,000 a month each, not pooled)" },
    legacyUnitsPerCall: () => 2,
    console: { label: 'Google Cloud quotas', url: 'https://console.cloud.google.com/google/maps-apis/quotas?project=roam-507516' },
  },
  {
    key: 'google-photos', label: 'Google photos', source: 'google', unit: 'photo', unitPlural: 'photos',
    what: 'Each place photo shown is one Place Photo request, streamed through the API so the key stays server-side.',
    allowance: { kind: 'monthly', limit: 1000, beyondUsd: 0.007, basis: "Google's free threshold for Place Details Photos" },
    legacyUnitsPerCall: () => 1,
    console: { label: 'Google Cloud quotas', url: 'https://console.cloud.google.com/google/maps-apis/quotas?project=roam-507516' },
  },
  {
    key: 'google-routes', label: 'Google Routes', source: 'google', unit: 'element', unitPlural: 'elements',
    what: 'Real travel times. A plan asks for one origin against up to 200 places (one element each); a journey is one element.',
    allowance: { kind: 'monthly', limit: 5000, beyondUsd: 0.01, basis: "Google's free threshold for the traffic-aware (Advanced) Routes tier" },
    legacyUnitsPerCall: (purpose) => (purpose === 'plan.matrix' ? 100 : 1),
    console: { label: 'Google Cloud quotas', url: 'https://console.cloud.google.com/google/maps-apis/quotas?project=roam-507516' },
  },
  {
    key: 'tripadvisor', label: 'Tripadvisor', source: 'tripadvisor', unit: 'location', unitPlural: 'locations',
    what: 'Billed per location ID returned, not per search: a page of 10, each name lookup, and two for opening a place (details and reviews).',
    allowance: { kind: 'lifetime', limit: 1000, beyondUsd: 0.015, basis: 'Terra Discover: 1,000 free for the life of the account, then $0.015 a location' },
    legacyUnitsPerCall: () => 10,
    console: { label: 'Tripadvisor developer portal', url: 'https://www.tripadvisor.com/developers' },
  },
  {
    key: 'datathistle', label: 'Data Thistle', source: 'datathistle', unit: 'request', unitPlural: 'requests',
    what: 'UK listings down to the village fair. One events search is one request.',
    allowance: { kind: 'monthly', limit: 1000, beyondUsd: null, basis: 'free tier; paid plans above it are the owner\'s decision' },
    legacyUnitsPerCall: () => 1,
    console: { label: 'Data Thistle account', url: 'https://www.datathistle.com/' },
  },
  {
    key: 'ticketmaster', label: 'Ticketmaster', source: 'ticketmaster', unit: 'request', unitPlural: 'requests',
    what: 'Ticketed events. Free; rate-limited rather than billed.',
    allowance: { kind: 'daily', limit: 5000, beyondUsd: 0, basis: 'Discovery API default quota of 5,000 requests a day' },
    legacyUnitsPerCall: () => 1,
    console: { label: 'Ticketmaster developer account', url: 'https://developer-account.ticketmaster.com/' },
  },
  {
    key: 'seatgeek', label: 'SeatGeek', source: 'seatgeek', unit: 'request', unitPlural: 'requests',
    what: 'Ticketed events. Free.',
    legacyUnitsPerCall: () => 1,
    console: { label: 'SeatGeek platform', url: 'https://platform.seatgeek.com/' },
  },
  {
    key: 'predicthq', label: 'PredictHQ', source: 'predicthq', unit: 'request', unitPlural: 'requests',
    what: 'Events including community ones. Free plan after a 14-day trial; limits are set on the plan, not published here.',
    legacyUnitsPerCall: () => 1,
    console: { label: 'PredictHQ control center', url: 'https://control.predicthq.com/' },
  },
  {
    key: 'liteapi', label: 'LiteAPI hotel rates', source: 'liteapi', unit: 'request', unitPlural: 'requests',
    what: 'Hotels and live room prices for the Stay tab. One look is two requests: the beds on the map, then what they cost on your nights. Free to search — LiteAPI earns a commission on a booking, and Roam takes no booking.',
    hardStop: 'Nothing to stop: searching costs nothing. Booking through LiteAPI is not built, and needs a payment route and a cap from the owner before it could be.',
    console: { label: 'LiteAPI dashboard', url: 'https://dashboard.liteapi.travel/' },
  },
  {
    key: 'osm', label: 'OpenStreetMap', source: 'osm', unit: 'request', unitPlural: 'requests',
    what: 'Places and addresses from open data. Free; fair use of about one request a second.',
    legacyUnitsPerCall: () => 2,
  },
  {
    key: 'fixtures', label: 'Sample data', source: 'fixtures', unit: 'search', unitPlural: 'searches',
    what: 'Built-in sample places. Free.',
    legacyUnitsPerCall: () => 1,
  },
];

export const lineByKey = (key) => LINES.find((l) => l.key === key) ?? null;

/**
 * Which lines a provider_calls row written before the units column existed
 * belongs to, with an estimate of the units it consumed. Search rows name every
 * source that ran joined with '+'; Claude rows are told apart by purpose.
 */
export function legacyLines(provider, purpose) {
  if (provider === 'anthropic') return [{ key: purpose === 'scout.events' ? 'scout' : 'claude', units: 1 }];
  if (provider === 'google-places') return [{ key: 'google-photos', units: 1 }];
  if (provider === 'google-routes') return [{ key: 'google-routes', units: lineByKey('google-routes').legacyUnitsPerCall(purpose) }];
  if (provider === 'osm-nominatim') return [{ key: 'osm', units: 1 }];
  const out = [];
  for (const token of String(provider).split('+')) {
    // A joined search row that named Tripadvisor was always paired with its own
    // 'tripadvisor' row, which is the one counted; a joined row alone is skipped.
    if (token === 'tripadvisor' && provider !== 'tripadvisor') continue;
    const line = lineByKey(token);
    if (line?.legacyUnitsPerCall) out.push({ key: token, units: line.legacyUnitsPerCall(purpose) });
  }
  return out;
}

/**
 * What one search costs on each source, for the picker to say before the
 * search runs (the scout's figure is measured from this month's runs).
 */
export function perSearchCost({ scoutAvgUsd = null } = {}) {
  const scout = scoutAvgUsd ?? 0.65;
  return {
    fixtures: { perSearchUsd: 0, note: 'Sample data, free.' },
    osm: { perSearchUsd: 0, note: 'OpenStreetMap, free open data.' },
    google: { perSearchUsd: 0, note: 'Google gives 5,000 free searches a month per kind; beyond that about $0.03 a search. The quota is capped in Cloud Console.' },
    tripadvisor: { perSearchUsd: 0.15, note: 'Billed per location returned: 1,000 free for life (about 50 searches), then about $0.15 a search.' },
    ticketmaster: { perSearchUsd: 0, note: 'Free.' },
    seatgeek: { perSearchUsd: 0, note: 'Free.' },
    predicthq: { perSearchUsd: 0, note: 'Free plan.' },
    datathistle: { perSearchUsd: 0, note: '1,000 requests a month free; one search is one request.' },
    liteapi: { perSearchUsd: 0, note: 'Free: LiteAPI earns on a booking, not on a search.' },
    scout: { perSearchUsd: Number(scout.toFixed(2)), note: `Claude reads local what's-on pages: about $${scout.toFixed(2)} a search (${scoutAvgUsd != null ? 'measured this month' : 'estimate'}), capped at ${SCOUT_MONTHLY_RUNS} a month; the same place and day within 6 hours is free.` },
  };
}
