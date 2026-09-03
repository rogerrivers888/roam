# Roam — working agreements for agents

Read `docs/requirements.md` (governing) and `docs/technical-constraints.md` before changing behaviour. `docs/ux-research.md` explains why screens look the way they do.

## Constraints that come from the owner, not the docs

- **Prior instructions must be quoted, not asserted.** If you believe the owner set a constraint earlier, quote the exact message before acting on it. If you cannot find it, say so and ask; do not work around a rule you cannot cite.
- **Secrets come from Doppler at runtime.** Never in the repo, never in `.env.example`, never set directly as platform (Railway) variables. Local development reads a git-ignored `.env`; everything deployed is injected by the Doppler → Railway integration, which the owner configures by hand.
- **Anything that holds a secret, spends money, or sets a billing cap is the owner's to do.** Creating or renaming services, domains and non-secret configuration is fine for an agent when asked; adding provider keys, enabling paid sources, and provider-side spend caps are not.
- Provider trials that expire on a clock (Yelp, TravelTime) are enabled only against a defined comparison, never "to see" — Technical Constraints §11.

## Architecture rules that are easy to break by accident

- The web bundle never holds a provider key. All third-party calls go through `apps/api` (Technical Constraints §13.7). `EXPO_PUBLIC_*` values are inlined at build time and are public by definition.
- Licensed place content is rented: store identifiers and household-generated annotations only. `trip_stops.venue_name` is a fixtures-only exception and must become fetch-at-display when a licensed source is enabled.
- Every outbound provider call is attributed to a household and session in `provider_calls`; new integrations must log there before they are enabled.
- Allergens exclude; dislikes rank. They never share a control, a colour, or a code path.
- Voice is interpreted against a closed set that is visible on screen, and every voice action has a tap equivalent that produces the same state change.
- Options are composed from one retrieved pool; adding an option must not add a provider call.

## Running

See `README.md`. Postgres is on `localhost:5434` locally because 5432/5433 are used by other projects on the owner's machine.
