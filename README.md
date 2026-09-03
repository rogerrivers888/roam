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

Place data is a local fixture set (`apps/api/src/sources/fixtures.js`) — invented venues, no licensed content — behind the same source interface a real provider uses. Enable sources with `ROAM_SOURCES=fixtures,…`.

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

Each app is its own service with its own environment. Nothing here creates or configures infrastructure; it only defines what a service needs.

| Service | Root | Build | Start | Listens on |
|---|---|---|---|---|
| `api` | `apps/api` | — | `npm start` (run `npm run migrate` before it on each deploy) | `0.0.0.0:$PORT` |
| `web` | `apps/web` | `npm run build` (`expo export --platform web`) | `npm start` (static files from `dist/`) | `0.0.0.0:$PORT` |

From the repo root the same commands are `npm run <script> -w @roam/api` / `-w @roam/web`.

### Variables

**api**

| Variable | Required | Notes |
|---|---|---|
| `PORT` | set by the platform | |
| `DATABASE_URL` | yes | Postgres connection string |
| `ANTHROPIC_API_KEY` | yes | conversational planner |
| `ROAM_SOURCES` | no | comma-separated enabled place sources; default `fixtures` |
| `ROAM_SESSION_CALL_BOUND` / `ROAM_HOUSEHOLD_MONTHLY_CALL_BOUND` | no | spend containment bounds; defaults 40 / 3000 |
| `ROAM_MERGE_THRESHOLD` | no | entity-resolution confidence; default 0.75 |

**web**

| Variable | Required | Notes |
|---|---|---|
| `PORT` | set by the platform | |
| `EXPO_PUBLIC_API_URL` | yes, **at build time** | Public URL of the `api` service. `EXPO_PUBLIC_*` values are inlined into the bundle by `expo export`; setting it only at runtime has no effect, and it must never hold a secret. |

Provider keys for place, routing, event and speech sources are added to `api` as each source is enabled (Technical Constraints §11), never to `web`.
