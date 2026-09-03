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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Constraint = { id: string; kind: 'allergen' | 'dislike' | 'like'; value: string };

export type Member = {
  id: string;
  name: string;
  isMinor: boolean;
  typicalVisitMinutes: number | null;
  maxTravelMinutes: number | null;
  allergens: Constraint[];
  dislikes: Constraint[];
  likes: Constraint[];
};

export type Household = {
  id: string;
  name: string;
  defaultVisitMinutes: number;
  maxTravelMinutes: number;
  defaultIntensity: 'relaxed' | 'balanced' | 'packed';
};

export type HouseholdResponse = { household: Household; members: Member[] };

export type Reason = { kind: 'like' | 'dislike' | 'want'; member?: string; value?: string; text: string };

export type Budget = {
  totalMinutes: number;
  travelMinutes: number;
  dwellMinutes: number;
  allocatedMinutes: number;
  remainingMinutes: number;
  targetFill: number;
  targetMinutes: number;
  fillRatio: number;
  legs: { from: string; to: string; minutes: number }[];
  overrun: boolean;
  overrunStop: { id: string; name: string; position: number } | null;
  exceedsMaxTravel: boolean;
  maxTravelMinutes: number | null;
  estimated: boolean;
};

export type OptionStop = {
  id: string;
  position: number;
  venueRef: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  dwellMinutes: number;
  travelFromPrevMinutes: number;
  reasons: Reason[];
  justification: string | null;
  startsAt: string | null;
  endsAt: string | null;
  pinned: boolean;
  uniqueToThisOption?: boolean;
};

export type TripOption = {
  id: string;
  title: string;
  basis: string;
  stops: OptionStop[];
  budget: Budget;
  counts: { activities: number; food: number };
  shortfall: { activities: number; food: number };
};

export type Trip = {
  id: string;
  title: string | null;
  origin: { label: string; lat: number; lng: number };
  destination: { label: string; lat: number; lng: number } | null;
  departAt: string;
  returnAt: string;
  travelMode: 'walking' | 'cycling' | 'driving' | 'transit';
  intensity: 'relaxed' | 'balanced' | 'packed';
};

export type SuggestedPreference = { member: string | null; kind: 'like' | 'dislike'; value: string };

export type Spend = {
  session_calls: number;
  session_cost_usd: number;
  month_calls: number;
  month_cost_usd: number;
  sessionBound: number;
  householdMonthlyBound: number;
};

export type PlanResponse = {
  sessionId: string;
  reply: string | null;
  intent?: Record<string, any>;
  missing?: string[];
  trip?: Trip;
  options: TripOption[];
  selection?: { pinned: string[]; excluded: string[]; chosenOptionId: string | null };
  constraints?: { minActivities: number; minFood: number };
  pool?: { size: number; targetFill: number; excludedByAllergen: { name: string; reasons: string[] }[] };
  suggestedPreferences?: SuggestedPreference[];
  spend?: Spend;
  attending?: { id: string; name: string }[];
  reach?: { maxTravelMinutes: number; estimated: boolean };
  applied?: any;
  ambiguous?: string | null;
  transcript?: { role: 'user' | 'assistant'; text: string }[];
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

  household: () => request<HouseholdResponse>('/api/household'),
  updateHousehold: (body: Partial<Pick<Household, 'defaultVisitMinutes' | 'maxTravelMinutes' | 'defaultIntensity'>>) =>
    patch<{ household: any }>('/api/household', body),
  addMember: (body: { name: string; isMinor?: boolean }) => post<{ member: any }>('/api/household/members', body),
  deleteMember: (id: string) => request<void>(`/api/household/members/${id}`, { method: 'DELETE' }),
  addConstraint: (memberId: string, body: { kind: Constraint['kind']; value: string }) =>
    post<{ constraint: Constraint }>(`/api/household/members/${memberId}/constraints`, body),
  deleteConstraint: (id: string) => request<void>(`/api/household/constraints/${id}`, { method: 'DELETE' }),

  planStart: (utterance: string, sessionId?: string | null) =>
    post<PlanResponse>('/api/plan/start', { utterance, sessionId: sessionId ?? undefined }),
  planRefine: (sessionId: string, utterance: string, viewingOptionId?: string | null) =>
    post<PlanResponse>('/api/plan/refine', { sessionId, utterance, viewingOptionId }),
  planAct: (sessionId: string, action: PlanAction) => post<PlanResponse>('/api/plan/act', { sessionId, action }),
  planCommit: (sessionId: string, optionId: string) =>
    post<{ tripId: string; optionId: string; stops: number }>('/api/plan/commit', { sessionId, optionId }),
  planGet: (sessionId: string) => request<PlanResponse>(`/api/plan/${sessionId}`),

  trips: () => request<{ trips: any[] }>('/api/trips'),
  trip: (id: string) => request<{ trip: Trip; attendees: any[]; stops: any[]; budget: Budget }>(`/api/trips/${id}`),
};
