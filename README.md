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

Place data comes from two sources behind one interface (`apps/api/src/sources/`): **OpenStreetMap** (Overpass for places, Nominatim for geocoding, Photon for the "where are we going?" typeahead — all the same open data, no key, cacheable with attribution; no reviews, ratings or allergen data) and a local **fixture** set of invented Boston venues used for development. `ROAM_SOURCES` defaults to `fixtures,osm`; Google, Yelp and TripAdvisor slot in behind the same interface once credentials and spend caps exist. Taste vocabulary (dishes, cuisines, experiences, diets, with aliases and fuzzy matching) lives in `apps/api/src/domain/concepts.js`.

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

### The door

Every `/api` path needs a session, except six: `/health`, `/robots.txt`, `/api/session`
(signing in), `/api/session/link` and `/api/session/request-link` (magic links, which are how
a session is obtained and so cannot need one), and `/api/join/:token` (a group invite link,
where the unguessable link is itself the credential).

- **Two ways in.** The owner's passcode, `ROAM_PASSCODE`, set in Doppler and never in the
  repo; and a **magic link** for everybody else, issued from Accounts (see below).
- Which household a request is about is decided by the account behind its session, in
  `apps/api/src/context.js` — an async-local store that `currentHousehold()` reads. A session
  with no account is the passcode, which is the owner on the founding household, exactly as
  before accounts existed.
- The passcode is exchanged once for a token that lasts 90 days; only a hash of that token is
  stored (`api_sessions`). Settings › Account lists the devices signed in and can sign out one
  or all of them.
- A cookie is also set, and is accepted for exactly two GETs that cannot carry a header — a
  photograph in an `<img>`, and the shortlist search stream. **Writes never accept the
  cookie**, which is what keeps another site from being able to act as the family.
- Sign-in attempts are limited to 10 per 15 minutes per caller; provider-spending paths to
  120 per 5 minutes; everything else to 900 per 5 minutes (`apps/api/src/limits.js`).

**Deployed with no passcode set, the API serves nothing to anybody it does not already
know** — every `/api` request answers 503 `auth_not_configured`, and `/health` reports
`"auth": "not-configured"`. That is deliberate: the alternative is quietly serving the
household to the internet, which is what this replaced. An account holder with a live session
is somebody it knows and keeps working, so taking the shared passcode away does not lock
every other household out of its own Roam.

### Accounts

An account owns one household. Nothing is shared between them: a household's places, people,
trips and ratings are reachable only through a session belonging to its own account, and every
provider call is billed against it (`provider_calls`).

- **Accounts** (owner-only tab, and `/api/accounts`) lists everybody with Roam, how long they
  have been here, when they were last in, how many times they have signed in, and what their
  searching has cost this month and in total. The owner adds a person by e-mail; Roam makes
  them a household of their own and issues a single-use link that expires in a week.
- **Sending needs a key.** With `RESEND_API_KEY` and `ROAM_MAIL_FROM` set, Roam e-mails the
  link. Without them it still makes the link and shows it on the screen to be copied and sent
  by hand — nothing is silently dropped. Adding those keys is the owner's, in Doppler.
- **Every household draws on the same provider allowances**, because a Google or Tripadvisor
  free tier is per provider account, not per household. So each account carries its own
  monthly ceiling on provider calls (`accounts.monthly_call_bound`, editable per person on the
  Accounts screen). Somebody new starts at a quarter of `ROAM_HOUSEHOLD_MONTHLY_CALL_BOUND`.
  Roam declining to spend is not a spend cap: the cap at the provider is still the owner's to
  set in their console.
- **Suspending** an account signs its devices out and refuses new links; its data is untouched.
  **Removing** an account takes its way in; removing it *with* its household deletes everything
  that household saved, and says so before it does.
- The admin routes answer **404** to anybody who is not the owner, not 403: a customer has no
  business learning that they exist.

### Where variables live

**Secrets come from Doppler at runtime** — never in the repo and never set directly as Railway variables (see `CLAUDE.md`). If the Doppler → Railway sync is configured to manage *all* variables on a service, the non-secret entries above must be mirrored in Doppler too, or the sync will remove them.

**api**

