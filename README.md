# Roam

*Remember every place you love.* A household taste-memory app: it holds who is in the family and what they will and won't eat or do, then answers one question — given where we're going, how long we have, and who is coming, where should we go?

Documents: [requirements](docs/requirements.md) · [technical constraints](docs/technical-constraints.md) · [UX research](docs/ux-research.md).

## Layout

```
apps/api   Node + Postgres JSON API (Express). Binds 0.0.0.0 on $PORT.
apps/web   Expo app with react-native-web. Talks to the API at EXPO_PUBLIC_API_URL.
docs/      Requirements, technical constraints, UX research.
```

The API owns every third-party call (place sources, routing, Claude). No provider key reaches the web bundle.

## Run locally

```bash
cp .env.example .env               # PORT, DATABASE_URL, EXPO_PUBLIC_API_URL
npm install
npm run db:up                      # Postgres 17 in Docker on localhost:5434
npm run migrate && npm run seed    # schema + the founding household
npm run api                        # http://localhost:4000  (GET /health)
npm run web                        # http://localhost:8081  (Expo web)
```

The conversational planner needs an Anthropic key in the API's environment: `ANTHROPIC_API_KEY=sk-ant-…` (put it in `.env`; it is git-ignored). Without it, household, trips and the touch controls work; interpreting what you *say* does not.

Place data comes from two sources behind one interface (`apps/api/src/sources/`): **OpenStreetMap** (Overpass for places, Nominatim for geocoding — open data, no key, cacheable with attribution; no reviews, ratings or allergen data) and a local **fixture** set of invented Boston venues used for development. `ROAM_SOURCES` defaults to `fixtures,osm`; Google, Yelp and TripAdvisor slot in behind the same interface once credentials and spend caps exist. Taste vocabulary (dishes, cuisines, experiences, diets, with aliases and fuzzy matching) lives in `apps/api/src/domain/concepts.js`.

## API sketch

| Route | What |
|---|---|
| `GET /health` | liveness + DB |
| `GET/PATCH /api/household`, `…/members`, `…/constraints` | household, members, allergens / dislikes / likes |
| `POST /api/discover` | time-bounded discovery with constraints applied and attribution logged |
| `POST /api/plan/start` | a sentence → intent → one candidate pool → several trip options |
| `POST /api/plan/refine` | "I like this, not that" in words, mapped onto the stops on screen |
| `POST /api/plan/act` | the same changes by touch (no model call) |
| `POST /api/plan/commit` | make an option the active trip |
| `GET/POST /api/trips…` | trips, stops, recalculated time budget |

## Deploying as two services

Each app is its own Railway service in project `roam`, both connected to this repo's `main` branch at the **repo root** (so the root lockfile and workspaces install deterministically). Per-service commands are set with Railpack's documented override variables rather than a root directory, because the CLI cannot set a root directory:

| Service | Variables that define it (non-secret) | Listens on |
|---|---|---|
| `api` | `RAILPACK_START_CMD = npm run migrate -w @roam/api && npm start -w @roam/api` | `0.0.0.0:$PORT` |
| `web` | `RAILPACK_BUILD_CMD = npm run build -w @roam/web` · `RAILPACK_START_CMD = npm start -w @roam/web` · `EXPO_PUBLIC_API_URL = <public URL of api>` | `0.0.0.0:$PORT` |

Postgres is a Railway Postgres service in the same project; the `api` needs its `DATABASE_URL`.

### Where variables live

**Secrets come from Doppler at runtime** — never in the repo and never set directly as Railway variables (see `CLAUDE.md`). If the Doppler → Railway sync is configured to manage *all* variables on a service, the non-secret entries above must be mirrored in Doppler too, or the sync will remove them.

**api**

| Variable | Required | Notes |
|---|---|---|
| `PORT` | set by the platform | |
| `DATABASE_URL` | yes | Postgres connection string (Doppler) |
| `ANTHROPIC_API_KEY` | yes | conversational planner (Doppler) |
| `ANTHROPIC_WORKSPACE_ID` | if the key is identity-linked | The Anthropic workspace the key acts in (`wrkspc_…`). Console-issued keys that are linked to a person require it; a legacy workspace key does not. |
| `RAILPACK_START_CMD` | yes | see table above (non-secret) |
| `GOOGLE_MAPS_API_KEY` | recommended | Google Places API (New) + Routes API: ratings, reviews, photos, hours, family flags, dish-search evidence, **real travel times**. Restrict the key to those APIs; set a budget and per-API quota in Cloud Console. Switches on automatically. |
| `TRIPADVISOR_API_KEY` | optional | Tripadvisor Terra Content API, Discover plan (`X-API-Key`): ratings, 3 reviews + 5 photos per place, strong for attractions outside the US. Billed per location ID returned, first 1,000 free once, then from $0.015; set a daily budget in the Terra dashboard. `ROAM_TRIPADVISOR_PAGE` (default 10, max 20) caps IDs per nearby call. Switches on automatically. |
| `TICKETMASTER_API_KEY` | optional | Ticketmaster Discovery v2: real timed events inside an outing window. Free. Switches on automatically. |
| `SEATGEEK_CLIENT_ID` | optional | SeatGeek Platform API: ticketed events (US-strongest, London partly). Free client id from https://seatgeek.com/account/develop. Switches on automatically. |
| `PREDICTHQ_API_KEY` | optional | PredictHQ Events API: ranked events worldwide incl. *community* events (fairs, markets, parades). 14-day trial then a Free plan; paid plans are the owner's call. Bearer key from https://control.predicthq.com. Switches on automatically. |
| `DATATHISTLE_API_KEY` | optional | Data Thistle (The List): UK live-events data down to village fairs and library sessions. Paid (from £50/month) — owner's decision. Bearer key from https://www.datathistle.com. Switches on automatically. |
| `ROAM_LOCAL_SCOUT` | optional | `on` lets the **local scout** run: Claude searches and reads the council what's-on page, local paper and venue sites for the outing's place and date and returns confirmed events with source links. Uses the Anthropic key (web search ≈ $0.01 per search + tokens, ≤ 6 searches per call, results cached in memory 6 h per place+date). Off by default because it spends money. |
| `ROAM_SOURCES` | no | comma-separated enabled place sources; default `fixtures,osm,google,tripadvisor,ticketmaster,seatgeek,predicthq,datathistle,scout` (each licensed source is only live when its key exists) |
| `ROAM_OVERPASS_URLS` / `ROAM_NOMINATIM_URL` | no | override the OpenStreetMap endpoints (e.g. a self-hosted mirror) |
| `ROAM_LEARN_THRESHOLD` | no | rating events before a learned preference counts; default 3 |
| `ROAM_SESSION_CALL_BOUND` / `ROAM_HOUSEHOLD_MONTHLY_CALL_BOUND` | no | spend containment bounds; defaults 40 / 3000 |
| `ROAM_MERGE_THRESHOLD` | no | entity-resolution confidence; default 0.75 |

**web**

| Variable | Required | Notes |
|---|---|---|
| `PORT` | set by the platform | |
| `RAILPACK_BUILD_CMD`, `RAILPACK_START_CMD` | yes | see table above (non-secret) |
| `EXPO_PUBLIC_API_URL` | yes, **at build time** | Public URL of the `api` service. `EXPO_PUBLIC_*` values are inlined into the bundle by `expo export`; setting it only at runtime has no effect, and it must never hold a secret. |

Provider keys for place, routing, event and speech sources are added to `api` (via Doppler) as each source is enabled (Technical Constraints §11), never to `web`.
