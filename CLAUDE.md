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
- While the household is speaking, the screen shows only the live transcript (`Listening` component): suggestions and everything else collapse, listening continues until they tap Done, and nothing is sent before then. Use `useSpeech` (continuous, accumulating) for every mic; never send on the first pause.
- Options are composed from one retrieved pool; adding an option must not add a provider call.

## Web and mobile are one layout system (owner, 3 Sep 2026)

The owner reviews every screen in both views on the deployed site: the shell (`apps/web/App.tsx`) carries a Web / Mobile toggle on any window 900px or wider, and "Mobile" draws the whole app inside a 390px phone frame. New screens and components must follow the structure that makes that work:

- **Never read the window directly.** Use `useViewport()` from `apps/web/src/hooks/useViewport.tsx` for width and height, not `useWindowDimensions`, `Dimensions` or `window.innerWidth`. The frame tells screens they are 390px wide through that hook; anything reading the window ignores the toggle and shows the desktop layout inside the phone.
- **Every screen has a phone layout and a wide layout**, decided from that width (breakpoints in use: 680 for the date picker, 900 for the shell, household and drawer, 1000 for Places and Trips). Design both before calling a screen done, and check both with the toggle on the Railway deployment, not only on a desktop window.
- **Anything that portals out of the tree (a `Modal`) must pin itself to the frame.** Read `framed` and `origin` from `useViewport()` and position the sheet at that origin with the frame's size, as `VenueDrawer` does; otherwise it covers the whole browser window.
- **Keep one tree shape across layouts.** A screen that returns two different trees for wide and narrow loses its state when the owner flips the toggle. Branch on style and on which children render, not on the whole return.
- **Icons come from one set.** `apps/web/src/components/Icon.tsx` wraps Lucide (`lucide-react-native`); use `<Icon name=…>`, `<CategoryIcon>`, `<IconText>` and `<Rating>`, or the `icon` prop on `Chip` and `Button`. Never an emoji or a symbol character (★ ♥ ✕ ✓ 🎙 📍 …) as an icon; the owner called that embarrassing (3 Sep 2026). Add a name to the set rather than importing a glyph in a screen.
- **Content must fit 390px.** Rows wrap, chips shrink (`Chip` already wraps long labels), and nothing is allowed to overflow the frame horizontally.

## Running

See `README.md`. Postgres is on `localhost:5434` locally because 5432/5433 are used by other projects on the owner's machine.