| Variable | Required | Notes |
|---|---|---|
| `PORT` | set by the platform | |
| `DATABASE_URL` | yes | Postgres connection string (Doppler) |
| `ROAM_PASSCODE` | **yes, deployed** | The household's passcode (Doppler, owner-set). **Without it the deployed API answers 503 to every `/api` request and serves nothing** — see "The door" above. Locally, unset falls back to `roam-dev`. |
| `RESEND_API_KEY` | optional | Mail sender (Doppler, owner-set) used for account invitations and sign-in links. Unset, Roam still makes the link and the Accounts screen shows it to be sent by hand. |
| `ROAM_MAIL_FROM` | with the above | The address invitations come from, on a domain verified with the sender, e.g. `Roam <hello@example.com>`. Non-secret, but a sender is not configured until both this and the key are set. |
| `ROAM_WEB_URL` | recommended | Where the web app is served, e.g. `https://roam-web.up.railway.app`. Non-secret. Sign-in links are built against it; unset, they fall back to the request's own origin. |
| `ROAM_HOUSEHOLD_MONTHLY_CALL_BOUND` | optional | Provider calls a household may make in a calendar month before Roam stops searching for it (default 3000). Per-account ceilings on the Accounts screen override it; a new account starts at a quarter of it. |
| `ROAM_WEB_ORIGIN` | recommended | Comma-separated list of origins the web app is served from, e.g. `https://roam-web.up.railway.app`. Non-secret. Restricts which sites may open a session-carrying request; unset, any origin is answered and the passcode is the only guard. |
| `ANTHROPIC_API_KEY` | yes | conversational planner (Doppler) |
| `ANTHROPIC_WORKSPACE_ID` | if the key is identity-linked | The Anthropic workspace the key acts in (`wrkspc_…`). Console-issued keys that are linked to a person require it; a legacy workspace key does not. |
| `RAILPACK_START_CMD` | yes | see table above (non-secret) |
| `GOOGLE_MAPS_API_KEY` | recommended | Google Places API (New) + Routes API: ratings, reviews, photos, hours, family flags, dish-search evidence, **real travel times**. Restrict the key to those APIs; set a budget and per-API quota in Cloud Console. Switches on automatically. |
| `TRIPADVISOR_API_KEY` | optional | Tripadvisor Terra Content API, Discover plan (`X-API-Key`): ratings, 3 reviews + 5 photos per place, strong for attractions outside the US. Billed per location ID returned, first 1,000 free once, then from $0.015; set a daily budget in the Terra dashboard. `ROAM_TRIPADVISOR_PAGE` (default 10, max 20) caps IDs per nearby call. Live once the key exists, but **opt-in**: it only runs when a search's `sources` set names it (the Sources row on a search form, or a trip's saved sources). With other sources it looks venues up by name and adds ratings (`ROAM_TRIPADVISOR_ENRICH` lookups, default 8); on its own it takes one bounding-box page, which is a testing view. |
| `TICKETMASTER_API_KEY` | optional | Ticketmaster Discovery v2: real timed events inside an outing window. Free. Switches on automatically. |
| `SEATGEEK_CLIENT_ID` | optional | SeatGeek Platform API: ticketed events (US-strongest, London partly). Free client id from https://seatgeek.com/account/develop. Switches on automatically. |
| `PREDICTHQ_API_KEY` | optional | PredictHQ Events API: ranked events worldwide incl. *community* events (fairs, markets, parades). 14-day trial then a Free plan; paid plans are the owner's call. Bearer key from https://control.predicthq.com. Switches on automatically. |
| `DATATHISTLE_API_KEY` | optional | Data Thistle (The List): UK live-events data down to village fairs and library sessions. Free tier: 1,000 requests a month per account (one request per events search); paid plans above that. Bearer token from https://api.datathistle.com/account — tokens expire after 30 days and must be refreshed. Switches on automatically. |
| `ROAM_LOCAL_SCOUT` | optional | `on` lets the **local scout** run: Claude searches and reads the council what's-on page, local paper and venue sites for the outing's place and date and returns confirmed events with source links. Uses the Anthropic key (web search ≈ $0.01 per search + tokens, ≤ 6 searches per call, results cached in memory 6 h per place+date). Off by default because it spends money. |
| `ROAM_SCOUT_MONTHLY_RUNS` | no | the scout's own cap: runs per household per month (default 60 ≈ $40). Past it the scout pauses and plans carry on without it; the Anthropic workspace spend limit stays the hard stop. |
| `sources` (request) | — | every search endpoint takes `sources=osm,google,…`: the exact set for that search; omitted = every live source except opt-in ones. Trips can save a set (`PATCH /api/trips/:id { sources }`) that their shortlist searches and plans use. |
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
