// The web app talks to the Roam API over HTTP and nothing else. No provider
// key ever reaches this bundle (Technical Constraints §13.7).

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

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

export type Place = { label: string; lat: number; lng: number; country?: string | null; countryCode?: string | null; locality?: string | null; displayName?: string; formatted?: string; address?: { line1: string | null; area: string | null; town: string | null; region: string | null; postcode: string | null; country: string | null }; matchedBy?: string; approximate?: boolean };

export type Household = {
  id: string;
  name: string;
  defaultVisitMinutes: number;
  maxTravelMinutes: number;
  defaultIntensity: 'relaxed' | 'balanced' | 'packed';
  home: Place | null;
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
  venueRef: string; source: string; sourcePlaceId: string; name: string; category: string; contributingSources?: string[];
  cuisines: string[]; experiences: string[]; allergens: string[]; dietaryOptions?: string[];
  priceLevel: number | null; rating: number | null; ratingCount?: number | null; goodForChildren: boolean | null; menuForChildren?: boolean | null; lat: number; lng: number;
  dishes: { concept: string; name: string; comment?: string; veg?: boolean }[];
  website?: string | null; openingHours?: string | null; address?: string | null; attribution?: string;
  summary?: string | null; mapsUrl?: string | null; externalUrl?: string | null; reviews?: Review[]; chain?: boolean; brand?: string | null;
  distanceKm?: number;
  photos?: VenuePhotoRef[];
  household?: { visits?: number; lastOn?: string; loved?: number; notForMe?: number; ledger?: string } | null;
};

