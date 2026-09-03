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
export type Constraint = { id: string; kind: ConstraintKind; value: string; conceptKey: string | null; conceptKind: string | null };

export type Member = {
  id: string;
  name: string;
  isMinor: boolean;
  age: number | null;
  birthYear: number | null;
  relationship: string | null;
  avatarUrl: string | null;
  typicalVisitMinutes: number | null;
  maxTravelMinutes: number | null;
  allergens: Constraint[];
  diets: Constraint[];
  dislikes: Constraint[];
  likes: Constraint[];
};

export type Place = { label: string; lat: number; lng: number; country?: string | null; countryCode?: string | null; locality?: string | null; displayName?: string };

export type Household = {
  id: string;
  name: string;
  defaultVisitMinutes: number;
  maxTravelMinutes: number;
  defaultIntensity: 'relaxed' | 'balanced' | 'packed';
  home: Place | null;
};

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

export type Venue = {
  venueRef: string; source: string; sourcePlaceId: string; name: string; category: string;
  cuisines: string[]; experiences: string[]; allergens: string[]; dietaryOptions?: string[];
  priceLevel: number | null; rating: number | null; goodForChildren: boolean | null; lat: number; lng: number;
  dishes: { concept: string; name: string; comment?: string; veg?: boolean }[];
  website?: string | null; openingHours?: string | null; address?: string | null; attribution?: string;
  distanceKm?: number;
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

export type OptionStop = {
  id: string; position: number; venueRef: string; name: string; category: string; lat: number; lng: number;
  dwellMinutes: number; waitMinutes?: number; travelFromPrevMinutes: number; arriveAt?: string; leaveAt?: string;
  reasons: Reason[]; justification: string | null; startsAt: string | null; endsAt: string | null; pinned: boolean; uniqueToThisOption?: boolean;
};

export type TripOption = {
  id: string; title: string; basis: string; stops: OptionStop[]; budget: Budget;
  counts: { activities: number; food: number }; shortfall: { activities: number; food: number };
};

export type Trip = {
  id: string; title: string | null; notes?: string | null;
  origin: Place; destination: Place | null;
  departAt: string; returnAt: string;
  travelMode: 'walking' | 'cycling' | 'driving' | 'transit'; intensity: 'relaxed' | 'balanced' | 'packed';
  country?: string | null; countryCode?: string | null; locality?: string | null;
};

export type TripSummary = Trip & { stopCount: number; visitCount: number; ratingCount: number; attendees: string[]; isPast: boolean };

export type TripStop = { id: string; position: number; venueRef: string; name: string; lat: number | null; lng: number | null; dwellMinutes: number; visit: Visit | null };

export type TripDetail = { trip: Trip; attendees: { id: string; name: string; isMinor: boolean; avatarUrl?: string | null }[]; stops: TripStop[]; budget: Budget };

export type SuggestedPreference = { member: string | null; kind: 'like' | 'dislike'; value: string };

export type Spend = { session_calls: number; session_cost_usd: number; month_calls: number; month_cost_usd: number; sessionBound: number; householdMonthlyBound: number };

export type PlanResponse = {
  sessionId: string; reply: string | null; intent?: Record<string, any>; missing?: string[]; trip?: Trip;
  options: TripOption[];
  selection?: { pinned: string[]; excluded: string[]; chosenOptionId: string | null };
  constraints?: { minActivities: number; minFood: number };
  pool?: { size: number; targetFill: number; excludedByAllergen: { name: string; reasons: string[] }[] };
  suggestedPreferences?: SuggestedPreference[]; spend?: Spend;
  attending?: { id: string; name: string }[]; reach?: { maxTravelMinutes: number; estimated: boolean };
  applied?: any; ambiguous?: string | null; transcript?: { role: 'user' | 'assistant'; text: string }[];
};

export type PlanAction =
  | { type: 'like' | 'unlike' | 'dislike' | 'restore'; stopId: string }
  | { type: 'choose'; optionId: string | null }
  | { type: 'set'; minActivities?: number; minFood?: number; intensity?: Trip['intensity']; durationMinutes?: number };

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const api = {
  health: () => request<{ ok: boolean; db: string }>('/health'),

  // household
  household: () => request<HouseholdResponse>('/api/household'),
  updateHousehold: (body: Partial<Pick<Household, 'name' | 'defaultVisitMinutes' | 'maxTravelMinutes' | 'defaultIntensity'>> & { home?: Place; homeText?: string }) =>
    patch<{ household: Household }>('/api/household', body),
  addMember: (body: { name: string; relationship?: string | null; birthYear?: number | null; avatarUrl?: string | null }) => post<{ member: any }>('/api/household/members', body),
  updateMember: (id: string, body: { name?: string; relationship?: string | null; birthYear?: number | null; avatarUrl?: string | null; typicalVisitMinutes?: number; maxTravelMinutes?: number }) =>
    patch<{ member: any }>(`/api/household/members/${id}`, body),
  deleteMember: (id: string) => del<void>(`/api/household/members/${id}`),
  addConstraint: (memberId: string, body: { kind: ConstraintKind; value: string; conceptKey?: string }) =>
    post<{ constraint: Constraint; resolved: { key: string; label: string; kind: string } | null; suggestions: Suggestion[] }>(`/api/household/members/${memberId}/constraints`, body),
  deleteConstraint: (id: string) => del<void>(`/api/household/constraints/${id}`),
  learned: () => request<{ learned: Learned[]; threshold: number }>('/api/household/learned'),
  exportUrl: () => `${API_URL}/api/household/export`,
  deleteHousehold: (confirmName: string) => del<{ deleted: boolean }>('/api/household', { confirmName }),

  // vocabulary
  suggest: (q: string, kinds?: string[], limit = 8) =>
    request<{ suggestions: Suggestion[] }>(`/api/concepts/suggest${qs({ q, kinds: kinds?.join(','), limit })}`),

  // places & visits
  geocode: (q: string, limit = 6) => request<{ results: Place[]; attribution: string }>(`/api/places/geocode${qs({ q, limit })}`),
  searchPlaces: (p: { q?: string; near?: string; categories?: string; radiusKm?: number }) =>
    request<{ near: Place & { how: string }; radiusKm: number; results: Venue[]; sourcesQueried: string[]; degradedSources: { source: string; error: string }[]; attribution: string[] }>(`/api/places/search${qs(p)}`),
  place: (venueRef: string) =>
    request<{ venueRef: string; venue: Venue | null; household: Venue['household']; visits: Visit[] }>(`/api/places/detail${qs({ ref: venueRef })}`),
  savePlace: (venueRef: string, status: 'saved' | 'dismissed' = 'saved') =>
    post<{ venueRef: string; status: string }>('/api/places/save', { ref: venueRef, status }),
  createVisit: (body: Partial<Visit> & { venueRef: string; venueLabel: string; attendeeIds?: string[]; takes?: VisitTake[]; clientId?: string; venue?: Partial<Venue> }) =>
    post<{ visit: Visit; deduplicated?: boolean }>('/api/visits', body),
  visits: (p: { country?: string; q?: string; memberId?: string; take?: Take } = {}) =>
    request<{ visits: Visit[]; countries: { code: string; name: string; visits: number }[] }>(`/api/visits${qs(p)}`),
  visit: (id: string) => request<{ visit: Visit }>(`/api/visits/${id}`),
  updateVisit: (id: string, body: { note?: string; visitedOn?: string; venueLabel?: string }) => patch<{ visit: Visit }>(`/api/visits/${id}`, body),
  setTakes: (id: string, takes: VisitTake[], venue?: Partial<Venue>) => put<{ visit: Visit }>(`/api/visits/${id}/takes`, { takes, venue }),
  deleteVisit: (id: string) => del<void>(`/api/visits/${id}`),

  // trips
  trips: (p: { country?: string; when?: 'upcoming' | 'past'; q?: string } = {}) =>
    request<{ trips: TripSummary[]; countries: { code: string; name: string; trips: number }[] }>(`/api/trips${qs(p)}`),
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
  planStart: (utterance: string, sessionId?: string | null) => post<PlanResponse>('/api/plan/start', { utterance, sessionId: sessionId ?? undefined }),
  planRefine: (sessionId: string, utterance: string, viewingOptionId?: string | null) => post<PlanResponse>('/api/plan/refine', { sessionId, utterance, viewingOptionId }),
  planAct: (sessionId: string, action: PlanAction) => post<PlanResponse>('/api/plan/act', { sessionId, action }),
  planCommit: (sessionId: string, optionId: string) => post<{ tripId: string; optionId: string; stops: number }>('/api/plan/commit', { sessionId, optionId }),
  planGet: (sessionId: string) => request<PlanResponse>(`/api/plan/${sessionId}`),
};
