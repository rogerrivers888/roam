// The web app talks to the Roam API over HTTP and nothing else. No provider
// key ever reaches this bundle (Technical Constraints §13.7).

import { forgetCopy, recall, remember, servingSaved, warm, warmQuietly } from './offline/cache';
import { flush as flushOutbox, queue as queueWrite, refreshOutbox } from './offline/outbox';
import { copyHolder, deviceLabel, holderOf, sessionExpired, sessionToken, setCopyHolder, setSessionToken } from './session';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

export class ApiError extends Error {
  status: number;
  code: string;
  body: any;
  constructor(status: number, body: any) {
    super(body?.message || body?.error || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error || 'http_error';
    this.body = body;
  }
}

/**
 * Thrown when there is no signal and nothing saved for this page. Told apart
 * from an ApiError so a screen can say "you are offline and we have not been
 * here before" rather than showing a network message nobody can act on.
 */
export class OfflineError extends Error {
  code = 'offline';
  constructor(public path: string) { super('No signal, and this page is not saved on your device yet.'); }
}

/**
 * Thrown when a write could not be sent but has been kept on the device and
 * will go on its own (offline/outbox.ts).
 *
 * It is an error because it is not done yet — a screen must not tell anybody
 * their booking is confirmed when it is sitting in a queue — but it is a
 * different one from a failure, so the message can say "saved, and it will send
 * itself" rather than "something went wrong".
 */
export class QueuedError extends Error {
  code = 'queued';
  queued = true;
  constructor(public path: string) { super("No signal — saved on this device and it will send itself when you're back."); }
}

/**
 * Every request goes through here, and so does the device's copy of it
 * (offline/cache.ts). A GET that succeeds is saved if its licence allows
 * (offline/policy.ts); a GET that cannot reach the API is answered from what
 * was saved, and the app is told it is showing an older copy.
 *
 * A write is never answered from the copy — the household has to know whether
 * their booking status actually reached the server — but a write that cannot be
 * sent is no longer thrown away either: if it is one that still means the same
 * thing later (offline/policy.ts `queueable`) it is kept and sent when there is
 * signal, and the caller is told which of the two happened.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const readOnly = method === 'GET';
  const token = sessionToken();
  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      // `include` so the sign-in response can set the cookie that photographs
      // are loaded with; every other request is authorised by the header.
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers || {}),
      },
    });
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Signed out, or the token has run out. Drop it so the app shows the
      // passcode screen; anything waiting in the outbox stays waiting.
      if (res.status === 401 && path !== '/api/session') sessionExpired();
      // The API answering "no" is an answer; only an API that cannot answer at
      // all falls back to the copy.
      if (readOnly && [502, 503, 504].includes(res.status)) {
        const saved = await recall<T>(path);
        if (saved) { servingSaved(true); return saved.body; }
      }
      throw new ApiError(res.status, body);
    }
    servingSaved(false);
    if (readOnly) void remember(path, body);
    return body as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (!readOnly) {
      // The API could not be reached at all. Keep the write rather than lose it.
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (await queueWrite(method, path, body)) throw new QueuedError(path);
      throw err;
    }
    const saved = await recall<T>(path);
    if (saved) { servingSaved(true); return saved.body; }
    throw new OfflineError(path);
  }
}

/**
 * Replay the outbox. Given to `flush` so a write made an hour ago goes out the
 * same door as a live one — same header, same handling of a 401.
 */
const sendQueued = (method: string, path: string, body: unknown) =>
  request(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const post = <T,>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });
const patch = <T,>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const put = <T,>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T,>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body: body ? JSON.stringify(body) : undefined });
const qs = (o: Record<string, any>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConstraintKind = 'allergen' | 'diet' | 'dislike' | 'like';
export type Constraint = { id: string; kind: ConstraintKind; value: string; conceptKey: string | null; conceptKind: string | null; maxMinutes?: number | null; favourite?: boolean };

export type Member = {
  id: string;
  name: string;
  isMinor: boolean;
  age: number | null;
  birthYear: number | null;
  birthDate: string | null;
  relationship: string | null;
  avatarUrl: string | null;
  typicalVisitMinutes: number | null;
  maxTravelMinutes: number | null;
  allergens: Constraint[];
  diets: Constraint[];
  dislikes: Constraint[];
  likes: Constraint[];
};

export type Place = {
  /** The source's own identifier for it, when the map had one: lets an idea open a drawer. */
  ref?: string; label: string; lat: number; lng: number; country?: string | null; countryCode?: string | null; locality?: string | null; displayName?: string; formatted?: string; address?: { line1: string | null; area: string | null; town: string | null; region: string | null; postcode: string | null; country: string | null }; matchedBy?: string; approximate?: boolean;
  /** Areas only: which one this is ("Somerset · England · United Kingdom") and what kind ("city"). */
  where?: string; kindWord?: string | null };

/** A bed from the open map, with how it sits against what the household means to do. */
/**
 * What a room costs on the nights of this trip: the cheapest thing the hotel
 * will sell, and the terms it comes on. LiteAPI's, fetched for this screen and
 * never written down — the number on screen has an expiry measured in minutes.
 */
export type StayOffer = {
  total: number; currency: string; perNight: number | null;
  roomName: string | null;
  /** "Room only", "Breakfast included" — the difference between two prices that look the same. */
  board: string | null;
  refundable: boolean | null;
  /** When free cancellation runs out, where the rate has any. */
  freeUntil: string | null;
  offerId: string | null;
};

export type Stay = Venue & {
  stayKind: string | null;
  stars: number | null;
  rooms: number | null;
  /** How far from the middle of the plans (or the city, before there are any). */
  distanceKm: number | null;
  /** How many shortlisted places are within a walk of the front door. */
  plansNear: number;
  plansTotal: number;
  /** The middle leg: what a typical day's journey from here looks like. */
  typicalMinutes: number | null;
  nearest: { label: string; minutes: number; km: number } | null;
  farthest: { label: string; minutes: number; km: number } | null;
  /** Null where the price source has no room here, or was not asked. */
  offer?: StayOffer | null;
  /** The price source's own id for this bed, where it is a different one from the row's. */
  bookRef?: string | null;
  reviewCount?: number | null;
};

/** What the Stay tab asked the price source for, and what came back. */
export type StayPricing = {
  on: boolean; priced: boolean;
  /** A sandbox key answers with invented hotels at invented prices. Always shown. */
  sandbox: boolean; environment: 'sandbox' | 'production' | 'unknown' | null;
  currency: string | null; nights: number;
  checkIn: string | null; checkOut: string | null;
  rooms: number; adults: number; childAges: number[];
  /** Whose age we had to take a view on, so the screen can offer to fix it. */
  assumedAges: string[];
  withPrice: number;
  reason: 'no_key' | 'switched_off' | 'no_dates' | null;
  degraded: { source: string; error: string }[];
};

export type Household = {
  id: string;
  name: string;
  defaultVisitMinutes: number;
  maxTravelMinutes: number;
  defaultIntensity: 'relaxed' | 'balanced' | 'packed';
  home: Place | null;
  /** How far "close to home" reaches, in miles (Settings › Home). */
  homeRadiusMiles?: number;
  pace: Pace;
  timezone?: string;
};

export type PaceKind = { typicalMinutes: number; maxMinutes: number; maxTravelMinutes: number; maxTravelIfSpecialMinutes: number };
export type Pace = { food: PaceKind; activity: PaceKind };

export type Learned = {
  memberId: string; name: string; conceptKey: string; label: string; conceptKind: string | null;
  kind: 'like' | 'dislike'; count: number; confirmed: boolean; threshold: number; net: number; lastOn: string;
};

export type HouseholdResponse = {
  household: Household;
  members: Member[];
  learned: Learned[];
  vocabulary: { allergens: string[]; relationships: string[] };
};

export type Suggestion = { key: string; label: string; kind: string; score: number };

export type Reason = { kind: string; member?: string; value?: string; text: string };

export type Budget = {
  totalMinutes: number; travelMinutes: number; dwellMinutes: number; allocatedMinutes: number; remainingMinutes: number;
  targetFill: number; targetMinutes: number; fillRatio: number;
  legs: { from: string; to: string; minutes: number }[];
  overrun: boolean; overrunStop: { id: string; name: string; position: number } | null;
  exceedsMaxTravel: boolean; maxTravelMinutes: number | null; estimated: boolean;
};

export type Review = { text: string; rating: number | null; author: string | null; authorUri?: string | null; when: string | null };

/** A licensed photo: a reference the API proxies, plus the author credit the licence requires on screen. */
export type VenuePhotoRef = { ref?: string; url?: string; attribution?: string };

export type Venue = {
  /** Set when this place sits inside another's grounds — a ride in a theme park. It belongs in that place's drawer, not beside it in a list. */
  insideRef?: string | null; insideName?: string | null;
  venueRef: string; source: string; sourcePlaceId: string; name: string; category: string; contributingSources?: string[];
  cuisines: string[]; experiences: string[]; allergens: string[]; dietaryOptions?: string[];
  priceLevel: number | null; rating: number | null; ratingCount?: number | null; goodForChildren: boolean | null; menuForChildren?: boolean | null; lat: number; lng: number;
  dishes: { concept: string; name: string; comment?: string; veg?: boolean }[];
  website?: string | null; phone?: string | null; openingHours?: string | null; address?: string | null; attribution?: string;
  /** Whether it is open at this moment, decided by the source in the place's own timezone; null when the source does not say. */
  openNow?: boolean | null;
  /** Today's hours where the place is — "12:00 – 11:00 PM", or "Closed". */
  hoursToday?: string | null; hoursDay?: string | null; closesAt?: string | null; opensAt?: string | null;
  summary?: string | null; mapsUrl?: string | null; externalUrl?: string | null; reviews?: Review[]; chain?: boolean; brand?: string | null;
  distanceKm?: number;
  photos?: VenuePhotoRef[];
  household?: { visits?: number; lastOn?: string; loved?: number; notForMe?: number; ledger?: string } | null;
};

/**
 * Where a place publishes its menu, found by following its website when the
 * drawer opens. `url` is null when there is nothing to follow, and `why` says
 * so in words worth showing.
 */
/**
 * What Roam owns about a place: the research done when the household
 * shortlisted, saved or visited it, from OpenStreetMap, the venue's own
 * published details and the open encyclopedias. None of it expires, so it is
 * the part that is on the device when there is no signal.
 *
 * `provenance` says which source each field came from, and `attribution` is the
 * credit those licences require on screen.
 */
export type OwnedRecord = {
  venueRef: string;
  name: string | null; category: string | null; lat: number | null; lng: number | null;
  address: string | null; postcode: string | null;
  website: string | null; phone: string | null; email: string | null;
  bookingUrl: string | null; menuUrl: string | null; menuLabel: string | null;
  openingHours: string | null; priceRange: string | null;
  cuisines: string[]; experiences: string[]; dietaryOptions: string[];
  accessibility: { wheelchair?: string | null; wheelchairToilet?: string | null; stepFree?: string | null };
  socials: Record<string, string>;
  goodForChildren: boolean | null;
  summary: string | null; summarySource: string | null; imageUrl: string | null;
  osmRef: string | null; wikidataId: string | null; wikipediaUrl: string | null;
  attribution: string[];
  matched: Record<string, any>;
  provenance: Record<string, string>;
  researchedAt: string | null;
  state: 'pending' | 'done' | 'partial' | 'failed';
  why: string | null;
  updatedAt: string | null;
};

export type MenuLink = { url: string | null; label: string | null; how: string | null; why?: string | null; checkedAt: string; cached?: boolean };


/** A menu read into dishes from the restaurant's own page (owner, 4 Sep 2026). */
export type MenuItem = {
  id: string; name: string; description: string | null; price: number | null; priceText: string | null;
  kcal: number | null; allergens: string | null; vegetarian: boolean | null;
};
export type MenuSection = { title: string; note: string | null; items: MenuItem[] };
export type ReadMenu = {
  id: string; venueRef: string; venueLabel: string | null; sourceUrl: string; sourceKind: 'html' | 'pdf' | 'json' | 'rendered' | 'claude' | 'photo';
  how: string[]; currency: string | null; note: string | null; fetchedAt: string;
  ageDays: number; stale: boolean; staleAfterDays: number; items: number; sections: MenuSection[];
};
/** Roam's own line about a dish, for a menu that gives only a name. */
export type DishNote = { name: string; known: boolean; what: string; origin: string | null };
export type MenuOpeners = { html: boolean; pdf: boolean; rendered: boolean; browser: string | null; claude: boolean; staleAfterDays: number };
export type OrderItem = {
  id: string; menuItemId: string | null; memberId: string | null; member: string | null;
  name: string; price: number | null; priceText: string | null; note: string | null;
  ratings: { memberId: string; score: number | null; take: Take; comment: string | null }[];
  concept: { key: string; label: string } | null;
  conceptSuggestion: { key: string; label: string; score: number } | null;
};
export type Order = {
  id: string; clientId: string | null; venueRef: string; venueLabel: string | null; menuId: string | null;
  visitId: string | null; createdAt: string; updatedAt: string; items: OrderItem[]; total: number;
};

export type Take = 'loved' | 'fine' | 'not_for_me';
export type VisitTake = { id?: string; memberId: string; member?: string; subject: string; take: Take; comment: string | null; conceptKey?: string | null; concept?: string | null; /** Out of 5, in halves (owner, 3 Sep 2026). */ score?: number | null };

/**
 * What the app sends when somebody rates something — which is not the same
 * shape as what comes back.
 *
 * A stored take always has a word. What is *sent* may have only stars, and the
 * API works the word out from them (routes/places.js): the rule lives there
 * rather than in two places that can drift apart.
 */
export type VisitTakeInput = { memberId: string; subject: string; take: Take | null; comment: string | null; conceptKey?: string | null; score?: number | null };
export type Visit = {
  id: string; venueRef: string; venueLabel: string; category: string | null; lat: number | null; lng: number | null;
  visitedOn: string; note: string | null; country: string | null; countryCode: string | null; locality: string | null;
  tripId: string | null; stopId?: string | null;
  attendees: { id: string; name: string }[] | string[];
  takes?: VisitTake[];
  visitTakes?: { member: string; memberId: string; take: Take; comment: string | null; score?: number | null }[];
  itemTakes?: number;
};

export type PricePoint = 'any' | 'affordable' | 'mid' | 'upmarket';

export type OptionStop = {
  id: string; position: number; venueRef: string; name: string; category: string; lat: number; lng: number;
  dwellMinutes: number; waitMinutes?: number; travelFromPrevMinutes: number; arriveAt?: string; leaveAt?: string;
  reasons: Reason[]; justification: string | null; startsAt: string | null; endsAt: string | null; pinned: boolean; fixed?: boolean; uniqueToThisOption?: boolean;
  // What kind of place, how rated and by whom, what it costs, how far — so a card can be judged.
  source?: string; cuisines?: string[]; experiences?: string[];
  rating?: number | null; ratingCount?: number | null; ratingSource?: string | null; priceLevel?: number | null;
  chain?: boolean; brand?: string | null; goodForChildren?: boolean | null; menuForChildren?: boolean | null;
  address?: string | null; website?: string | null; summary?: string | null; openingHours?: string | null;
  distanceKm?: number | null; travelFromBaseMinutes?: number | null; attribution?: string | null; reservable?: boolean | null; mapsUrl?: string | null;
  photos?: VenuePhotoRef[];
};

/** One thing inside a place with grounds — a ride, an animal house, a café. Ours: OSM, Wikidata, Wikipedia. */
export type PlaceInsideItem = {
  itemRef: string; name: string; kind: string; kindLabel: string; lat: number | null; lng: number | null;
  facts: {
    heightM?: number; lengthM?: number; speedKph?: number; opened?: string; builtBy?: string;
    coasterType?: string; operator?: string; note?: string; extraCharge?: boolean; capacity?: number;
    // Who may ride, from the park's own published restrictions.
    minHeightM?: number; maxHeightM?: number; minAge?: number; supervision?: string; thrill?: string;
    /** The day the park's own pages were read, so a ride with no restriction is not asked about again. */
    restrictionsChecked?: string;
  };
  summary: string | null; summarySource: string | null; website: string | null; wikipediaUrl: string | null; attribution: string[];
};

export type BrowseItem = Omit<OptionStop, 'position' | 'travelFromPrevMinutes' | 'pinned'> & {
  pinned: boolean; ticketed?: boolean; venueName?: string | null; externalUrl?: string | null;
  shortlisted?: boolean; score?: number | null; contributingSources?: string[];
  /**
   * A picture Roam owns, travelling as itself rather than folded into `photos`.
   * It has to stay separate because the two are not interchangeable: a rented
   * photo is fetched now and dropped, ours is stored; and a logo among them must
   * be drawn contained rather than stretched across a hero.
   */
  image?: OwnedImage | null;
};

/**
 * A place on the way, with what it costs to stop there. The corridor is a bias
 * and not a restriction — neither the source nor the estimate guarantees a
 * place sits on the road — so the detour is always shown (Requirements §4).
 */
export type RouteStop = BrowseItem & {
  leg: 'out' | 'back';
  meal: string | null;
  /** Why it is here at all: "Lunch on the way", "Worth stopping for on the way". */
  why: string;
  /** What marks it out; null when nothing does, and then it is offered, not proposed. */
  standout: string | null;
  /** Set on the ones not proposed: the reason they were not. */
  notProposed: string | null;
  detourMinutes: number;
  detourEstimated: boolean;
  dwellMinutes: number;
  alongFraction: number;
  intoJourneyMinutes: number;
  chosen: boolean;
  arriveAt: string | null;
  leaveAt: string | null;
};

export type PlanRoute = {
  from: string; to: string; mode: string; minutes: number; estimated: boolean; limitMinutes: number;
  /** The day is the same length whatever is stopped for; the time at the far end is what pays. */
  leaveHomeAt: string; arriveThereAt: string; leaveThereAt: string; backHomeAt: string;
  minutesThere: number; minutesThereWithout: number;
  addedOutMinutes: number; addedBackMinutes: number; addedMinutes: number;
  stops: RouteStop[];
};

export type TripOption = {
  id: string; title: string; basis: string; stops: OptionStop[]; budget: Budget;
  counts: { activities: number; food: number }; shortfall: { activities: number; food: number };
};

export type TripKind = 'outing' | 'trip';
export type DayStop = { id: string; position: number; venueRef: string; name: string; lat: number | null; lng: number | null; dwellMinutes: number; startTime: string | null; visit: Visit | null; bookingStatus?: ShortlistStatus | null; bookingRef?: string | null; legMode?: LegMode | null };
export type TripDay = { id: string; date: string; intensity: 'relaxed' | 'balanced' | 'packed'; travelMode: 'walking' | 'cycling' | 'driving' | 'transit'; startTime: string; endTime: string; notes: string | null; slots: { slot: 'morning' | 'afternoon' | 'evening'; stops: DayStop[] }[]; budget: Budget };
export type ShortlistStatus = 'to_call' | 'booked' | 'no_booking' | 'full' | 'set_aside';
export type LegMode = 'walking' | 'transit' | 'driving' | 'taxi';
export type ShortlistItem = {
  id: string; venueRef: string; name: string; kind: 'food' | 'activity' | 'other'; category: string | null; lat: number | null; lng: number | null; venue: Partial<Venue> | null; note: string | null; mustDo: boolean; preferredDayId: string | null; scheduled: boolean;
  // The working state: booking status, order, length, way of travelling to it (owner, 3 Sep 2026).
  status: ShortlistStatus; bookedTime: string | null; partySize: string | null; bookingRef: string | null; statusNote: string | null; statusOn: string | null; position: number | null; dwellMinutes: number | null; legMode: LegMode | null; dayId: string | null;
};
export type JourneyLeg = { from: { label: string; lat: number; lng: number }; mode: LegMode; minutes: number; estimated: boolean; leaveBy: string; options: Partial<Record<LegMode, { minutes: number; estimated: boolean }>> };
export type JourneyStop = {
  id: string; venueRef: string; name: string; category: string | null; kind: string | null; lat: number | null; lng: number | null; venue: Partial<Venue> | null;
  status: ShortlistStatus; bookedTime: string | null; partySize: string | null; bookingRef: string | null; note: string | null; mustDo: boolean; position: number; dwellMinutes: number; dwellDefault: boolean;
  fixed: boolean; fixedAt: string | null; arriveAt: string; leaveAt: string; spareBefore: number | null; lateBy: number | null; mustLeaveBy: string; windowMinutes: number;
  legIn: JourneyLeg; legModeChosen: LegMode | null;
};
export type JourneyBlocker = { kind: 'to_call' | 'clash' | 'late' | 'over'; text: string; ids: string[] };
export type Endpoint = { label: string; lat: number; lng: number; kind: 'home' | 'base' | 'custom' };
export type Journey = {
  source: 'shortlist' | 'day'; dayId: string; date: string; hasCar: boolean; timezone: string; startAt: string; endAt: string; home: { label: string; lat: number; lng: number }; homeAt: string;
  start: Endpoint; end: Endpoint; choices: { home: Endpoint | null; base: Endpoint | null };
  stops: JourneyStop[]; legHome: JourneyLeg | null; fits: boolean; spareMinutes: number; overBy: number; tipping: { id: string; name: string } | null;
  blockers: JourneyBlocker[]; canSave: boolean; estimated: boolean; routing: string; lookups: number;
  others?: { id: string; name: string; category: string | null; status: ShortlistStatus; statusNote: string | null; statusOn: string | null }[];
};
export type DirectionStep = { text: string; minutes: number; meters: number | null; travelMode: string; transit: { line: string | null; agency: string | null; vehicle: string | null; color: string | null; textColor: string | null; headsign: string | null; stopCount: number | null; from: string | null; to: string | null; departs: string | null; arrives: string | null } | null };
export type Directions = { mode: LegMode; minutes: number; meters: number | null; encodedPolyline: string | null; steps: DirectionStep[]; estimated: boolean; source: string };
/** A trip in the two words a row has room for: which one, and when. */
export type TripBrief = { id: string; label: string | null; startsOn: string | null; endsOn: string | null; on: string | null };
export type AtlasCity = {
  name: string; places: number; been: number; special: number; trips: number; lastSeen: string | null;
  lat: number | null; lng: number | null; created: boolean;
  /** The three lists an area is divided into. Hotels decides whether that tab is drawn at all. */
  activities: number; food: number; hotels: number;
  /**
   * Whether this area gets a Hotels tab: somewhere to stay is kept here, or the
   * household has slept a night here (routes/atlas.js). A day-trip area — Bath,
   * Reading & around — shows Activities and Food & drink only.
   */
  holiday: boolean;
  image: OwnedImage | null; lastTrip: TripBrief | null; nextTrip: TripBrief | null;
};
/** Everything within the household's radius of the front door: a standing view, not a city. */
export type AtlasHome = { label: string | null; lat: number; lng: number; radiusMiles: number; places: number; been: number; special: number; image: OwnedImage | null; countryCode: string | null };
export type AtlasCountry = {
  code: string; name: string; places: number; been: number; cities: AtlasCity[];
  areas: number; trips: number; lastTrip: TripBrief | null; nextTrip: TripBrief | null;
};
/** The map a search is drawn on while it runs (SearchSketch). Open data, in Mercator units. */
export type SketchArea = { ref: string; name: string; d: string; cx: number; cy: number };
export type SketchMap = {
  centre: { lat: number; lng: number }; radiusKm: number;
  place: string | null; areas: SketchArea[]; complete: boolean;
  country: { code: string; name: string; d: string; box: [number, number, number, number] } | null;
  attribution: string;
};

/**
 * What a search says while it runs. Each one is something that happened: a
 * source asked, a source answering with a count, a source giving up. Nothing
 * here is a timer, which is the only reason the screen may show it.
 */
export type SketchEvent =
  | { type: 'asking'; sources: { key: string; label: string }[] }
  | { type: 'answered'; source: string; label: string; count: number; points: [number, number][] }
  | { type: 'failed'; source: string; label: string; error: string }
  | { type: 'cached'; count: number }
  /** This search is riding on one already running, and is waiting for its answer. */
  | { type: 'joining' }
  | { type: 'waiting'; at: number };

export type SearchParams = { q?: string; categories?: string; radiusKm?: number; near?: string; sources?: string; refresh?: '1' };
export type SearchAnswer = { near: Place; radiusKm: number; results: (Venue & { onShortlist: boolean; stored?: boolean })[]; degradedSources: { source: string; error: string; slow?: boolean }[]; sourcesQueried?: string[];
  /** How many of the results are the household's own records, served because they cannot go down. */ storedCount?: number;
  cached?: boolean; fetchedAt?: string; tookMs?: number };

export type AtlasPlace = { venueRef: string; name: string; unnamed?: boolean; kind: 'food' | 'activity' | 'other' | null; category: string | null; lat: number | null; lng: number | null; country: string | null; countryCode: string | null; locality: string | null; venue: Partial<Venue> | null; note: string | null; visits: number; lastOn: string | null; takes: { member: string; take: Take; comment: string | null; on: string }[]; ledger: string | null; onTrips: { id: string; title: string | null; on: string | null }[]; status: 'been' | 'saved' | 'special'; special: boolean; loved: number; notForMe: number;
  /** Each person's latest score out of 5 here. */ scores: { memberId: string; member: string; score: number; on: string }[];
  /** Where it is at a glance: postcode district and the nearest station with its lines; null until looked up. */ postcode: string | null; station: string | null; stationLines: string[]; stationKind: string | null; stationDistanceM: number | null; whereChecked: string | null;
  /** The picture Roam owns for this place, if the ladder found one. */ image?: OwnedImage | null;
  /** Rented: the provider's photographs, sent only where we own none, fetched at display and never stored. */ photos?: VenuePhotoRef[] | null;
  /** What a day here is like, over the closed set of six (domain/moods.js) — the Mood filter's vocabulary. */ moods?: MoodKey[] };

export type Trip = {
  kind?: TripKind; place?: { label: string } | null; startDate?: string | null; endDate?: string | null; dayStart?: string; dayEnd?: string;
  base?: (Place & { kind?: string | null; checkIn?: string | null; checkOut?: string | null }) | null; hasCar?: boolean;
  /** Place sources this trip's searches and plans may use; null = default set. */
  sources?: string[] | null;
  id: string; title: string | null; notes?: string | null;
  origin: Place; destination: Place | null;
  departAt: string; returnAt: string;
  travelMode: 'walking' | 'cycling' | 'driving' | 'transit'; intensity: 'relaxed' | 'balanced' | 'packed';
  country?: string | null; countryCode?: string | null; locality?: string | null;
};

export type TripSummary = Trip & {
  dayCount: number; stopCount: number; shortlistCount: number; visitCount: number; ratingCount: number;
  placeCount: number; unratedCount: number;
  attendees: { id: string; name: string }[]; isPast: boolean;
  /** Nights away. Zero is a day out, whatever the trip calls itself — the line Day trips | Holidays is drawn on. */
  nights: number;
  /** Dates, and nowhere to sleep. The one thing on the Trips list allowed to be red. */
  needsStay: boolean;
  image: OwnedImage | null;
};

/**
 * One place a trip touched, however it got there: booked onto a day, kept on
 * the shortlist, visited, or slept in (handover, 5 Sep 2026).
 */
export type TripPlace = {
  venueRef: string; name: string | null; category: string | null;
  /** Which of the three lists it belongs in: something to do, somewhere to eat, somewhere to stay. */
  group: 'do' | 'eat' | 'stay';
  lat: number | null; lng: number | null; firstOn: string | null; lastOn: string | null;
  /** The day it happened, in the words a row shows: "Sun 10". */ day: string | null;
  dwellMinutes: number | null; visited: boolean; scheduled: boolean; shortlisted: boolean;
  bookingStatus: string | null;
  scores: { memberId: string; member: string; score: number }[];
  /** The household's own mark out of five, or null where nobody has said — which is what the Rate nudge is for. */
  score: number | null;
  image: OwnedImage | null;
};

export type TripStop = { id: string; position: number; venueRef: string; name: string; lat: number | null; lng: number | null; dwellMinutes: number; visit: Visit | null };

export type TripDetail = { trip: Trip; attendees: { id: string; name: string; isMinor: boolean; avatarUrl?: string | null }[]; days: TripDay[]; shortlist: ShortlistItem[]; stops: TripStop[]; budget: Budget };

// --- group trips -----------------------------------------------------------
// A group hangs off a trip: one organiser, a checklist of the things the trip
// already contains, and the people who have to do them. The organiser's screen
// leads with what is outstanding; Roam does the chasing on a schedule.

export type GroupItemKind = 'stay' | 'activity' | 'fee';
export type GroupStatus = 'booked' | 'declared' | 'paid' | 'in' | 'out';
export type GroupItemState = { status: GroupStatus; bookingRef: string | null; whereBooked: string | null; startsOn: string | null; endsOn: string | null; amountPence: number | null; note: string | null; markedBy: 'participant' | 'organiser' | 'roam'; on: string };
export type GroupPricing = 'fixed' | 'variable' | null;
export type GroupItemState2 = 'open' | 'closed' | 'cancelled';
/**
 * The money on an item, worked out by the API and never by a screen: the share
 * now, the ceiling (what it costs at the minimum — the promise), and what it
 * will probably come out at. Nothing is owed until `billed`.
 */
export type GroupMoney = {
  shares: number; expected: number | null; minimum: number | null; closesOn: string | null;
  perSharePence: number | null; ceilingPence: number | null; likelyPence: number | null;
  billed: boolean; paidPence: number | null; duePence: number | null; collectedPence: number | null;
};
export type GroupItem = {
  id: string; kind: GroupItemKind; required: boolean; label: string; detail: string | null; venueRef: string | null; stopId: string | null;
  amountPence: number | null; refundRule: string | null; refundUntil: string | null; position: number;
  applies: 'everyone' | 'extra'; pricing: GroupPricing; totalPence: number | null; perHead: boolean;
  expectedCount: number | null; minimumCount: number | null; capacity: number | null;
  closesOn: string | null; lateJoiners: 'capacity' | 'no' | 'ask'; state: GroupItemState2;
  settledPence: number | null; settledHeads: number | null; settledAt: string | null; dueOn: string | null; cancelledNote: string | null;
  done: number; declared: number; confirmed: number; coming: number; notComing: number; heads: number;
  outstanding: number; outstandingNames: string[]; money: GroupMoney | null; paidPence: number | null; duePence: number | null;
};
export type GroupParticipant = {
  id: string; name: string; contact: string | null; contactKind: 'mobile' | 'email' | null; heads: number; brings: string | null;
  memberId: string | null; note: string | null; invitedAt: string | null; joinedAt: string | null; withdrawnAt: string | null; withdrawnNote: string | null;
  states: Record<string, GroupItemState>; outstanding: { id: string; label: string; kind: GroupItemKind }[];
  reminders: { on: string; kind: string; status: string; body: string }[]; lastRemindedAt: string | null;
};
export type GroupReminders = {
  on: boolean; cadence: string; cadences: { key: string; label: string; runs: number }[]; channelReady: boolean;
  schedule: { date: string; daysBefore: number; at: string; done: boolean }[];
  next: { date: string; daysBefore: number; at: string; recipients: number } | null;
  written: number; undelivered: number;
  recent: { id: string; on: string; runOn: string | null; kind: string; status: string; reason: string | null; who: string | null; body: string }[];
};
export type GroupItemInput = {
  kind: GroupItemKind; label: string; detail?: string; required?: boolean; venueRef?: string | null;
  amountPence?: number | null; refundRule?: string | null; refundUntil?: string | null;
  pricing?: GroupPricing; totalPence?: number | null; perHead?: boolean;
  expectedCount?: number | null; minimumCount?: number | null; capacity?: number | null;
  closesOn?: string | null; lateJoiners?: 'capacity' | 'no' | 'ask';
};
export type TripGroup = {
  group: { id: string; tripId: string; name: string | null; expectedCount: number | null; minimumCount: number | null; maximumCount: number | null; wantedBy: string | null; inviteToken: string; closed: boolean; remindersOn: boolean; cadence: string; setupDone: boolean; firstReminderOn: string | null; cancelledAt: string | null; cancelledNote: string | null };
  trip: { id: string; title: string | null; place: string | null; startDate: string | null; endDate: string | null; base: { label: string; kind: string | null } | null };
  items: GroupItem[]; participants: GroupParticipant[];
  summary: { expected: number | null; joined: number; notJoined: number; withdrawn: number; heads: number; complete: number; missing: number };
  reminders: GroupReminders;
  warnings: { kind: string; participantId: string; name: string; itemId: string; item: string; said: string; wanted: string }[];
  wrote?: { participant: string; status: string }[];
};
/** What the invite link opens: the checklist, and nothing about anybody else. */
export type JoinView = {
  group: { name: string | null; wantedBy: string | null; closed: boolean; cancelled: boolean; cancelledNote: string | null; organiser: string | null; expectedCount: number | null; minimumCount: number | null; maximumCount: number | null; joined: number; heads: number };
  trip: { title: string | null; place: string | null; startDate: string | null; endDate: string | null; base: { label: string } | null };
  items: (Omit<GroupItem, 'done' | 'declared' | 'confirmed' | 'coming' | 'notComing' | 'heads' | 'outstanding' | 'outstandingNames' | 'paidPence' | 'duePence' | 'money'> & {
    mine: GroupItemState | null;
    money: (Pick<GroupMoney, 'shares' | 'perSharePence' | 'ceilingPence' | 'likelyPence' | 'minimum' | 'expected' | 'closesOn' | 'billed'> & {
      heads: number; yoursPence: number | null; ceilingYoursPence: number | null; likelyYoursPence: number | null; dueOn: string | null;
    }) | null;
  })[];
  expecting: { id: string; name: string }[];
  you: { id: string; name: string; heads: number; brings: string | null; joinedAt: string | null; outstanding: number } | null;
  participantToken?: string;
};

export type SuggestedPreference = { member: string | null; kind: 'like' | 'dislike'; value: string };

export type Spend = { session_calls: number; session_cost_usd: number; month_calls: number; month_cost_usd: number; sessionBound: number; householdMonthlyBound: number; trip_calls?: number; trip_cost_usd?: number };

export type PlanResponse = {
  sessionId: string; dayId?: string | null; date?: string | null; reply: string | null;
  journey?: { from: string; to: string; minutes: number; mode: string } | null;
  /** The journey itself as something to plan: what is worth stopping for on the way there and back. */
  route?: PlanRoute | null;
  anchor?: { name: string; start_time: string | null; duration_minutes: number | null; kind: string; place: Place } | null; intent?: Record<string, any>; missing?: string[]; trip?: Trip;
  options: TripOption[];
  selection?: { pinned: string[]; excluded: string[]; chosenOptionId: string | null };
  constraints?: { minActivities: number; minFood: number; includeChains?: boolean; pricePoint?: PricePoint };
  pool?: { size: number; targetFill: number; excludedByAllergen: { name: string; reasons: string[] }[]; hiddenChains?: number };
  suggestedPreferences?: SuggestedPreference[]; spend?: Spend;
  attending?: { id: string; name: string }[]; reach?: { maxTravelMinutes: number; estimated: boolean };
  applied?: any; ambiguous?: string | null; transcript?: { role: 'user' | 'assistant'; text: string }[];
  browse?: BrowseItem[]; eventsSource?: string | null; resumed?: boolean;
  // A question the planner is asking instead of guessing; each choice is tapped or said in the same words.
  question?: PlanQuestion | null;
  // The rows are the screen: everything said so far in its slot; the checks are what the planner is not sure of.
  rows?: PlanRow[] | null;
  checks?: PlanCheck[];
  answered?: { id: string; text: string; answer: string }[];
  ready?: boolean;
  // Plan it runs in the background: poll the session until this clears.
  running?: boolean; failed?: boolean;
  // An overnight stay was set up as a dated trip: open it in Trips.
  handoff?: { tripId: string; title: string; section?: 'find' | 'shortlist' | 'day' } | null;
};

export type PlanQuestion = { kind: 'place' | 'stay' | 'attending' | 'open' | 'duration'; field?: string | null; text: string; choices: { label: string; say: string }[] };
export type PlanCheck = PlanQuestion & { id: string; skippable: boolean };
export type PlanRowKey = 'from' | 'to' | 'when' | 'who' | 'stay' | 'do' | 'eat' | 'budget';
export type PlanRow = { key: PlanRowKey; label: string; value: string | null; detail: string | null; state: 'plain' | 'check' | 'empty' };
// A tapped control lands in the plan exactly as tapped — no interpretation.
export type PlanSet = {
  origin?: Place | null; destination?: Place | null; date?: string | null; end_date?: string | null; nights?: number | null; duration_minutes?: number | null; depart_time?: string | null;
  do?: { kinds: string[]; named: string[]; count: number | null };
  eat?: { meals: Record<string, string | null>; avoid_chains?: boolean | null; special?: boolean | null };
  budget?: { price_point?: 'any' | PricePoint | null; low?: number | null; high?: number | null; per?: 'everyone' | 'person' | null };
};
export type IdeaBudget = 'any' | 'free' | 'cheap' | 'mid' | 'treat';
// The family's table (owner, 4 Sep 2026): one food several of them love, and
// the best places for it within the travel cap.
export type TasteWho = { memberId: string; name: string; favourite: boolean; said?: string };
export type TasteFit = { tone: 'good' | 'warn' | 'fact' | 'allergen'; kind: string; member: string | null; text: string };
export type MenuRead = {
  checked: boolean; menuUrl: string | null; menuDated: string | null;
  dish: { label: string; verdict: 'yes' | 'no' | 'unknown'; named: string | null; price: string | null; note: string | null } | null;
  people: { person: string; need: string; verdict: 'yes' | 'no' | 'unknown'; examples: string[]; note: string | null }[];
  allergens: { person: string; allergen: string; verdict: 'yes' | 'no' | 'unknown'; note: string | null }[];
  kidsMenu: boolean | null; summary: string | null; whyNot: string | null; readAt: string; attribution: string; cached?: boolean;
};
export type TastePlace = {
  venueRef: string; source: string; name: string; category: string; cuisines: string[]; address: string | null;
  rating: number | null; ratingCount: number | null; priceLevel: number | null;
  travelMinutes: number; travelEstimated: boolean; distanceKm: number; lat: number; lng: number;
  website: string | null; mapsUrl: string | null; photos: { ref: string; attribution: string }[]; chain: boolean;
  evidence: { where: 'review' | 'summary' | 'name' | 'cuisine'; text: string | null; matched: string } | null;
  fits: TasteFit[]; attribution: string | null; menu: MenuRead | null;
};
export type Taste = { key: string; label: string; title: string; loved: TasteWho[]; notFor: { memberId: string; name: string; value: string }[]; named: boolean };
export type TasteTable = Taste & { because?: string; searched?: string; radiusKm?: number; travelNote?: string | null; nearest?: { name: string; travelMinutes: number; estimated: boolean } | null; places: TastePlace[]; excluded?: { name: string; reasons: string[] }[]; found?: number; error?: string };
export type TastesResponse = { sessionId: string; running: boolean; tastes: Taste[]; tables: TasteTable[]; note: string | null; error: string | null; capMinutes?: number | null; capFromWords?: boolean };
export type AroundThing = IdeaThing & { why: { memberId: string; name: string; favourite: boolean; label: string; text: string }[] };

/** How far along a run of Inspire me is, for the line that says what is happening. */
export type InspireStage = 'thinking' | 'thinking-again' | 'placing' | 'ready' | 'error';
export type Idea = { id: string; title: string; why: string; placeText: string; place: Place | null; travelMinutes: number | null; distanceKm?: number | null; overnight: boolean; do: string[]; eat: string[]; placing?: boolean };
export type IdeaThing = { venueRef: string; name: string; category: string; kind: 'do' | 'eat' | 'see'; experiences: string[]; rating: number | null; ratingCount: number | null; priceLevel: number | null; photos?: VenuePhotoRef[]; distanceKm: number | null; lat: number | null; lng: number | null; reasons: string[] };
/** The place an idea is about, as its source holds it: the picture, the stars, how far. */
export type IdeaHeadline = { venueRef: string; name: string; category: string; experiences?: string[]; rating: number | null; ratingCount: number | null; priceLevel: number | null; photos: VenuePhotoRef[]; distanceKm: number | null; summary: string | null; attribution: string | null };

// ---------------------------------------------------------------------------
// Inspire — the home screen
// ---------------------------------------------------------------------------

/** What a day is about. The closed set the home screen draws as chips. */
export type MoodKey = 'fun' | 'food' | 'culture' | 'sport' | 'activity' | 'adrenaline' | 'relaxing' | 'outdoors';
export type Mood = { key: MoodKey; label: string; count: number };

/**
 * One place on the home screen, from the single pool the API retrieved. Every
 * shelf, every filter and every count on that screen is composed from these —
 * changing a chip never asks a provider anything (Requirements: one pool).
 */
/**
 * A photograph Roam owns outright — harvested from Wikimedia Commons under a
 * licence that lets us keep and republish it. `lqip` is a 20px JPEG as a data
 * URI, about 500 bytes, so a card paints before the network is touched.
 *
 * `credit` is not decoration. For everything except CC0 and public domain,
 * showing the picture without the line is the licence broken, so a card that
 * draws the image must draw the credit too.
 */
export type OwnedImage = {
  id: string;
  /**
   * Which rung of the ladder found it (sources/placePicture.js), because a card
   * must not draw all of them the same way. A photograph fills its tile; a
   * `logo` is a business's mark and is contained on the mint ground with room
   * around it, or it comes out cropped into an abstract smear.
   */
  source: 'wikimedia' | 'logo' | 'kartaview' | 'mapillary' | 'household' | 'upload' | string;
  lqip: string | null; credit: string | null;
  licence: string; licenceUrl: string | null; sourceUrl: string | null;
  creditRequired: boolean;
};

export type InspireItem = {
  venueRef: string; source: string; name: string; category: string;
  moods: MoodKey[]; experiences: string[]; cuisines: string[];
  rating: number | null; ratingCount: number | null; priceLevel: number | null;
  goodForChildren: boolean | null;
  photos: VenuePhotoRef[];
  /** The credit the picture and the rating travel with; shown wherever they are. */
  attribution: string[];
  lat: number; lng: number;
  /** From the middle of the search. */
  distanceKm: number;
  /** The journey the family would actually make, from home or from where they are. */
  travelMinutes: number; estimated: boolean;
  /** How long this household would spend there, at their own pace. */
  dwellMinutes: number;
  household: { visits?: number; lastOn?: string; loved?: number; notForMe?: number; ledger?: string } | null;
  /** Set on an atlas place: ours, illustrated, and researched from open sources. */
  image?: OwnedImage | null;
  /**
   * The atlas's own word for the kind of place — heritage, outdoors, museum,
   * arts, animals, family, active, landmark. Deliberately its own field rather
   * than folded into `experiences`, which is a closed vocabulary that voice is
   * interpreted against and must stay closed.
   */
  atlasCategory?: string | null;
  summary?: string | null;
  heritage?: string | null;
  website?: string | null;
  wikipediaUrl?: string | null;
  region?: string | null;
};

export type InspireNear = {
  place: { label: string | null; lat: number; lng: number; locality: string | null };
  from: { label: string | null; lat: number; lng: number; how: 'home' | 'given' | 'centre' };
  mode: string; radiusKm: number;
  moods: Mood[]; items: InspireItem[];
  /**
   * Which pools are in this answer. The home screen reads the atlas alone —
   * ours, illustrated, and answered in milliseconds — and `live` is only true
   * when somebody deliberately asked to look around beyond it.
   */
  pools?: { atlas: boolean; live: boolean };
  cached: boolean; tookMs: number; attribution: string[];
};

export type PlanAction =
  | { type: 'like' | 'unlike' | 'dislike' | 'restore'; stopId: string }
  /** A stop on the way in or out of the journey; the day at the destination is untouched. */
  | { type: 'route_add' | 'route_drop'; stopId: string }
  | { type: 'choose'; optionId: string | null }
  | { type: 'set'; minActivities?: number; minFood?: number; intensity?: Trip['intensity']; durationMinutes?: number; travelMode?: Trip['travelMode']; includeChains?: boolean; pricePoint?: PricePoint; attendingMemberIds?: string[] };

export type SourceCost = { perSearchUsd: number; note: string };
export type SourcesStatus = { cost?: Record<string, SourceCost>; enabled: { key: string; label: string; attribution: string | null; optIn?: boolean }[]; routing: string; defaults?: string[]; available: { key: string; label: string; env: string; on: boolean; hasKey?: boolean; off?: boolean; optIn?: boolean }[]; usage?: { tripadvisor?: { searchesAllTime: number; searchesThisMonth: number; locationsAllTime?: number; locationsFree?: number } } };

// Admin: what each source returned for a day of a trip and where the plan lost it.
export type SourceStage = 'catchment' | 'reach' | 'allergen' | 'window' | 'shown';
export type SourceTraceVenue = {
  key: string; venueRef: string; name: string; category: string; source: string; contributingSources: string[]; ratingSource: string | null;
  rating: number | null; ratingCount: number | null; priceLevel: number | null; goodForChildren: boolean | null;
  startsAt: string | null; endsAt: string | null; venueName: string | null; experiences: string[]; cuisines: string[];
  distanceKm: number; travelMinutes: number | null; travelEstimated: boolean; stage: SourceStage; reason: string | null;
  score: number | null; reasons: { kind: string; text: string }[]; chain: boolean; conflicts: { field: string; held: any; heldSource?: string; offered: any; offeredSource?: string }[];
  externalUrl: string | null; address: string | null; justification: string | null; attribution: string | null; photoCount: number; raw: Record<string, any>;
};
export type SourceTrace = {
  trip: { id: string; title: string | null; dayId: string; date: string; base: { label: string; lat: number; lng: number }; window: { from: string; to: string }; mode: string; timezone: string };
  days: { id: string; date: string }[];
  sourcesQueried: string[]; requested: string[]; includeScout: boolean; degraded: { source: string; error: string }[]; radiusKm: number; maxTravelMinutes: number;
  stages: { key: string; label: string; bySource: Record<string, number>; total: number }[];
  venues: SourceTraceVenue[];
  spend?: { units: Record<string, number>; listPriceUsd: number; byProvider: { key: string; units: number; usd: number }[]; actualUsd: number };
};

// Settings › Providers charts: spend by month, per provider line and in total.
export type SpendPoint = { month: string; calls: number; units: number; costUsd: number; paidUsd: number; estimated: boolean };
export type SpendSeries = { months: string[]; lines: Record<string, SpendPoint[]>; total: { month: string; calls: number; costUsd: number; paidUsd: number }[] };

// Settings › Usage: what the household's calls have used and cost, by provider.
export type SpendPeriod = 'month' | 'last-month' | 'all' | 'custom';
export type SpendAllowance = {
  kind: 'monthly' | 'lifetime' | 'daily'; limit: number; used: number; estimated: boolean; resetsAt: string | null;
  beyondUsd?: number | null; basis?: string; label?: string; env?: string;
};
export type SpendLine = {
  key: string; label: string; source: string; on: boolean; unit: string; unitPlural: string; what: string; hardStop: string | null;
  console: { label: string; url: string } | null;
  calls: number; units: number; costUsd: number; paidUsd: number; estimated: boolean;
  allowance: SpendAllowance | null; cap: SpendAllowance | null;
  periods?: Record<'month' | 'last-month' | 'all', { calls: number; units: number; costUsd: number; estimated: boolean }>;
  perSearchUsd?: number | null;
};
export type SpendResponse = {
  period: { key: SpendPeriod; from: string; to: string; label: string };
  totals: { calls: number; costUsd: number; paidUsd: number };
  totalsByPeriod?: Record<'month' | 'last-month' | 'all', { calls: number; costUsd: number }>;
  lines: SpendLine[];
  recent: { id: string; at: string; provider: string; purpose: string | null; cost_usd: number; units: Record<string, number> | null; lines?: string[] }[];
  generatedAt: string;
};

/** A mock-up is 'new' until the owner rules on it. */
export type PrototypeStatus = 'new' | 'approved' | 'rejected' | 'archived';

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * The device's saved copy belongs to one household.
 *
 * Called before the token is set, on every way in. If the person signing in is
 * not who the copy was saved for, it goes — otherwise a friend signing in on a
 * browser somebody else used would be served that household's atlas straight
 * out of IndexedDB, without a request the API could refuse.
 */
async function claimDeviceCopy(account: AccountSummary | null | undefined): Promise<void> {
  const holder = holderOf(account);
  const before = copyHolder();
  if (before && before !== holder) await forgetCopy();
  setCopyHolder(holder);
}

/**
 * What the running API can actually see, and where from — Settings › Providers
 * shows it when a key that is "in Doppler" is not in the process.
 *
 * Names and shapes only. No value, or part of one, crosses this boundary; a
 * `kind` is a published vendor prefix (`sand_`, `prod_`, `sk-ant-`) and nothing
 * that anybody chose.
 */
export type KeyReport = {
  service: { railwayService: string | null; railwayEnvironment: string | null; railwayProject: string | null; commit: string | null; startedAt: string };
  /** Blank on every line means the Doppler sync is not reaching this service at all. */
  doppler: { project: string | null; config: string | null; environment: string | null };
  expected: {
    name: string; set: boolean; length?: number; kind?: string | null;
    /** The three ways a value can be present and still be wrong. */
    quoted?: boolean; padded?: boolean; unresolvedReference?: boolean;
  }[];
  /** Other names on the process that look like credentials — a near miss shows up here. */
  otherSecretNames: string[];
  note: string;
};

export const api = {
  health: () => request<{ ok: boolean; db: string }>('/health'),
  sources: () => request<SourcesStatus>('/api/sources'),
  setSourceOn: (key: string, on: boolean) => patch<{ key: string; on: boolean; off: string[] }>(`/api/sources/${key}`, { on }),

  // household
  household: () => request<HouseholdResponse>('/api/household'),
  updateHousehold: (body: Partial<Pick<Household, 'name' | 'defaultVisitMinutes' | 'maxTravelMinutes' | 'defaultIntensity'>> & { home?: Place; homeText?: string; homeRadiusMiles?: number; pace?: { food?: Partial<PaceKind>; activity?: Partial<PaceKind> }; timezone?: string }) =>
    patch<{ household: Household }>('/api/household', body),
  addMember: (body: { name: string; relationship?: string | null; birthYear?: number | null; birthDate?: string | null; avatarUrl?: string | null }) => post<{ member: any }>('/api/household/members', body),
  updateMember: (id: string, body: { name?: string; relationship?: string | null; birthYear?: number | null; birthDate?: string | null; avatarUrl?: string | null; typicalVisitMinutes?: number; maxTravelMinutes?: number }) =>
    patch<{ member: any }>(`/api/household/members/${id}`, body),
  deleteMember: (id: string) => del<void>(`/api/household/members/${id}`),
  addConstraint: (memberId: string, body: { kind: ConstraintKind; value: string; conceptKey?: string; maxMinutes?: number | null }) =>
    post<{ constraint: Constraint; resolved: { key: string; label: string; kind: string } | null; suggestions: Suggestion[]; hint: string | null; limited?: boolean }>(`/api/household/members/${memberId}/constraints`, body),
  updateConstraint: (id: string, body: { maxMinutes?: number | null; favourite?: boolean }) => patch<{ constraint: any }>(`/api/household/constraints/${id}`, body),
  deleteConstraint: (id: string) => del<void>(`/api/household/constraints/${id}`),
  learned: () => request<{ learned: Learned[]; threshold: number }>('/api/household/learned'),
  exportUrl: () => `${API_URL}/api/household/export`,

  /**
   * Everything the household has generated, as a file.
   *
   * Fetched rather than opened in a tab: the export is behind the door now, and
   * a new tab carries no session header. So it comes down through the same
   * request path as everything else and is handed to the browser as a download.
   */
  downloadExport: async (): Promise<void> => {
    const token = sessionToken();
    const res = await fetch(`${API_URL}/api/household/export`, {
      credentials: 'include',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
    const blob = await res.blob();
    if (typeof document === 'undefined') return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `roam-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  spendSeries: (months = 12) => request<SpendSeries>(`/api/household/spend/series${qs({ months })}`),
  spend: (p: { period: SpendPeriod; from?: string; to?: string }) => request<SpendResponse>(`/api/household/spend${qs(p)}`),
  deleteHousehold: (confirmName: string) => del<{ deleted: boolean }>('/api/household', { confirmName }),

  // prototypes (the owner's design review: approved, rejected, archived)
  prototypeReviews: () => request<{ reviews: Record<string, { status: PrototypeStatus; note: string | null; updatedAt: string | null }> }>('/api/prototypes'),
  reviewPrototype: (file: string, status: PrototypeStatus, note?: string | null) =>
    put<{ review: { file: string; status: PrototypeStatus; note: string | null; updatedAt: string | null } }>(`/api/prototypes/${encodeURIComponent(file)}`, { status, note }),

  // vocabulary
  browse: () => request<{ food: { title: string; hint: string; items: { key: string; label: string; children: { key: string; label: string }[] }[] }[]; activities: { title: string; hint: string; items: { key: string; label: string; children: { key: string; label: string }[] }[] }[]; diets: { key: string; label: string }[] }>('/api/concepts/browse'),
  suggest: (q: string, kinds?: string[], limit = 8) =>
    request<{ suggestions: Suggestion[] }>(`/api/concepts/suggest${qs({ q, kinds: kinds?.join(','), limit })}`),

  // menu, order and stars (the table half of an evening, owner 4 Sep 2026)
  /** What we already hold for this place — and, when we hold nothing, where their menu is. */
  heldMenu: (venueRef: string, website?: string | null) => request<{ menu: ReadMenu | null; link: MenuLink | null }>(`/api/menu${qs({ ref: venueRef, website: website ?? undefined })}`),
  /** Which of the four openers this deployment has: a browser makes a JavaScript menu readable for nothing. */
  menuOpeners: () => request<MenuOpeners>('/api/menu/openers'),
  /** Read their menu now. Slow on purpose: it fetches, may render, and reads. */
  readMenu: (body: { ref: string; url?: string; label?: string; website?: string }) => post<{ menu: ReadMenu }>('/api/menu/read', body),
  /** "What's this?" — written once for a dish and kept, so asking twice is free. */
  dishNote: (name: string, hint?: string) => post<{ dish: DishNote; cached: boolean }>('/api/menu/dish', { name, hint }),
  /** What we ate here before: the orders that became visits, with their stars. */
  orderHistory: (venueRef: string) => request<{ orders: (Order & { visitedOn: string | null })[] }>(`/api/orders/history${qs({ ref: venueRef })}`),
  order: (venueRef: string) => request<{ order: Order | null }>(`/api/orders${qs({ ref: venueRef })}`),
  saveOrder: (body: { clientId?: string; ref: string; label?: string; menuId?: string | null; items: { menuItemId?: string | null; memberId: string | null; name: string; priceText?: string | null; note?: string | null }[] }) =>
    post<{ order: Order }>('/api/orders', body),
  /** Throw away an order in progress (one that has not become a visit). */
  clearOrder: (id: string) => del<{ deleted: boolean }>(`/api/orders/${id}`),
  orderEaten: (id: string, body: { visitedOn?: string; attendeeIds?: string[] } = {}) => post<{ order: Order; visitId: string }>(`/api/orders/${id}/eaten`, body),
  rateOrder: (id: string, ratings: { orderItemId: string; memberId?: string | null; score?: number | null; notGreat?: boolean; comment?: string | null; conceptKey?: string | null }[]) =>
    post<{ order: Order }>(`/api/orders/${id}/ratings`, { ratings }),

  // places & visits
  /**
   * `bias.near` keeps matches inside that area first (a trip's city); `bias.country` never leaves
   * that country. `bias.kind: 'area'` asks a different index altogether — cities, towns and regions
   * matching a prefix, never a street or a shop — and is cheap enough to run on every keystroke.
   */
  geocode: (q: string, limit = 6, bias?: { near?: Place | null; country?: string | null; kind?: 'lodging' | 'area' | null }) =>
    request<{ results: Place[]; home?: { code: string; name: string | null }; attribution: string }>(`/api/places/geocode${qs({ q, limit, near: bias?.near ? `${bias.near.lat},${bias.near.lng}` : undefined, country: bias?.country ?? undefined, kind: bias?.kind ?? undefined })}`),
  /** Coordinates from the device → the address they sit at. Nothing is stored; the household asked for this one. */
  where: (lat: number, lng: number) => request<{ place: Place; named: boolean; attribution: string }>(`/api/places/where${qs({ at: `${lat},${lng}` })}`),
  /**
   * Somewhere to stay, ranked by how much of the shortlist is on foot from the
   * front door. Open map only — no prices, no availability (those need a
   * booking provider with a key, which is the owner's to add).
   */
  tripStays: (tripId: string, p: { radiusKm?: number; mode?: 'walking' | 'driving'; rooms?: number; adults?: number; children?: string } = {}) =>
    request<{
      near: { lat: number; lng: number; label: string };
      radiusKm: number; mode: 'walking' | 'driving'; cached: boolean; attribution: string; attributions: string[];
      anchors: { label: string; lat: number; lng: number }[];
      results: Stay[];
      pricing: StayPricing;
    }>(`/api/trips/${tripId}/stays${qs(p)}`),

  /**
   * This is where we're staying. Not a plain base update: a licensed bed is
   * looked for in the open map first, so what the trip keeps is a place we may
   * keep rather than a provider's record (api/routes/trips.js).
   */
  /** Which keys this process can see, and which Doppler config fed it. Owner only; 404 to anybody else. */
  keys: () => request<KeyReport>('/api/keys'),

  setTripStay: (tripId: string, b: { venueRef: string; label: string; lat: number; lng: number; checkIn?: string; checkOut?: string }) =>
    post<TripDetail & { stay: { named: 'open' | 'household'; how: string | null } }>(`/api/trips/${tripId}/stay`, b),

  /** `sources` is the exact set of sources for this one search (e.g. 'osm,tripadvisor'); omitted = the default set, which never includes opt-in sources. */
  searchPlaces: (p: { q?: string; near?: string; categories?: string; radiusKm?: number; sources?: string }) =>
    request<{ near: Place & { how: string }; radiusKm: number; results: Venue[]; sourcesQueried: string[]; degradedSources: { source: string; error: string }[]; attribution: string[] }>(`/api/places/search${qs(p)}`),
  place: (venueRef: string) =>
    request<{ venueRef: string; venue: Venue | null; household: Venue['household']; visits: Visit[]; menu?: MenuLink | null; ours?: OwnedRecord | null; sourceError?: string | null }>(`/api/places/detail${qs({ ref: venueRef })}`),
  /** What Roam owns about these places — no provider is called, and this answer keeps. */
  placeRecords: (venueRefs: string[]) => request<{ records: Record<string, OwnedRecord>; missing: string[] }>(`/api/places/record${qs({ refs: venueRefs.join(',') })}`),
  /** Research a place again now (Settings, and "look again" in the drawer). */
  researchPlace: (venueRef: string) => post<{ state: string; fields: number; matched: Record<string, any>; problems: string[]; record: OwnedRecord | null }>('/api/places/record', { ref: venueRef }),
  savePlace: (venueRef: string, status: 'saved' | 'dismissed' | 'special' = 'saved', context?: { label?: string; venue?: Partial<Venue>; category?: string | null; lat?: number; lng?: number; note?: string; country?: string | null; countryCode?: string | null; locality?: string | null }) =>
    post<{ venueRef: string; status: string }>('/api/places/save', { ref: venueRef, status, ...(context ?? {}) }),
  /** Predictions as you type: one cheap call, nothing fetched until one is chosen. */
  suggestPlaces: (p: { q: string; near?: string; radiusKm?: number; session?: string; kind?: string }) =>
    request<{ suggestions: { placeId: string | null; venueRef: string; name: string; where: string | null; kind: string | null; mine: boolean; types: string[] }[] }>(`/api/places/suggest${qs(p)}`),
  /** Take a place out of the atlas. Somewhere you've been is kept — delete the visit first. */
  deleteAtlasPlace: (venueRef: string) => del<void>('/api/atlas/places', { venueRef }),
  /** A place the atlas held only by its identifier learns its name once the source has been asked. */
  nameAtlasPlace: (venueRef: string, label: string) => patch<{ venueRef: string; label: string }>('/api/atlas/places', { venueRef, label }),
  createAtlasCity: (body: { placeText?: string; place?: Place }) => post<{ city: { name: string; country: string; countryCode: string; lat: number; lng: number } }>('/api/atlas/cities', body),
  deleteAtlasCity: (countryCode: string, locality: string) => del<void>('/api/atlas/cities', { countryCode, locality }),
  createVisit: (body: Omit<Partial<Visit>, 'takes'> & { venueRef: string; venueLabel: string; attendeeIds?: string[]; takes?: VisitTakeInput[]; clientId?: string; venue?: Partial<Venue> }) =>
    post<{ visit: Visit; deduplicated?: boolean }>('/api/visits', body),
  visits: (p: { country?: string; q?: string; memberId?: string; take?: Take } = {}) =>
    request<{ visits: Visit[]; countries: { code: string; name: string; visits: number }[] }>(`/api/visits${qs(p)}`),
  visit: (id: string) => request<{ visit: Visit }>(`/api/visits/${id}`),
  updateVisit: (id: string, body: { note?: string; visitedOn?: string; venueLabel?: string }) => patch<{ visit: Visit }>(`/api/visits/${id}`, body),
  setTakes: (id: string, takes: VisitTakeInput[], venue?: Partial<Venue>) => put<{ visit: Visit }>(`/api/visits/${id}/takes`, { takes, venue }),
  deleteVisit: (id: string) => del<void>(`/api/visits/${id}`),

  // group trips
  tripGroup: (tripId: string) => request<TripGroup | { group: null }>(`/api/trips/${tripId}/group`),
  createTripGroup: (tripId: string, body: { name?: string; expectedCount?: number | null; minimumCount?: number | null; wantedBy?: string | null; cadence?: string; organiserMemberId?: string | null }) => post<TripGroup>(`/api/trips/${tripId}/group`, body),
  updateGroup: (id: string, body: Partial<{ name: string; expectedCount: number | null; minimumCount: number | null; maximumCount: number | null; wantedBy: string | null; remindersOn: boolean; cadence: string; closed: boolean; newLink: boolean; setupDone: boolean; firstReminderOn: string | null }>) => patch<TripGroup>(`/api/groups/${id}`, body),
  deleteGroup: (id: string) => del<{ deleted: boolean }>(`/api/groups/${id}`),
  addGroupItem: (id: string, body: GroupItemInput) => post<TripGroup>(`/api/groups/${id}/items`, body),
  updateGroupItem: (id: string, itemId: string, body: Partial<GroupItemInput & { position: number; state: GroupItemState2 }>) => patch<TripGroup>(`/api/groups/${id}/items/${itemId}`, body),
  /** The closing day, by hand: close it and bill, give it longer, call it off, or undo. */
  closeGroupItem: (id: string, itemId: string, body: { action: 'close' | 'extend' | 'cancel' | 'reopen'; closesOn?: string; note?: string; anyway?: boolean }) =>
    post<TripGroup>(`/api/groups/${id}/items/${itemId}/close`, body),
  removeGroupItem: (id: string, itemId: string) => del<TripGroup>(`/api/groups/${id}/items/${itemId}`),
  addGroupParticipant: (id: string, body: { name: string; contact?: string; contactKind?: string; heads?: number; brings?: string; note?: string }) => post<TripGroup>(`/api/groups/${id}/participants`, body),
  updateGroupParticipant: (id: string, pid: string, body: Partial<{ name: string; contact: string; contactKind: string; heads: number; brings: string; note: string; withdrawn: boolean; withdrawnNote: string }>) => patch<TripGroup>(`/api/groups/${id}/participants/${pid}`, body),
  removeGroupParticipant: (id: string, pid: string) => del<TripGroup>(`/api/groups/${id}/participants/${pid}`),
  markGroupItem: (id: string, pid: string, itemId: string, body: { status: GroupStatus | 'clear'; bookingRef?: string | null; whereBooked?: string | null; startsOn?: string | null; endsOn?: string | null; note?: string | null }) =>
    post<TripGroup>(`/api/groups/${id}/participants/${pid}/items/${itemId}`, body),
  chaseGroup: (id: string, body: { participantIds?: string[]; itemId?: string } = {}) => post<TripGroup>(`/api/groups/${id}/reminders`, body),

  // the invite link's side: no household, no roster
  joinView: (token: string, participantToken?: string | null) => request<JoinView>(`/api/join/${token}${participantToken ? `?p=${encodeURIComponent(participantToken)}` : ''}`),
  join: (token: string, body: { name: string; contact?: string; contactKind?: string; heads?: number; brings?: string; matchId?: string | null }) => post<JoinView & { participantToken: string }>(`/api/join/${token}`, body),
  setJoinItem: (token: string, itemId: string, body: { participantToken: string; status: 'booked' | 'declared' | 'in' | 'out' | 'clear'; bookingRef?: string | null; whereBooked?: string | null; startsOn?: string | null; endsOn?: string | null; note?: string | null }) =>
    post<JoinView>(`/api/join/${token}/items/${itemId}`, body),

  // trips
  trips: (p: { country?: string; when?: 'upcoming' | 'past'; q?: string; kind?: TripKind } = {}) =>
    request<{ trips: TripSummary[]; countries: { code: string; name: string; trips: number }[] }>(`/api/trips${qs(p)}`),
  // atlas
  atlas: () => request<{ countries: AtlasCountry[]; unplaced: number; home: AtlasHome | null }>('/api/atlas'),
  atlasPlaces: (p: { country?: string; city?: string; kind?: string; status?: string; q?: string; nearHome?: boolean } = {}) => request<{ places: AtlasPlace[]; wherePending?: number }>(`/api/atlas/places${qs(p)}`),
  /** The country, the areas and the ground a search covers. Answers from what the API holds, so it never delays a search. */
  atlasSketch: (p: { lat: number; lng: number; radiusKm?: number; country?: string }) => request<SketchMap>(`/api/atlas/sketch${qs(p)}`),
  // trips v2
  createMultiDayTrip: (body: { title?: string; notes?: string; place?: Place; placeText?: string; startDate: string; endDate: string; base?: Place; baseText?: string; baseKind?: string; checkIn?: string; checkOut?: string; hasCar?: boolean; travelMode?: Trip['travelMode']; intensity?: Trip['intensity']; dayStart?: string; dayEnd?: string; attendingMemberIds?: string[]; seedFromAtlas?: boolean }) =>
    post<TripDetail>('/api/trips', { kind: 'trip', ...body }),
  updateTripV2: (id: string, body: Partial<{ title: string; notes: string; startDate: string; endDate: string; hasCar: boolean; travelMode: Trip['travelMode']; intensity: Trip['intensity']; dayStart: string; dayEnd: string; base: Place; baseText: string; baseKind: string; checkIn: string; checkOut: string; sources: string[] | null }>) => patch<TripDetail>(`/api/trips/${id}`, body),
  updateDay: (tripId: string, dayId: string, body: Partial<{ intensity: Trip['intensity']; travelMode: Trip['travelMode']; startTime: string; endTime: string; notes: string; startPoint: Endpoint | Place | null; endPoint: Endpoint | Place | null }>) => patch<TripDetail>(`/api/trips/${tripId}/days/${dayId}`, body),
  shortlistSearch: (tripId: string, p: SearchParams) => request<SearchAnswer>(`/api/trips/${tripId}/shortlist/search${qs(p)}`),

  /**
   * The same search, said out loud while it runs, so the map drawn over the
   * wait (SearchSketch) can show what has really happened rather than a clock.
   *
   * Server-sent events. Where they are not available — native, or a proxy that
   * will not stream — this falls back to the plain route and the map simply has
   * less to say. A stream that breaks falls back too: the search matters, the
   * commentary does not.
   */
  shortlistSearchStream: async (tripId: string, p: SearchParams, onEvent: (e: SketchEvent) => void): Promise<SearchAnswer> => {
    if (typeof EventSource === 'undefined') return api.shortlistSearch(tripId, p);
    try {
      return await new Promise<SearchAnswer>((resolve, reject) => {
        // `withCredentials` is what carries the session cookie, and the stream
        // is one of only two GETs the API accepts a cookie for (api/src/auth.js)
        // — an EventSource cannot send a header. Deployed, the web app and the
        // API are two origins, so without this every search would 401 on the
        // stream and fall back to the plain request with no map drawn.
        const es = new EventSource(`${API_URL}/api/trips/${tripId}/shortlist/search/stream${qs(p)}`, { withCredentials: true });
        const stop = () => { try { es.close(); } catch { /* already gone */ } };
        // Every event the API can send. A name missing from this list is an
        // event delivered and silently dropped, which looks exactly like a
        // stream that never arrived.
        for (const name of ['asking', 'answered', 'failed', 'cached', 'joining', 'waiting']) {
          es.addEventListener(name, (e) => { try { onEvent(JSON.parse((e as MessageEvent).data)); } catch { /* one unreadable line is not the search */ } });
        }
        es.addEventListener('done', (e) => { stop(); resolve(JSON.parse((e as MessageEvent).data)); });
        es.addEventListener('fault', (e) => { stop(); const b = JSON.parse((e as MessageEvent).data); reject(new ApiError(b.status ?? 500, b)); });
        // The browser reopens a closed stream by itself, which would run the
        // whole search a second time. Closing here is what stops that.
        es.onerror = () => { stop(); reject(new Error('stream closed')); };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      return api.shortlistSearch(tripId, p);
    }
  },
  addToShortlist: (tripId: string, body: { venueRef: string; venueLabel: string; kind?: string; category?: string | null; lat?: number | null; lng?: number | null; venue?: Partial<Venue>; note?: string; mustDo?: boolean; preferredDayId?: string | null }) => post<TripDetail>(`/api/trips/${tripId}/shortlist`, body),
  updateShortlist: (tripId: string, itemId: string, body: { note?: string; mustDo?: boolean; preferredDayId?: string | null; kind?: string; status?: ShortlistStatus; bookedTime?: string | null; partySize?: string | null; bookingRef?: string | null; statusNote?: string | null; statusOn?: string | null; dwellMinutes?: number | null; legMode?: LegMode | '' | null; dayId?: string | null }) => patch<TripDetail>(`/api/trips/${tripId}/shortlist/${itemId}`, body),
  reorderShortlist: (tripId: string, itemIds: string[]) => post<TripDetail>(`/api/trips/${tripId}/shortlist/reorder`, { itemIds }),
  journey: (tripId: string, p: { dayId?: string; source?: 'shortlist' | 'day' } = {}) => request<Journey>(`/api/trips/${tripId}/journey${qs(p)}`),
  saveJourney: (tripId: string, dayId: string, force = false) => post<{ saved: number; dayId: string; trip: TripDetail }>(`/api/trips/${tripId}/journey/save`, { dayId, force }),
  directions: (tripId: string, p: { from: string; to: string; mode: LegMode; departAt?: string }) => request<Directions>(`/api/trips/${tripId}/directions${qs(p)}`),
  removeFromShortlist: (tripId: string, itemId: string) => del<TripDetail>(`/api/trips/${tripId}/shortlist/${itemId}`),
  addDayStop: (tripId: string, dayId: string, body: { venueRef?: string; name?: string; lat?: number | null; lng?: number | null; category?: string | null; dwellMinutes?: number; slot?: 'morning' | 'afternoon' | 'evening'; startTime?: string; shortlistId?: string }) => post<TripDetail>(`/api/trips/${tripId}/days/${dayId}/stops`, body),
  updateStop: (tripId: string, stopId: string, body: { dayId?: string; slot?: 'morning' | 'afternoon' | 'evening'; startTime?: string; dwellMinutes?: number; position?: number }) => patch<TripDetail>(`/api/trips/${tripId}/stops/${stopId}`, body),
  planDay: (tripId: string, dayId: string, body: { minActivities?: number; minFood?: number } = {}) => post<PlanResponse>('/api/plan/day', { tripId, dayId, ...body }),
  trip: (id: string) => request<TripDetail>(`/api/trips/${id}`),
  tripPlaces: (id: string) => request<{ places: TripPlace[]; counts: { all: number; do: number; eat: number; stay: number } }>(`/api/trips/${id}/places`),
  createTrip: (body: { title?: string; notes?: string; origin?: Place; originText?: string; destination?: Place; destinationText?: string; departAt: string; returnAt: string; travelMode?: Trip['travelMode']; intensity?: Trip['intensity']; attendingMemberIds?: string[] }) =>
    post<TripDetail>('/api/trips', body),
  updateTrip: (id: string, body: Partial<Pick<Trip, 'title' | 'notes' | 'departAt' | 'returnAt' | 'travelMode' | 'intensity'>>) => patch<TripDetail>(`/api/trips/${id}`, body),
  deleteTrip: (id: string) => del<void>(`/api/trips/${id}`),
  addStop: (tripId: string, body: { venueRef: string; name: string; lat?: number; lng?: number; dwellMinutes?: number }) => post<TripDetail>(`/api/trips/${tripId}/stops`, body),
  removeStop: (tripId: string, stopId: string) => del<TripDetail>(`/api/trips/${tripId}/stops/${stopId}`),
  reorderStops: (tripId: string, stopIds: string[]) => post<TripDetail>(`/api/trips/${tripId}/stops/reorder`, { stopIds }),
  visitStop: (tripId: string, stopId: string, body: { visitedOn?: string; note?: string; venue?: Partial<Venue> } = {}) =>
    post<{ visit: Visit; tripId: string }>(`/api/trips/${tripId}/stops/${stopId}/visit`, body),

  // planner
  planStart: (utterance: string, sessionId?: string | null, sources?: string[] | null, attendingMemberIds?: string[] | null, extra: { field?: PlanRowKey | null; skip?: string | null } = {}) =>
    post<PlanResponse>('/api/plan/start', { utterance, sessionId: sessionId ?? undefined, sources: sources ?? undefined, attendingMemberIds: attendingMemberIds ?? undefined, field: extra.field ?? undefined, skip: extra.skip ?? undefined }),
  planSet: (set: PlanSet, sessionId?: string | null, attendingMemberIds?: string[] | null) => post<PlanResponse>('/api/plan/start', { set, sessionId: sessionId ?? undefined, attendingMemberIds: attendingMemberIds ?? undefined }),
  planPlaces: (q: string) => request<{ places: { label: string; where: string; kind: string; isRoad: boolean; travelMinutes: number | null; place: Place }[] }>(`/api/plan/places${qs({ q })}`),
  planGo: (sessionId: string) => post<PlanResponse>('/api/plan/go', { sessionId }),
  planPreview: (utterance: string, sessionId?: string | null) => post<{ sessionId: string; rows: PlanRow[] }>('/api/plan/preview', { utterance, sessionId: sessionId ?? undefined }),
  /** Inspire me runs in the background: the answer is the session; poll inspireStatus until running is false. */
  inspire: (body: { query: string; moods: string[]; maxTravelMinutes: number | null; budget?: IdeaBudget; attendingMemberIds?: string[] | null }) => post<{ sessionId: string; ref: string; running: boolean; stage: InspireStage }>('/api/plan/inspire', body),
  inspireStatus: (sessionId: string) => request<{ sessionId: string; ref: string; running: boolean; ideas: Idea[] | null; reply: string | null; budget: IdeaBudget; stage: InspireStage | null; placed: number; startedAt: string | null; error: string | null }>(`/api/plan/inspire/${sessionId}`),
  /** Five more days out on the same list, without losing the ones already there. */
  inspireMore: (body: { sessionId: string; attendingMemberIds?: string[] | null }) => post<{ sessionId: string; ref: string; running: boolean; stage: InspireStage }>('/api/plan/inspire/more', body),
  /** What is inside a place with grounds: the rides in a theme park, researched once and ours to keep. */
  placeInside: (q: { ref: string; lat?: number; lng?: number; experiences?: string; name?: string; website?: string; refresh?: '1' }) =>
    request<{ ref: string; items: PlaceInsideItem[]; researched: boolean; askingWhoCanRide?: boolean }>(`/api/places/inside${qs(q)}`),
  /** What one run did, by the number shown on screen: what was asked, how long, and every call it made. */
  planRun: (ref: string) => request<{ ref: string; sessionId: string; kind: string; asked: any; startedAt: string; seconds: number; stage: string; running: boolean; error: string | null; answered: { title: string; pinned: boolean }[] | null; calls: { provider: string; purpose: string; units: any; costUsd: number | null; at: string; afterSeconds: number }[] }>(`/api/plan/runs/${ref}`),
  inspireThings: (q: { lat: number; lng: number; label: string; locality?: string }) => request<{ items: IdeaThing[]; headline: IdeaHeadline | null; cached?: boolean; tookMs?: number }>(`/api/plan/inspire/things${qs(q)}`),
  /** Things to do and see: the idea becomes a day out in Trips, what Roam named already shortlisted. */
  inspireTrip: (body: { sessionId: string; ideaId: string; attendingMemberIds?: string[] | null }) => post<{ tripId: string; title: string; date: string; seeded: string[]; reply: string; existing: boolean }>('/api/plan/inspire/trip', body),
  /** The family's table: the best places for the food the people coming love. Runs in the background like Inspire me. */
  tastes: (body: { brief: string; moods: string[]; maxTravelMinutes: number | null; budget?: IdeaBudget; attendingMemberIds?: string[] | null }) => post<TastesResponse>('/api/plan/tastes', body),
  tastesStatus: (sessionId: string) => request<TastesResponse>(`/api/plan/tastes/${sessionId}`),
  tastesAround: (q: { sessionId: string; tasteKey: string; venueRef: string; members?: string }) => request<{ items: AroundThing[]; forUs: AroundThing[]; cached: boolean; radiusKm: number }>(`/api/plan/tastes/around${qs(q)}`),
  /** Reading a menu takes a minute or two, so it runs in the background: start it, then poll tastesMenuStatus. */
  tastesMenu: (body: { sessionId: string; tasteKey: string; venueRef: string; attendingMemberIds?: string[] | null }) => post<{ reading: boolean; menu: MenuRead | null; error: string | null }>('/api/plan/tastes/menu', body),
  tastesMenuStatus: (q: { sessionId: string; tasteKey: string; venueRef: string }) => request<{ reading: boolean; menu: MenuRead | null; error: string | null; usage: { used: number; limit: number } }>(`/api/plan/tastes/menu${qs(q)}`),
  tastesTrip: (body: { sessionId: string; tasteKey: string; venueRef: string; attendingMemberIds?: string[] | null; around?: string[] }) => post<{ tripId: string; title: string; date: string; seeded: string[]; reply: string; existing: boolean }>('/api/plan/tastes/trip', body),
  tripSources: (id: string, p: { dayId?: string; sources?: string; scout?: '1' }) => request<SourceTrace>(`/api/plan/trips/${id}/sources${qs(p)}`),
  tripSpend: (id: string) => request<{ calls: number; costUsd: number; byProvider: { provider: string; calls: number; cost_usd: number }[] }>(`/api/trips/${id}/spend`),
  planRefine: (sessionId: string, utterance: string, viewingOptionId?: string | null) => post<PlanResponse>('/api/plan/refine', { sessionId, utterance, viewingOptionId }),
  planAct: (sessionId: string, action: PlanAction) => post<PlanResponse>('/api/plan/act', { sessionId, action }),
  planCommit: (sessionId: string, optionId: string) => post<{ tripId: string; optionId: string; stops: number }>('/api/plan/commit', { sessionId, optionId }),
  planGet: (sessionId: string) => request<PlanResponse>(`/api/plan/${sessionId}`),
  planLatestForDay: (tripId: string, dayId: string) => request<PlanResponse & { sessionId: string | null }>(`/api/plan/day/latest${qs({ tripId, dayId })}`),

  // offline
  /** What is worth having on the device, and how much of the research Roam owns. */
  offlineManifest: () => request<OfflineManifest>('/api/offline/manifest'),
  /** Every owned record for this household's places, in one request. */
  offlineRecords: () => request<{ records: Record<string, OwnedRecord>; count: number; terms: string; generatedAt: string }>('/api/offline/records'),
  /**
   * Fill the device's copy: fetch every page in the manifest so that the atlas,
   * the trips, the visit history and every owned place record are there before
   * the signal goes. Each page is saved by the same rule as any other answer.
   */
  saveForOffline: (): Promise<void> => warm((path) => request<any>(path)),
  /** The quiet daily fill, on start-up: only what the API answers for free. */
  keepDeviceCopyFresh: (): Promise<void> => warmQuietly((path) => request<any>(path)),

  // --- the door -------------------------------------------------------------

  /** Whether this device is signed in, and whether the API is asking at all. */
  sessionState: () => request<SessionState>('/api/session'),

  /**
   * The passcode, once. The token is kept on the device from here on; the
   * cookie the API also sets exists only so an `<img>` can load a photograph.
   */
  signIn: async (passcode: string): Promise<SessionState> => {
    const r = await post<{ token: string; session: SessionSummary; account?: AccountSummary | null }>('/api/session', { passcode, label: deviceLabel() });
    await claimDeviceCopy(r.account);
    setSessionToken(r.token);
    // Anything written while they were signed out goes now.
    void api.sendWaitingWrites();
    // The passcode is the owner's own way in, whether or not he has claimed an
    // account row yet (api/src/auth.js `requireOwner`).
    return { signedIn: true, configured: true, session: r.session, account: r.account ?? null, isOwner: true };
  },

  /**
   * Sign out. The device's saved copy is deliberately *not* thrown away here —
   * it is the same household's data and they will sign back in — but anything
   * still waiting to be sent is reported first, so nobody signs out on top of
   * unsent ratings without being told.
   */
  signOut: async ({ everywhere = false } = {}): Promise<void> => {
    try { await del<void>(`/api/session${everywhere ? '?all=1' : ''}`); } catch { /* leaving is not something the server can refuse */ }
    setSessionToken(null);
  },

  /** The devices signed in, for Settings. Their own, never the whole estate's. */
  devices: () => request<{ sessions: (SessionSummary & { lastSeen: string })[] }>('/api/sessions'),

  /**
   * A magic link, exchanged for a session.
   *
   * The token is in the address the person opened (`?signin=…`). It works once,
   * so this is called exactly once and the address is cleaned immediately
   * afterwards — a link left in the URL bar is a link that gets bookmarked,
   * shared and pasted into a chat.
   */
  signInWithLink: async (token: string): Promise<SessionState> => {
    const r = await post<{ token: string; session: SessionSummary; account: AccountSummary }>(
      '/api/session/link', { token, label: deviceLabel() },
    );
    await claimDeviceCopy(r.account);
    setSessionToken(r.token);
    void api.sendWaitingWrites();
    return { signedIn: true, configured: true, session: r.session, account: r.account, isOwner: r.account?.role === 'owner' };
  },

  /**
   * "E-mail me a link." Answers the same whether or not the address has an
   * account, so it cannot be used to find out who else uses Roam.
   */
  requestSignInLink: (email: string) => post<{ sent: boolean; message: string }>('/api/session/request-link', { email }),

  // --- the admin module: only the owner's API answers any of these ----------

  /** Everybody who has Roam, with what they are on and what they have spent. */
  accounts: () => request<AccountsResponse>('/api/accounts'),
  /** One of them, with the sign-ins behind the count. */
  account: (id: string) => request<{ account: Account; signIns: { id: string; method: string; label: string | null; at: string }[]; lastInvite: AccountInvite | null }>(`/api/accounts/${id}`),
  /** Add a person: a household of their own, and an invitation unless told not to. */
  addAccount: (body: { email: string; name?: string; plan?: string; trialEndsOn?: string | null; monthlyCallBound?: number | null; note?: string; invite?: boolean }) =>
    post<{ account: Account; invitation: Invitation | null }>('/api/accounts', body),
  /** The owner's own account, on the household he already has. */
  claimOwnerAccount: (body: { email: string; name?: string }) => post<{ account: Account }>('/api/accounts/owner', body),
  /** Plan, status, ceiling, note. */
  updateAccount: (id: string, body: Partial<{ name: string; plan: string; status: string; trialEndsOn: string | null; monthlyCallBound: number | null; note: string }>) =>
    patch<{ account: Account }>(`/api/accounts/${id}`, body),
  /** A fresh link — sent if there is a sender, and shown either way so it can be sent by hand. */
  inviteAccount: (id: string) => post<{ account: Account; invitation: Invitation }>(`/api/accounts/${id}/invite`, {}),
  /** Sign every device that account is on out. */
  signOutAccount: (id: string) => post<{ account: Account; signedOut: boolean }>(`/api/accounts/${id}/sign-out`, {}),
  /** Remove the account. Their household's data only goes with it when asked. */
  removeAccount: (id: string, { withHousehold = false } = {}) =>
    del<{ removed: boolean; withHousehold: boolean; message: string }>(`/api/accounts/${id}${withHousehold ? '?withHousehold=1' : ''}`),


  // --- the back office ------------------------------------------------------
  //
  // Every one of these answers 404 to a session without the admin door, so the
  // app drawing them at all is a courtesy rather than the security boundary.

  adminOverview: (days = 30) => request<AdminOverview>(`/api/admin/overview?days=${days}`),
  adminPeople: (days = 30) => request<AdminPeople>(`/api/admin/people?days=${days}`),
  adminPerson: (id: string, days = 30) => request<PersonRecord>(`/api/admin/people/${id}?days=${days}`),
  adminSetRole: (id: string, roleId: string | null) => patch<{ account: { id: string; role: any } }>(`/api/admin/people/${id}/role`, { roleId }),
  adminActivity: (days = 30) => request<{ window: { days: number }; feed: FeedRow[]; screens: ScreenRow[]; daily: DailyRow[]; active: Engagement['active'] }>(`/api/admin/activity?days=${days}`),
  adminEngagement: (days = 30) => request<Engagement>(`/api/admin/reporting/engagement?days=${days}`),
  adminRevenue: () => request<RevenueReport>('/api/admin/reporting/revenue'),
  adminUsage: (days = 30) => request<UsageReport>(`/api/admin/reporting/usage?days=${days}`),
  adminRoles: () => request<{ roles: Role[]; capabilities: Capability[]; doors: string[] }>('/api/admin/roles'),
  adminCreateRole: (body: { key: string; label: string; description?: string; doors: string[]; capabilities: string[] }) =>
    post<{ role: Role }>('/api/admin/roles', body),
  adminUpdateRole: (id: string, body: Partial<{ label: string; description: string; doors: string[]; capabilities: string[] }>) =>
    patch<{ role: Role }>(`/api/admin/roles/${id}`, body),
  adminDeleteRole: (id: string) => del<{ removed: boolean }>(`/api/admin/roles/${id}`),
  adminPlans: () => request<{ plans: SubscriptionPlan[] }>('/api/admin/plans'),
  adminUpdatePlan: (key: string, body: Partial<{ label: string; note: string; pricePence: number | null; callBound: number | null; active: boolean }>) =>
    patch<{ plan: SubscriptionPlan }>(`/api/admin/plans/${key}`, body),
  adminAudit: (limit = 200) => request<{ audit: AuditRow[] }>(`/api/admin/audit?limit=${limit}`),

  // --- the atlas library: attractions, and the pictures we own ---------------
  // Owner, 4 Sep 2026: "the top 15 to 20 attractions in each county and the top
  // 100 or so in London… images that we can hold in a database… some form of
  // index, a proper form of indexing, so we can search and find the images that
  // we own."
  scoutAreas: () => request<{ areas: ScoutArea[] }>('/api/admin/scout/'),
  scoutAddArea: (body: { code: string; label?: string; radiusKm?: number; keep?: number }) =>
    post<{ area: ScoutArea }>('/api/admin/scout/areas', body),
  scoutSweep: (code: string) => post<Record<string, unknown>>(`/api/admin/scout/areas/${code}/sweep`, {}),
  scoutRescore: (code: string) => post<{ code: string; rescored: number }>(`/api/admin/scout/areas/${code}/rescore`, {}),
  scoutFillMenus: (limit = 5) => post<Record<string, unknown>>('/api/admin/scout/menus/fill', { limit }),
  scoutReadMenus: (limit = 10) => post<{ started: number }>('/api/admin/scout/menus/read', { limit }),
  scoutRetryMenus: () => post<{ requeued: number }>('/api/admin/scout/menus/retry', {}),
  scoutMisses: () => request<{ misses: ScoutMenuMiss[] }>('/api/admin/scout/menus/missing'),
  scoutPlaces: (code: string, limit = 25) =>
    request<{ area: { code: string; label: string | null; sweptAt: string | null }; places: ScoutPlace[] }>(`/api/places/area/${code}?limit=${limit}`),
  libraryOverview: () => request<LibraryOverview>('/api/admin/library'),
  libraryRegions: () => request<{ regions: LibraryRegion[] }>('/api/admin/library/regions'),
  librarySetTarget: (slug: string, targetCount: number) =>
    patch<{ region: LibraryRegion }>(`/api/admin/library/regions/${slug}`, { targetCount }),
  libraryRank: (slug: string) => post<{ region: LibraryRegion }>(`/api/admin/library/regions/${slug}/rank`, {}),
  libraryTypes: (p: { region?: string; state?: string } = {}) =>
    request<{ types: LibraryType[] }>(`/api/admin/library/types${qs(p)}`),
  libraryAttractions: (p: { region?: string; state?: string; q?: string; category?: string; kind?: string; limit?: number }) =>
    request<{ attractions: LibraryAttraction[] }>(`/api/admin/library/attractions${qs(p)}`),
  libraryCurate: (id: string, body: { state?: string; pinned?: boolean; note?: string }) =>
    patch<{ attraction: LibraryAttraction }>(`/api/admin/library/attractions/${id}`, body),
  libraryImages: (p: { q?: string; source?: string; licence?: string; region?: string; category?: string; subjectType?: string; subjectId?: string; moderation?: string; unlinked?: boolean; credit?: boolean; limit?: number; offset?: number }) =>
    request<{ images: LibraryImage[]; total: number }>(`/api/admin/library/images${qs(p)}`),
  libraryImage: (id: string) => request<{ image: LibraryImage & { variants: { width: number; actualWidth: number; bytes: number }[] }; links: any[] }>(`/api/admin/library/images/${id}`),
  libraryModerate: (id: string, body: { moderation?: string; note?: string; points?: number }) =>
    patch<{ image: LibraryImage }>(`/api/admin/library/images/${id}`, body),
  libraryDeleteImage: (id: string) => del<{ ok: boolean }>(`/api/admin/library/images/${id}`),
  libraryKinds: (p: { q?: string; admit?: boolean; limit?: number } = {}) => request<{ kinds: LibraryKind[] }>(`/api/admin/library/kinds${qs(p)}`),
  librarySetKind: (qid: string, body: { admit?: boolean; category?: string }) =>
    patch<{ kind: LibraryKind }>(`/api/admin/library/kinds/${qid}`, body),
  libraryContributors: () => request<LibraryContributor[]>('/api/admin/library/contributors').then((r: any) => r.contributors ?? r),
  // --- reading a place, and being taught what we got wrong ------------------
  libraryAttraction: (id: string) =>
    request<{ attraction: LibraryAttractionDetail; facts: AttractionFactsRow | null; contents: PlaceContent[]; lessons: ExtractionLesson[] }>(`/api/admin/library/attractions/${id}`),
  libraryFetchDetail: (id: string, force = false) =>
    post<{ state: string; sections: number; contentsCount: number; attraction: LibraryAttractionDetail }>(`/api/admin/library/attractions/${id}/detail`, { force }),
  libraryRead: (id: string, effort?: string) =>
    post<{ facts: AttractionFactsRow; lessons: ExtractionLesson[]; examples: number }>(`/api/admin/library/attractions/${id}/read`, { effort }),
  libraryReview: (id: string, body: { review: 'approved' | 'corrected' | 'rejected'; note?: string; wrongFields?: string[]; lesson?: { scope?: string; subject?: string | null; subjectLabel?: string | null; rule: string; field?: string | null; said?: string | null } }) =>
    post<{ facts: AttractionFactsRow; lesson: ExtractionLesson | null }>(`/api/admin/library/attractions/${id}/review`, body),
  libraryLessons: (p: { scope?: string; region?: string } = {}) =>
    request<{ lessons: ExtractionLesson[]; stats: ReadingStats }>(`/api/admin/library/lessons${qs(p)}`),
  librarySetLesson: (id: string, body: { active?: boolean; rule?: string; field?: string | null }) =>
    patch<{ lesson: ExtractionLesson }>(`/api/admin/library/lessons/${id}`, body),
  libraryRegionDetail: (slug: string, limit = 50, force = false) =>
    post<{ counts: Record<string, number> }>(`/api/admin/library/regions/${slug}/detail`, { limit, force }),
  libraryRegionRead: (slug: string, limit = 25, anyway = false) =>
    post<{ read: number; failed: number; errors: string[] }>(`/api/admin/library/regions/${slug}/read`, { limit, anyway }),
  // --- the shelves: teaching what the home screen calls a place -------------
  shelfVocabulary: () => request<ShelfVocabulary>('/api/admin/shelves/'),
  shelfContents: (p: { mood: MoodKey; lat?: number; lng?: number; km?: number }) =>
    request<{ mood: MoodKey; place: { lat: number; lng: number; label: string | null }; km: number; items: ShelfPlace[]; nearly: ShelfPlace[]; pool: number }>(`/api/admin/shelves/shelf${qs(p)}`),
  shelfFindPlaces: (q: string) => request<{ places: ShelfPlace[] }>(`/api/admin/shelves/places${qs({ q })}`),
  shelfTeach: (body: { scope: ShelfRule['scope']; subject: string; subjectLabel?: string | null; weights: ShelfWeights; reason?: string | null }) =>
    put<{ rule: ShelfRule }>('/api/admin/shelves/rules', body),
  shelfForget: (id: string) => del<{ removed: boolean; rule: ShelfRule }>(`/api/admin/shelves/rules/${id}`),
  shelfRead: (body: { said: string; subject?: string | null; subjectLabel?: string | null; scope?: ShelfRule['scope'] | null; current?: ShelfWeights | null }) =>
    post<{ proposal: ShelfProposal }>('/api/admin/shelves/read', body),
  shelfNameKinds: (limit = 400) => post<{ named: number; asked: number; remaining: number }>('/api/admin/shelves/kinds/name', { limit }),

  libraryHarvest: (body: { scope?: 'all' | 'never' | 'failed'; regions?: string[]; withImages?: boolean; refreshTypes?: boolean }) =>
    post<{ run: HarvestRun }>('/api/admin/library/harvest', body),
  libraryRun: (id: string) => request<{ run: HarvestRun }>(`/api/admin/library/harvest/${id}`),
  libraryCancel: (id: string) => post<{ run: HarvestRun }>(`/api/admin/library/harvest/${id}/cancel`, {}),

  /**
   * Where the bytes are. Not a `request()` — this goes straight into an `<Image
   * src>`, is outside the session door on purpose (routes/library.js) and is
   * cached immutably for a year, so the second view of any card never reaches
   * the API at all.
   */
  /**
   * The home screen's one read: everything around a point, already sorted into
   * the six moods, with the journey and the stay worked out per place.
   */
  inspireNear: (q: { lat?: number; lng?: number; label?: string; locality?: string | null; from?: string | null; mode?: string; km?: number; live?: 1 }) =>
    request<InspireNear>(`/api/inspire/near${qs(q)}`),

  imageUrl: (id: string, width = 500) => `${API_URL}/api/images/${id}/${width}`,

  /** The household app's read: one county, instantly, off one table. */
  regionAttractions: (slug: string) => request<RegionAttractions>(`/api/atlas/regions/${slug}`),
  atlasRegions: () => request<{ regions: { slug: string; name: string; nation: string; kind: string; lat: number | null; lng: number | null; count: number; images: number }[] }>('/api/atlas/regions'),

  /**
   * Telemetry: which screen, and still here. Fire-and-forget by design — a
   * household must never notice that reporting failed.
   */
  reportActivity: (events: { kind: string; screen?: string; subject?: string; seconds?: number; at?: string }[]) =>
    post<{ recorded: number }>('/api/activity', { events }).catch(() => ({ recorded: 0 })),

  // --- writes that have not gone yet ----------------------------------------

  /** Send everything waiting in the outbox. Safe to call at any time. */
  sendWaitingWrites: (): Promise<void> => flushOutbox(sendQueued),
  /** Count what is waiting, without sending it. */
  countWaitingWrites: (): Promise<void> => refreshOutbox(),
};

export type SessionSummary = { id: string; label: string | null; since: string; until: string };
export type AccountSummary = { id: string; email: string; name: string | null; role: 'owner' | 'customer'; plan: string };
export type SessionState = {
  signedIn: boolean;
  configured: boolean;
  session?: SessionSummary | null;
  message?: string;
  /** Who is signed in, when they are on an account rather than the shared passcode. */
  account?: AccountSummary | null;
  /** Whether the admin module is theirs to see. The API decides this, not the app. */
  isOwner?: boolean;
  /** Their account was suspended while they were signed in. */
  suspended?: boolean;
  /** Which applications this session may enter, and what it may do in them. */
  access?: Access | null;
};

// --- the atlas library ------------------------------------------------------

export type LibraryRegion = {
  slug: string; name: string; nation: string; kind: string;
  wikidata_id: string | null; lat: number | null; lng: number | null;
  target_count: number; harvest_state: 'never' | 'queued' | 'running' | 'done' | 'failed';
  harvest_error: string | null; harvested_at: string | null;
  candidate_count: number; published_count: number; image_count: number;
};

export type LibraryAttraction = {
  id: string; region_slug: string; region_name: string; nation: string;
  wikidata_id: string; name: string; slug: string; summary: string | null;
  category: string | null; lat: number | null; lng: number | null;
  wikipedia_url: string | null; website: string | null; heritage: string | null;
  sitelinks: number; pageviews_year: number | null; score: number; rank: number | null;
  score_parts: Record<string, any>;
  state: 'candidate' | 'published' | 'hidden'; pinned: boolean; note: string | null;
  image_count: string | number; hero_id: string | null; hero_lqip: string | null;
};

/**
 * One picture, and everything anybody could be asked to produce about it: where
 * it came from, whose it is, what the licence says, and the page that states
 * both. `source_page_url` is the attribution URL.
 */
/**
 * The form we fill in about a place (migration 045). Every field is present —
 * empty string or empty list where the sources were silent — because a missing
 * field and an unanswerable one must not look the same on the review screen.
 */
export type AttractionFacts = {
  whyGo: string;
  history: string; historyQuote: string;
  highlights: { name: string; why: string; source: string; quote: string }[];
  dwell: 'under an hour' | 'an hour or two' | 'half a day' | 'a full day' | 'more than a day';
  dwellWhy: string;
  cover: 'indoors' | 'mostly indoors' | 'both' | 'mostly outdoors' | 'outdoors';
  /** All four bands, in order, with what there is for each. */
  forAges: { band: 'under 4' | '4 to 7' | '8 to 11' | '12 and over'; what: string;
             howMuch: 'most of it' | 'a good part of it' | 'some of it' | 'very little' | 'nothing' }[];
  alsoSuits: string[]; wouldBore: string;
  bestTime: string; seasonal: string;
  booking: 'not needed' | 'advised' | 'required' | 'the sources do not say';
  missing: string[];
  confidence: 'high' | 'medium' | 'low';
};

export type AttractionFactsRow = {
  attraction_id: string;
  facts: AttractionFacts;
  evidence: Record<string, { quote: string; source: string; of?: string; why?: string }>;
  missing: string[]; confidence: string | null;
  lessons_used: string[]; model: string | null; prompt_hash: string | null; cost_usd: number | null;
  review: 'pending' | 'approved' | 'corrected' | 'rejected';
  review_note: string | null; wrong_fields: string[];
  reviewed_by: string | null; reviewed_at: string | null; read_at: string;
};

/** A Wikidata type present in a region, and how many places carry it. */
export type LibraryType = { qid: string; label: string; category: string | null; places: number };

/** A correction, in his words, scoped to a kind of place so it travels. */
export type ExtractionLesson = {
  id: string;
  scope: 'all' | 'kind' | 'place';
  subject: string | null; subject_label: string | null;
  rule: string; field: string | null; said: string | null;
  from_attraction: string | null; from_name?: string | null;
  active: boolean; used_count: number; approved_after: number;
  created_by: string | null; created_at: string;
};

export type ReadingStats = {
  published: string | number; read: string | number; pending: string | number;
  approved: string | number; corrected: string | number; rejected: string | number;
  spent: string | number; lessons: { active: string | number; total: string | number };
};

/** One thing inside a place — a ride, an animal house, a tearoom. */
export type PlaceContent = {
  itemRef: string; name: string; kind: string | null; kindLabel: string | null;
  facts: Record<string, any>; summary: string | null; website: string | null;
};

/** An attraction with everything migration 041 fetched about it attached. */
export type LibraryAttractionDetail = LibraryAttraction & {
  kinds: string[];
  accolades: { key: string; label: string; source: string }[];
  acclaim: number; band: string | null; roam_score: number;
  sections: { heading: string | null; level: number; text: string; doing: boolean }[] | null;
  highlights: { name: string; kind: string; note: string | null; price: string | null; hours: string | null; sourceUrl: string }[] | null;
  admission: Record<string, any> | null;
  visit: Record<string, any> | null;
  contents_ref: string | null; contents_count: number;
  detail_attribution: { source: string; licence: string; url: string | null; note?: string }[] | null;
  provenance: Record<string, string> | null;
  detail_research_state: string | null; detail_error: string | null; researched_at: string | null;
  images: { id: string; title: string | null; lqip: string | null; credit_line: string | null; role: string }[];
};

export type LibraryImage = {
  id: string; source: string; source_ref: string | null; source_page_url: string | null;
  licence: string; licence_url: string | null; attribution_required: boolean;
  creator: string | null; creator_url: string | null; credit_line: string | null;
  title: string | null; caption: string | null; tags: string[];
  width: number | null; height: number | null; bytes: number | null;
  lqip: string | null; moderation: 'approved' | 'pending' | 'rejected'; moderation_note: string | null;
  reward_points: number; fetched_at: string; contributor_account_id: string | null;
  widths: number[] | null; held_bytes: string | number;
  /** What Roam files the place under: heritage, outdoors, family, museum, arts, animals, active, landmark. */
  categories: string | null;
  links: { type: string; id: string; role: string; label: string | null }[] | null;
  relevance?: number;
};

export type LibraryKind = {
  qid: string; label: string | null; root_qid: string | null; category: string | null;
  admit: boolean; overridden: boolean; overridden_by: string | null; seen_count: number;
};

// ---------------------------------------------------------------------------
// the shelves: what the home screen calls a place, and how it is taught
// ---------------------------------------------------------------------------

/**
 * A weight per shelf. A shelf that is absent is a shelf the place is not on at
 * all; a shelf below the floor is true but not worth a card.
 */
export type ShelfWeights = Partial<Record<MoodKey, number>>;

export type ShelfRule = {
  id: string;
  scope: 'place' | 'kind' | 'category' | 'experience';
  subject: string;
  subject_label: string | null;
  weights: ShelfWeights;
  reason: string | null;
  taught_by: string | null;
  seeded: boolean;
  created_at: string;
  updated_at: string;
};

/** Why a place is where it is: the rules that decided it, narrowest first. */
export type ShelfBecause = {
  scope: string;
  subject: string | null;
  subject_label: string | null;
  weights: ShelfWeights;
  reason: string | null;
};

export type ShelfPlace = {
  ref: string;
  id: string;
  name: string;
  region: string | null;
  category: string | null;
  summary: string | null;
  score: number | null;
  lat: number | null;
  lng: number | null;
  imageId: string | null;
  shelves: MoodKey[];
  weights: ShelfWeights;
  because: ShelfBecause[];
  kinds: { qid: string; label: string | null; category: string | null; rule: ShelfRule | null }[];
  rule: ShelfRule | null;
  distanceKm?: number;
};

export type ShelfVocabulary = {
  shelves: { key: MoodKey; label: string }[];
  floor: number;
  maxShelves: number;
  defaults: { category: Record<string, ShelfWeights>; experience: Record<string, ShelfWeights> };
  rules: ShelfRule[];
  counts: Record<string, number>;
};

export type ShelfProposal = {
  scope: ShelfRule['scope'];
  suggestedScope: ShelfRule['scope'];
  reason: string;
  weights: ShelfWeights;
};

export type LibraryContributor = {
  id: string; email: string; household: string | null;
  accepted: string; waiting: string; points: string;
};

export type HarvestRun = {
  id: string; scope: string; stage: string | null;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  counts: Record<string, number>; log?: { at: string; line: string }[];
  error: string | null; started_by: string | null; started_at: string; finished_at: string | null;
};

/** The postcode areas Roam has swept, and how well each went (migration 035). */
export type ScoutArea = {
  code: string;
  label: string | null;
  state: string;
  swept_at: string | null;
  next_sweep_at: string | null;
  seen: number;
  chains: number;
  kept: number;
  sweeps: number;
  places: number;
  researched: number;
  menus: number;
  menus_failed: number;
  dishes: number;
};

/** One place in an area's selection, as the household API answers it. */
export type ScoutPlace = {
  venueRef: string;
  name: string | null;
  rank: number;
  score: number | null;
  // Our own words for the crowd, never their figure: 'top' | 'high' | 'good' | 'mixed'.
  standing: string | null;
  howMany: string | null;
  accolades: string[];
  cuisines: string[];
  /** Kept and weighted, never dropped: 'independent' | 'small' | 'regional' | 'national'. */
  chain: boolean;
  chainScale: string;
  sites: number;
  address: string | null;
  postcode: string | null;
  openingHours: string | null;
  summary: string | null;
  website: string | null;
  menuUrl: string | null;
  lat: number | null;
  lng: number | null;
  menu: { items: number; readAt: string } | null;
  researched: boolean;
};

/** A menu Roam could not read, and the reason — the work list, not an empty tab. */
export type ScoutMenuMiss = {
  venue_ref: string;
  venue_label: string | null;
  state: string;
  why: string | null;
  menu_url: string | null;
  attempts: number;
  read_at: string | null;
  website: string | null;
};

export type LibraryOverview = {
  totals: Record<string, string | number>;
  bySource: { source: string; n: number; bytes: string }[];
  byLicence: { licence: string; attribution_required: boolean; n: number }[];
  coverage: LibraryRegion[];
  pendingUploads: number;
  runs: HarvestRun[];
  running: HarvestRun | null;
  widths: { hero: number[]; gallery: number[] };
};

export type RegionAttractions = {
  region: { slug: string; name: string; nation: string; kind: string; lat: number | null; lng: number | null };
  attractions: {
    id: string; name: string; slug: string; rank: number | null; category: string | null;
    summary: string | null; lat: number | null; lng: number | null;
    website: string | null; wikipediaUrl: string | null; osmRef: string | null;
    heritage: string | null; venueRef: string | null; attribution: any[];
    image: { id: string; lqip: string | null; credit: string | null; licence: string;
             licenceUrl: string | null; sourceUrl: string | null; creditRequired: boolean } | null;
  }[];
};

// --- the admin module -------------------------------------------------------

export type AccountPlan = { key: string; label: string; note: string };
export type AccountInvite = { at: string; expiresAt: string; usedAt: string | null; delivery: string | null; error: string | null };
export type Account = {
  id: string;
  householdId: string;
  householdName: string | null;
  email: string;
  name: string | null;
  role: 'owner' | 'customer';
  status: 'invited' | 'active' | 'suspended';
  plan: string;
  trialEndsOn: string | null;
  note: string | null;
  createdAt: string;
  invitedAt: string | null;
  activatedAt: string | null;
  lastSeenAt: string | null;
  signInCount: number;
  liveDevices: number;
  members: number;
  trips: number;
  usage: { callsMonth: number; costMonth: number; callsEver: number; costEver: number; bound: number; boundIsOwn: boolean };
  lastInvite?: AccountInvite | null;
};
export type Invitation = { url: string; expiresAt: string; delivery: string; message: string | null };
export type AccountsResponse = {
  accounts: Account[];
  plans: AccountPlan[];
  mail: { configured: boolean; reason?: string; message?: string; from?: string };
  defaults: { monthlyCallBound: number; guestMonthlyCallBound: number };
  ownerClaimed: boolean;
  foundingHousehold: { id: string; name: string } | null;
  totals: { costMonth: number; costEver: number; callsMonth: number };
};


// --- the back office --------------------------------------------------------

export type Access = { doors: string[]; capabilities: string[]; role: { key: string; label: string } | null };

export type EstateTotals = {
  households: number; accounts: number; active_accounts: number; invited: number; suspended: number;
  joined_this_month: number; people: number; places: number; trips: number; visits: number; ratings: number;
  live_devices: number; cost_month_usd: number; cost_ever_usd: number; calls_month: number;
};
export type DailyRow = { day: string; households: number; seconds: number; views: number; places: number; trips: number; visits: number };
export type ScreenRow = { screen: string; views: number; households?: number; seconds: number };
export type FeedRow = { kind: string; at: string; title: string; detail: string; household_id?: string; household_name?: string; account_email?: string | null };
/** A subscription plan (`plans` table). Not to be confused with `PlanRow`, which is a row on the Plan screen. */
export type SubscriptionPlan = { key: string; label: string; note: string | null; price_pence: number | null; call_bound: number | null; active: boolean; people?: number };
export type MoneyBlock = {
  mrrPence: number;
  byPlan: { key: string; label: string; price_pence: number | null; households: number; mrr_pence: number; unpriced: number }[];
  revenue: { month: string; households: number; revenue_pence: number; paying: number }[];
  cost: { month: string; calls: number; cost_usd: number }[];
  costMonthUsd: number;
  basis: string;
};
export type AdminOverview = {
  window: { days: number };
  totals: EstateTotals;
  active: { dau: number; wau: number; mau: number; seconds_30d: number; stickiness: number };
  daily: DailyRow[];
  screens: ScreenRow[];
  feed: FeedRow[];
  /** Roam is an installable web app, not a store listing: added, and opened from a home screen. */
  installs: { added_ever: number; added_window: number; households_standalone: number; opens_window: number };
  money: MoneyBlock | null;
  withheld: string[];
};
export type AdminPerson = {
  id: string; householdId: string; householdName: string | null; email: string; name: string | null;
  status: string; plan: string; role: { id: string; key?: string; label?: string } | null;
  createdAt: string; lastSeenAt: string | null; signInCount: number; liveDevices: number; members: number; trips: number;
  activity: { seconds: number; views: number; daysActive: number; lastActive: string | null };
  usage: { calls: number; costUsd: number; bound: number | null } | null;
};
export type AdminPeople = {
  window: { days: number };
  people: AdminPerson[];
  roles: { id: string; key: string; label: string; doors: string[]; isOwner: boolean }[];
  plans: { key: string; label: string; pricePence: number | null }[];
  withheld: string[];
};
export type PersonRecord = {
  account: { id: string; email: string; name: string | null; status: string; plan: string; trialEndsOn: string | null; note: string | null; createdAt: string; activatedAt: string | null; lastSeenAt: string | null; signInCount: number; monthlyCallBound: number | null; role: { id: string; key: string; label: string; doors: string[] } | null };
  household: { id: string; name: string; homeLabel: string | null; timezone: string | null; createdAt: string } | null;
  members: { id: string; name: string; relationship: string | null; isMinor: boolean; allergens: number; dislikes: number }[];
  devices: { id: string; label: string | null; since: string; lastSeen: string; until: string }[];
  signIns: { id: string; method: string; label: string | null; at: string }[];
  audit: AuditRow[];
  behaviour: {
    summary: Record<string, number | string | null>;
    feed: { kind: string; at: string; title: string; detail: string; subject: string | null; weight: number }[];
    screens: ScreenRow[];
    daily: { day: string; seconds: number; views: number }[];
  } | null;
  withheld: string[];
};
export type AuditRow = {
  id: number; actor_id: string | null; actor_label: string | null; action: string;
  subject_type: string | null; subject_id: string | null; subject_label: string | null;
  before: any; after: any; at: string;
};
export type Engagement = {
  window: { days: number };
  daily: DailyRow[];
  active: { dau: number; wau: number; mau: number; seconds_30d: number; stickiness: number };
  screens: ScreenRow[];
  retention: { cohorts: { cohort: string; size: number }[]; cells: { cohort: string; week_no: number; households: number }[] };
  leaders: { accountId: string; email: string | null; name: string | null; seconds: number; views: number; daysActive: number; lastActive: string | null }[];
};
export type RevenueReport = {
  basis: string; missing: string[]; mrrPence: number; arrPence: number; paying: number; free: number; arpuPence: number;
  byPlan: MoneyBlock['byPlan']; revenue: MoneyBlock['revenue']; cost: MoneyBlock['cost']; plans: SubscriptionPlan[]; totals: EstateTotals;
};
export type UsageReport = {
  window: { days: number };
  byProvider: { provider: string; calls: number; cost_usd: number | null; households: number }[];
  households: { accountId: string; email: string; name: string | null; calls: number; costUsd: number | null; bound: number | null; used: number }[];
  withheld: string[];
};
export type Role = {
  id: string; key: string; label: string; description: string | null; doors: string[];
  is_system: boolean; is_owner: boolean; capabilities: string[]; people?: number;
};
export type Capability = { key: string; area: string; label: string; note: string; manages?: boolean };

export type OfflineManifest = {
  generatedAt: string;
  paths: string[];
  /** The subset that costs nothing to fetch; the automatic fill uses only these. */
  free: string[];
  owned: { claimed: number; researched: number; inOpenMap: number; described: number; waiting: number; failed: number; lastChange: string | null };
};