export type Take = 'loved' | 'fine' | 'not_for_me';
export type VisitTake = { id?: string; memberId: string; member?: string; subject: string; take: Take; comment: string | null; conceptKey?: string | null; concept?: string | null };
export type Visit = {
  id: string; venueRef: string; venueLabel: string; category: string | null; lat: number | null; lng: number | null;
  visitedOn: string; note: string | null; country: string | null; countryCode: string | null; locality: string | null;
  tripId: string | null; stopId?: string | null;
  attendees: { id: string; name: string }[] | string[];
  takes?: VisitTake[];
  visitTakes?: { member: string; memberId: string; take: Take; comment: string | null }[];
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

export type BrowseItem = Omit<OptionStop, 'position' | 'travelFromPrevMinutes' | 'pinned'> & { pinned: boolean; ticketed?: boolean; venueName?: string | null; externalUrl?: string | null; shortlisted?: boolean; score?: number | null; contributingSources?: string[] };

export type TripOption = {
  id: string; title: string; basis: string; stops: OptionStop[]; budget: Budget;
  counts: { activities: number; food: number }; shortfall: { activities: number; food: number };
};

export type TripKind = 'outing' | 'trip';
export type DayStop = { id: string; position: number; venueRef: string; name: string; lat: number | null; lng: number | null; dwellMinutes: number; startTime: string | null; visit: Visit | null };
export type TripDay = { id: string; date: string; intensity: 'relaxed' | 'balanced' | 'packed'; travelMode: 'walking' | 'cycling' | 'driving' | 'transit'; startTime: string; endTime: string; notes: string | null; slots: { slot: 'morning' | 'afternoon' | 'evening'; stops: DayStop[] }[]; budget: Budget };
export type ShortlistItem = { id: string; venueRef: string; name: string; kind: 'food' | 'activity' | 'other'; category: string | null; lat: number | null; lng: number | null; venue: Partial<Venue> | null; note: string | null; mustDo: boolean; preferredDayId: string | null; scheduled: boolean };
export type AtlasCity = { name: string; places: number; been: number; special: number; trips: number; lastSeen: string | null; lat: number | null; lng: number | null; created: boolean };
export type AtlasCountry = { code: string; name: string; places: number; been: number; cities: AtlasCity[] };
export type AtlasPlace = { venueRef: string; name: string; unnamed?: boolean; kind: 'food' | 'activity' | 'other' | null; category: string | null; lat: number | null; lng: number | null; country: string | null; countryCode: string | null; locality: string | null; venue: Partial<Venue> | null; note: string | null; visits: number; lastOn: string | null; takes: { member: string; take: Take; comment: string | null; on: string }[]; ledger: string | null; onTrips: string[]; status: 'been' | 'saved' | 'special'; special: boolean; loved: number; notForMe: number };

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

export type TripSummary = Trip & { dayCount: number; stopCount: number; shortlistCount: number; visitCount: number; ratingCount: number; attendees: string[]; isPast: boolean };

export type TripStop = { id: string; position: number; venueRef: string; name: string; lat: number | null; lng: number | null; dwellMinutes: number; visit: Visit | null };

export type TripDetail = { trip: Trip; attendees: { id: string; name: string; isMinor: boolean; avatarUrl?: string | null }[]; days: TripDay[]; shortlist: ShortlistItem[]; stops: TripStop[]; budget: Budget };

export type SuggestedPreference = { member: string | null; kind: 'like' | 'dislike'; value: string };

export type Spend = { session_calls: number; session_cost_usd: number; month_calls: number; month_cost_usd: number; sessionBound: number; householdMonthlyBound: number; trip_calls?: number; trip_cost_usd?: number };

export type PlanResponse = {
  sessionId: string; dayId?: string | null; date?: string | null; reply: string | null;
  journey?: { from: string; to: string; minutes: number; mode: string } | null;
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
  // An overnight stay was set up as a dated trip: open it in Trips.
  handoff?: { tripId: string; title: string } | null;
};

export type PlanQuestion = { kind: 'place' | 'stay' | 'attending' | 'open'; field?: string | null; text: string; choices: { label: string; say: string }[] };

export type PlanAction =
  | { type: 'like' | 'unlike' | 'dislike' | 'restore'; stopId: string }
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

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const api = {
  health: () => request<{ ok: boolean; db: string }>('/health'),
  sources: () => request<SourcesStatus>('/api/sources'),
  setSourceOn: (key: string, on: boolean) => patch<{ key: string; on: boolean; off: string[] }>(`/api/sources/${key}`, { on }),

  // household
  household: () => request<HouseholdResponse>('/api/household'),
  updateHousehold: (body: Partial<Pick<Household, 'name' | 'defaultVisitMinutes' | 'maxTravelMinutes' | 'defaultIntensity'>> & { home?: Place; homeText?: string; pace?: { food?: Partial<PaceKind>; activity?: Partial<PaceKind> }; timezone?: string }) =>
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
  spend: (p: { period: SpendPeriod; from?: string; to?: string }) => request<SpendResponse>(`/api/household/spend${qs(p)}`),
  deleteHousehold: (confirmName: string) => del<{ deleted: boolean }>('/api/household', { confirmName }),

  // vocabulary
  browse: () => request<{ food: { title: string; hint: string; items: { key: string; label: string; children: { key: string; label: string }[] }[] }[]; activities: { title: string; hint: string; items: { key: string; label: string; children: { key: string; label: string }[] }[] }[]; diets: { key: string; label: string }[] }>('/api/concepts/browse'),
  suggest: (q: string, kinds?: string[], limit = 8) =>
    request<{ suggestions: Suggestion[] }>(`/api/concepts/suggest${qs({ q, kinds: kinds?.join(','), limit })}`),

  // places & visits
  /** `bias.near` keeps matches inside that area first (a trip's city); `bias.country` never leaves that country. */
  geocode: (q: string, limit = 6, bias?: { near?: Place | null; country?: string | null; kind?: 'lodging' | null }) =>
    request<{ results: Place[]; attribution: string }>(`/api/places/geocode${qs({ q, limit, near: bias?.near ? `${bias.near.lat},${bias.near.lng}` : undefined, country: bias?.country ?? undefined, kind: bias?.kind ?? undefined })}`),
  /** `sources` is the exact set of sources for this one search (e.g. 'osm,tripadvisor'); omitted = the default set, which never includes opt-in sources. */
  searchPlaces: (p: { q?: string; near?: string; categories?: string; radiusKm?: number; sources?: string }) =>
    request<{ near: Place & { how: string }; radiusKm: number; results: Venue[]; sourcesQueried: string[]; degradedSources: { source: string; error: string }[]; attribution: string[] }>(`/api/places/search${qs(p)}`),
  place: (venueRef: string) =>
    request<{ venueRef: string; venue: Venue | null; household: Venue['household']; visits: Visit[]; sourceError?: string | null }>(`/api/places/detail${qs({ ref: venueRef })}`),
  savePlace: (venueRef: string, status: 'saved' | 'dismissed' | 'special' = 'saved', context?: { label?: string; venue?: Partial<Venue>; category?: string | null; lat?: number; lng?: number; note?: string; country?: string | null; countryCode?: string | null; locality?: string | null }) =>
    post<{ venueRef: string; status: string }>('/api/places/save', { ref: venueRef, status, ...(context ?? {}) }),
  /** A place the atlas held only by its identifier learns its name once the source has been asked. */
  nameAtlasPlace: (venueRef: string, label: string) => patch<{ venueRef: string; label: string }>('/api/atlas/places', { venueRef, label }),
  createAtlasCity: (body: { placeText?: string; place?: Place }) => post<{ city: { name: string; country: string; countryCode: string; lat: number; lng: number } }>('/api/atlas/cities', body),
  deleteAtlasCity: (countryCode: string, locality: string) => del<void>('/api/atlas/cities', { countryCode, locality }),
  createVisit: (body: Partial<Visit> & { venueRef: string; venueLabel: string; attendeeIds?: string[]; takes?: VisitTake[]; clientId?: string; venue?: Partial<Venue> }) =>
    post<{ visit: Visit; deduplicated?: boolean }>('/api/visits', body),
  visits: (p: { country?: string; q?: string; memberId?: string; take?: Take } = {}) =>
    request<{ visits: Visit[]; countries: { code: string; name: string; visits: number }[] }>(`/api/visits${qs(p)}`),
  visit: (id: string) => request<{ visit: Visit }>(`/api/visits/${id}`),
  updateVisit: (id: string, body: { note?: string; visitedOn?: string; venueLabel?: string }) => patch<{ visit: Visit }>(`/api/visits/${id}`, body),
  setTakes: (id: string, takes: VisitTake[], venue?: Partial<Venue>) => put<{ visit: Visit }>(`/api/visits/${id}/takes`, { takes, venue }),
  deleteVisit: (id: string) => del<void>(`/api/visits/${id}`),

  // trips
  trips: (p: { country?: string; when?: 'upcoming' | 'past'; q?: string; kind?: TripKind } = {}) =>
    request<{ trips: TripSummary[]; countries: { code: string; name: string; trips: number }[] }>(`/api/trips${qs(p)}`),
  // atlas
  atlas: () => request<{ countries: AtlasCountry[]; unplaced: number }>('/api/atlas'),
  atlasPlaces: (p: { country?: string; city?: string; kind?: string; status?: string; q?: string } = {}) => request<{ places: AtlasPlace[] }>(`/api/atlas/places${qs(p)}`),
  // trips v2
  createMultiDayTrip: (body: { title?: string; notes?: string; place?: Place; placeText?: string; startDate: string; endDate: string; base?: Place; baseText?: string; baseKind?: string; checkIn?: string; checkOut?: string; hasCar?: boolean; travelMode?: Trip['travelMode']; intensity?: Trip['intensity']; dayStart?: string; dayEnd?: string; attendingMemberIds?: string[]; seedFromAtlas?: boolean }) =>
    post<TripDetail>('/api/trips', { kind: 'trip', ...body }),
  updateTripV2: (id: string, body: Partial<{ title: string; notes: string; startDate: string; endDate: string; hasCar: boolean; travelMode: Trip['travelMode']; intensity: Trip['intensity']; dayStart: string; dayEnd: string; base: Place; baseText: string; baseKind: string; checkIn: string; checkOut: string; sources: string[] | null }>) => patch<TripDetail>(`/api/trips/${id}`, body),
  updateDay: (tripId: string, dayId: string, body: Partial<{ intensity: Trip['intensity']; travelMode: Trip['travelMode']; startTime: string; endTime: string; notes: string }>) => patch<TripDetail>(`/api/trips/${tripId}/days/${dayId}`, body),
  shortlistSearch: (tripId: string, p: { q?: string; categories?: string; radiusKm?: number; near?: string; sources?: string }) =>
    request<{ near: Place; radiusKm: number; results: (Venue & { onShortlist: boolean })[]; degradedSources: { source: string; error: string }[] }>(`/api/trips/${tripId}/shortlist/search${qs(p)}`),
  addToShortlist: (tripId: string, body: { venueRef: string; venueLabel: string; kind?: string; category?: string | null; lat?: number | null; lng?: number | null; venue?: Partial<Venue>; note?: string; mustDo?: boolean; preferredDayId?: string | null }) => post<TripDetail>(`/api/trips/${tripId}/shortlist`, body),
  updateShortlist: (tripId: string, itemId: string, body: { note?: string; mustDo?: boolean; preferredDayId?: string | null; kind?: string }) => patch<TripDetail>(`/api/trips/${tripId}/shortlist/${itemId}`, body),
  removeFromShortlist: (tripId: string, itemId: string) => del<TripDetail>(`/api/trips/${tripId}/shortlist/${itemId}`),
  addDayStop: (tripId: string, dayId: string, body: { venueRef?: string; name?: string; lat?: number | null; lng?: number | null; category?: string | null; dwellMinutes?: number; slot?: 'morning' | 'afternoon' | 'evening'; startTime?: string; shortlistId?: string }) => post<TripDetail>(`/api/trips/${tripId}/days/${dayId}/stops`, body),
  updateStop: (tripId: string, stopId: string, body: { dayId?: string; slot?: 'morning' | 'afternoon' | 'evening'; startTime?: string; dwellMinutes?: number; position?: number }) => patch<TripDetail>(`/api/trips/${tripId}/stops/${stopId}`, body),
  planDay: (tripId: string, dayId: string, body: { minActivities?: number; minFood?: number } = {}) => post<PlanResponse>('/api/plan/day', { tripId, dayId, ...body }),
  trip: (id: string) => request<TripDetail>(`/api/trips/${id}`),
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
  planStart: (utterance: string, sessionId?: string | null, sources?: string[] | null, attendingMemberIds?: string[] | null) => post<PlanResponse>('/api/plan/start', { utterance, sessionId: sessionId ?? undefined, sources: sources ?? undefined, attendingMemberIds: attendingMemberIds ?? undefined }),
  tripSources: (id: string, p: { dayId?: string; sources?: string; scout?: '1' }) => request<SourceTrace>(`/api/plan/trips/${id}/sources${qs(p)}`),
  tripSpend: (id: string) => request<{ calls: number; costUsd: number; byProvider: { provider: string; calls: number; cost_usd: number }[] }>(`/api/trips/${id}/spend`),
  planRefine: (sessionId: string, utterance: string, viewingOptionId?: string | null) => post<PlanResponse>('/api/plan/refine', { sessionId, utterance, viewingOptionId }),
  planAct: (sessionId: string, action: PlanAction) => post<PlanResponse>('/api/plan/act', { sessionId, action }),
  planCommit: (sessionId: string, optionId: string) => post<{ tripId: string; optionId: string; stops: number }>('/api/plan/commit', { sessionId, optionId }),
  planGet: (sessionId: string) => request<PlanResponse>(`/api/plan/${sessionId}`),
  planLatestForDay: (tripId: string, dayId: string) => request<PlanResponse & { sessionId: string | null }>(`/api/plan/day/latest${qs({ tripId, dayId })}`),
};
