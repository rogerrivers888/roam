# Roam — Technical Constraints & API Reference

| | |
|---|---|
| **Version** | v3.0 |
| **Date** | 3 September 2026 |
| **Status** | Working reference |
| **Companion to** | Requirements v5.0 |
| **Primary market** | United States, global thereafter |
| **V1 platform** | Installable web app; native releases are V2 |
| **Owner** | [Owner: TBC] |

> This document holds the implementation detail, licensing constraints, cost model and third-party API findings that sit underneath the requirements. The requirements document describes what the product must do; this one describes what the outside world will and will not let us do, and what it costs.
>
> **All findings verified 3 September 2026.** Provider terms and pricing change without notice. Anything here that gates a build decision should be re-checked against the linked source before it is relied upon.

---

## Contents

1. The central constraint
2. Strategy — breadth first, rationalise later
3. Place and review sources
4. Retention policy comparison
5. Entity resolution across sources
6. Travel time and isochrones
7. Reservations and availability
8. Events and activities
9. Speech and transcription
10. Vision and menu parsing
11. Free evaluation allowances
12. Cost model
13. Architectural decisions and workarounds
14. Spend containment patterns
15. Legal, licensing and permissions register
16. App Store naming mechanics
17. Open items to verify empirically
18. Source index

---

## 1. The central constraint

Everything the product needs from the outside world is **rented, not owned**. Venue detail, ratings, reviews, event listings and route calculations are all licensed under terms that prohibit retention beyond an identifier, or permit it only briefly. Competitors can rent exactly the same data on exactly the same terms.

The only data the product owns outright is what it generates: household profiles, the place ledger, captured menus, dish concepts, trips, visit history and rating history. That data has no third-party retention constraint, accumulates with use, and cannot be acquired by a competitor signing up for the same APIs.

Every architectural decision here follows from that split.

---

## 2. Strategy — breadth first, rationalise later

The product's differentiator is result quality, so V1 integrates every commercial source that might contribute rather than picking one early on cost grounds. Loss-making through beta is accepted.

This is only defensible if two things are built alongside it:

1. **Attribution logging from the first day.** Record which source contributed to every candidate shown, and which candidate the user selected. Without this there is never evidence to remove a source, and every source gets kept forever out of caution.
2. **A single internal source interface from the first commit.** Sources will be switched on and off throughout V1 and V2. The abstraction is far cheaper to build than to retrofit.

**Sequencing note:** breadth of *integration* is not the same as breadth of *spend*. Build the interface for all sources; switch them on in a deliberate order. Yelp's evaluation allowance is a one-time 30-day trial, so turning it on before there is something to evaluate wastes it. See §11.

---

## 3. Place and review sources

**Scope note:** these sources cover everywhere the household might go, not only places to eat. Museums, galleries, parks, bowling, climbing and other permanent attractions come from the same endpoints by venue type; pubs, bars and cafés are ordinary venue types alongside restaurants. Timed events come from the event sources in §8. The one thing no external source provides is an opinion about an activity — experience concepts and their ratings are entirely owned-layer data, built by the household, which is why the rating loop in Requirements Epic 7 must close for visits with no order.

### 3.1 Google Places API (New)

Primary source for discovery, venue detail, and dish-level matching. Broadest global coverage of the three.

**Search endpoints and pagination**

- `places:searchText` (Text Search) and Nearby Search are the discovery endpoints.
- `pageSize` controls results per page: default 20, maximum 20, values above 20 silently coerced, negatives return `INVALID_ARGUMENT`.
- `maxResultCount` is deprecated in favour of `pageSize`. If both are supplied, `maxResultCount` is ignored.
- `nextPageToken` in the response is passed back as `pageToken`.
- **Pagination gotcha:** when paginating, every parameter other than `pageToken`, `pageSize` and `maxResultCount` must match the original request exactly or the call fails. You cannot paginate and vary the query in one call.
- Legacy API capped at 3 pages / 60 results. The New API docs describe pagination without restating the ceiling. Plan against 60; verify — see §16.

**Free-text query matching**

Text Search accepts natural language and matches against venue name, description **and review content**. A query like "best ramen in Vancouver" returns listings where ramen appears in reviews, not only in the business name. This is the mechanism behind dish-level search; the matching happens on Google's index and we never see or store the reviews that produced it.

**Contextual content**

Text Search can return `contextualContent` containing `reviews`, `photos` and `justifications` — the specific reasons a venue matched. `justifications` is what turns a match the user must trust into a match the user can verify.

**Household-relevant fields**

`goodForChildren`, `menuForChildren`, `goodForGroups`, `goodForWatchingSports`, `outdoorSeating`, `reservable`, `restroom`, `allowsDogs`, `servesBreakfast`, `servesBrunch`, `servesBeer`, `servesCocktails`, `servesCoffee`, `servesDessert`, `dineIn`, `delivery`, `curbsidePickup`, `parkingOptions`, `paymentOptions`, `priceLevel`, `editorialSummary`, `generativeSummary`, `reviewSummary`, `neighborhoodSummary`.

Requesting any of these tips the call into the Enterprise + Atmosphere SKU. **Field masks are the primary cost control.** Request only what the current screen renders.

**Search along a route**

`searchAlongRouteParameters.polyline.encodedPolyline` takes an encoded polyline, typically from Routes API `computeRoutes` with `routes.polyline` in the field mask. You can also supply your own using the standard Encoded Polyline Algorithm Format. Results are ranked by **minimal detour time from origin to destination**.

**Critical caveat:** this is a bias, not a restriction. Google's documentation states results are not guaranteed to lie along the supplied route and may sit on an alternate route, particularly where the polyline is not the optimal path. Displaying detour cost per candidate is mandatory.

You can bias to a portion of the route rather than the whole thing — useful for "somewhere on the way home" as distinct from "on the way there".

**Reviews:** maximum 5 per venue, chosen by Google's relevance ranking. No pagination, no sorting. If a rating filter leaves only four of the five qualifying, only four return.

**Retention:** `place_id` indefinite; latitude/longitude 30 days; **everything else, none** — except as the owner has decided below.

**Owner's decision, 4 Sep 2026:** *"You can persist them for 10 hours."* A place's photograph, its rating and its review count may sit on the device for **ten hours** so that reopening the app shows what it already had instead of fetching every card again. Implemented as a private, ten-hour `cache-control` on `/api/photos/google` (`ROAM_PHOTO_CACHE_SECONDS`) and a ten-hour window on what the Inspire me screen remembers, dropped on the way back in when older. It is one household's own browser, never a shared cache, and it expires by itself. Nothing else about this section changes: no licensed field is written to the database, and the server still holds a search in memory only.

### 3.2 Yelp — Places API

Essential for the US market, marginal elsewhere. Strongest review depth of the three.

**Plans** (each with 5,000 free calls during a 30-day trial):

| Plan | Monthly | Overage /1,000 | Review excerpts | Photos | Notes |
|---|---|---|---|---|---|
| Base | $229 | $5.91 | None | None | Base attributes and search filters only |
| Enhanced | $299 | $6.57 | Up to 3 | Up to 3 | Enhanced attributes |
| Premium | $643 | $14.13 | **Up to 7** | Up to 12 | Premium attributes and filters, Review Highlights endpoint |

A separate **Yelp AI API** runs at $25 per 1,000 calls with a 1,000-call daily minimum, offering business summaries, multi-turn conversational prompts, contextual photos and reviews, and **conversational restaurant reservations**. Worth evaluating given the reservation constraints in §7.

**Why Premium matters:** 7 review excerpts plus the Review Highlights endpoint exceeds Google's cap of 5. Combined with Google and TripAdvisor, the effective ceiling rises to roughly 17 excerpts per venue — still not a corpus, but materially more evidence than any single source.

**Retention:** Yelp has historically permitted caching content for up to 24 hours. Confirm against current licence terms before relying on it.

**Commercial history worth knowing:** Yelp sunsetted free commercial API use in 2019 and migrated developers to paid plans, in some cases at short notice. Coverage is US-strongest; treat non-US coverage as supplementary rather than primary.

### 3.3 TripAdvisor Content API

Tripadvisor replaced the v1 Content API with the **Terra** platform in 2026 (docs.terra.tripadvisor.com). Roam integrates the self-serve **Discover** plan; the v1 terms below it are kept for the record.

- Self-serve: sign up at Tripadvisor for Business, pick Discover, set a daily budget, get an `X-API-Key`.
- **Billed per entity, not per call.** Every location ID returned by a search, nearby or details response counts once; a reviews or photos call counts once. Errors do not count.
- **First 1,000 entities free, once per account — not monthly.** Then $0.015 per entity, falling to $0.009 above 5,000 in a billing cycle.
- Discover: 10 requests/second, 10,000 calls/day per API (lower in the dashboard), up to **3 reviews and 5 photos** per location.
- Endpoints: Catalog nearby and text search (rating, count, coordinates, address, URL only), Location Details, Reviews, Photos, batch Details.
- **What the catalog does in practice (probed 3 Sep 2026, ~50 entities):** the radius form of nearby search returns almost nothing (2 results within 5 km of Trafalgar Square, radius > ~20 rejected); the bounding-box form works (2,262 in a 1 km box) but `category`, `sort` and `min_rating` are silently ignored, so a page is an arbitrary slice of mostly obscure listings. Text search by name is accurate and fast (~150 ms) and returns the real venue with its rating, though ranking is loose ("The Ivy" → "The Ivy House").
- **Roam's use:** Tripadvisor is opt-in per search or per trip. Alongside other sources it *enriches*: up to 8 of their venues (unrated first, then nearest) are looked up by name with `geo_name`, two hits each, and only a hit whose normalised name and position agree is returned for the resolver to merge. Alone, it takes one bounding-box page as a testing view.
- Caching: only the location ID may be stored. Review text must be loaded via a call crawlers cannot index (robots.txt Disallow on the API).
- Strong international coverage — the best of the three outside the US for attractions and tourist-facing venues.

*v1 Content API, superseded:* 5,000 calls per month free renewing, 50 calls/second, 5 reviews and 5 photos, `key` query parameter.

### 3.4 The combined review position

| Source | Reviews per venue | Access | Retention |
|---|---|---|---|
| Google Places | 5 | Standard key | None beyond IDs |
| Yelp Premium | 7 + Review Highlights | $643/month | Historically 24h |
| TripAdvisor (Terra Discover) | 3 | 1,000 entities free once, then per entity | IDs only |
| **Combined ceiling** | **~17 excerpts** | | |

Even combined this is not a corpus. Sentiment analysis over hundreds of reviews per venue remains unavailable at any price. The workaround stays the same: push the analytical question into the search query and let each provider's index do the matching, then surface the evidence.

### 3.5 Scraping — assessed and rejected

Commercial scrapers (Apify actors, DataForSEO, Outscraper) function and offer unlimited review extraction cheaply. They breach the source platforms' terms. Viable for a throwaway personal script; **not viable for a paid product with an App Store listing**. Excluded from all phases.

---

## 4. Retention policy comparison

Relevant to the V2 owned base layer. Verified against provider policy pages August 2026.

| Provider | What may be retained | Rule |
|---|---|---|
| Overture-backed open sources | Everything, indefinitely | Open data; cache, store, redistribute |
| Geoapify | Everything, with attribution | Explicitly permits cache, store, redistribute; credit required on free tier |
| Yelp | Content for ~24 hours | Historically permitted; confirm current terms |
| LocationIQ | Cached request/response pairs | 48h free; duration of subscription on paid |
| Radar | 30 days | ToS also bars building a POI database at all |
| HERE | 30 days | Permanent geocoding excluded from base tier |
| Google Places | Place IDs only | Coordinates 30 days; display fields uncacheable |
| Foursquare | IDs only | `fsq_place_id`, photo IDs, `fsq_addr_id` unlimited. Other attributes: 24h local-device only for Enterprise, none for PAYG/Sandbox. Visual or contextual crediting required |
| Mapbox Search Box | Nothing | "Temporary use" only; storage requires a sales contract |

**FSQ OS Places** is available as an open dataset under Apache 2.0 and can be self-hosted. With Geoapify, this is the realistic route to a permanently-held base layer for V2.

**Consequence for the data model:** because allowances differ by provider, a combined venue record needs **per-field provenance and per-field expiry**. A single cache with a single TTL will breach the strictest contributing source. This is materially harder than a conventional cache and should be designed before the second source is switched on.

---

## 5. Entity resolution across sources

The hardest problem in the multi-source strategy, and where projects like this usually fail. It is not a cost problem.

**No shared identifier exists.** Google `place_id`, Yelp business ID and TripAdvisor location ID have no crosswalk. Resolution must be inferred from name, address and coordinates.

**Where it breaks:**

- **Chains.** Twelve identically-named branches within one metro area.
- **Shared addresses.** Food halls, malls and mixed-use buildings where several distinct businesses share a street address.
- **Recent moves.** A venue that relocated two doors down appears at two addresses across sources updated at different times.
- **Renames and rebrands.** Same building, same owner, different name in two sources.
- **Transliteration and diacritics.** Significant in non-English markets, which matters for the global roadmap.
- **Closures.** One source shows a venue as open, another as permanently closed.

**Design requirements:**

- Fuzzy matching on normalised name, normalised address and coordinate proximity, with a confidence score.
- **Below the confidence threshold, do not merge.** Two records shown separately is a minor annoyance; two different restaurants merged into one card is a broken product that sends a family to the wrong place.
- Retain conflicts rather than discarding the losing value. When sources disagree on hours or closure status, that disagreement is signal.
- Decide source precedence per field, not globally. One source may be better on hours and worse on ratings.
- Confidence thresholds should be tunable without a deploy, because they will need adjusting once real data is flowing.

---

## 6. Travel time and isochrones

### 6.1 Provider comparison

| | Google | Mapbox | HERE | TravelTime |
|---|---|---|---|---|
| Drive / walk / cycle | Yes | Yes | Yes | Yes |
| **Public transport** | No | No | No | **Yes** |
| Max travel time | 1h drive, 2h walk/bike | 1 hour | No cap | 3–4 hours |
| Contours per request | 1 | 4 | No cap | No cap |
| Real-time traffic | Yes | No | Yes | No |
| Rate limit | — | 300/min | — | Unlimited |
| Caching permitted | No | No | 30 days | Yes |
| Pricing model | Per request | Per request | Per request | Fixed annual, unlimited |
| Status | Preview (pre-GA) | GA | GA | GA |

### 6.2 The transit finding, recalibrated for a US-primary market

**TravelTime is the only provider returning public transport isochrones from timetabled data.** Google, HERE and Mapbox return driving, walking and cycling only.

When this product was UK-first, that made TravelTime close to mandatory. With the US primary, transit matters in New York, Chicago, San Francisco, Boston, Washington and Philadelphia, and much less elsewhere; most US metros are car-first, where any provider will do.

**This is an accepted single point of dependency on a Critical requirement, not a reason to weaken the requirement.** Transit catchment either works or the feature does not exist; there is no third option in which a lesser supplier partially satisfies it. The risk is commercial — sales-led pricing, a one-time evaluation window, and regional gaps — and belongs in the open questions and supplier negotiation, not in a diluted acceptance criterion. Tracked as Requirements Appendix A3.

The argument for TravelTime survives the market change on different grounds:

- **Fixed annual price, unlimited requests.** At global scale this is far more predictable than per-request billing, and isochrones fire on every search.
- **Permissive caching**, unlike Google and Mapbox.
- **Transit coverage** still matters for the dense US metros, most of Europe, and Japan.

**Coverage gaps to check before committing:** TravelTime excludes China, Russia and North Korea. Mapbox coverage is limited to North America, Western Europe, the Middle East, Japan, Korea, Australia and New Zealand — not global. Neither is a complete answer for a worldwide product.

### 6.3 Pricing notes

- **TravelTime:** sales-led, no public figure. One competitor cites $300+/month as an entry point; treat as indicative.
- **Mapbox:** ~$2.00 per 1,000 isochrones on the first paid tier, falling toward $1.20 at volume. Some sources cite 100,000 free per month. Support carries a $6,000/year minimum on some plans.
- **Google:** free during Preview, no GA rate announced. Preview also means limited support and possible breaking changes.
- **Geoapify:** credit-based, one credit per 5 minutes of isochrone or 5km of isodistance. Free tier without a card.

---

## 7. Reservations and availability

| Provider | Access | Booking via API | Geography |
|---|---|---|---|
| OpenTable | Affiliate application, 3–4 week review, approval not guaranteed | **No** — returns URL for handoff | Global |
| Resy | Partner-only, no self-serve portal | Partner agreements only | **US** |
| Yelp AI API | $25/1,000 calls | Conversational reservations offered | US-strongest |
| TheFork | Investigate | Unknown | Europe |
| Reserve with Google | Not available to us | N/A | Global |

**OpenTable:** the affiliate programme grants restaurant metadata plus reservation links. Even with access, third parties cannot complete a booking; search and availability work, then the user finishes on OpenTable's site.

**Resy:** no public developer portal; integration restricted to approved partners under direct agreement. US-only, which is now an advantage rather than a limitation.

**Reserve with Google — ruled out.** The Actions Center Reservations End-to-End integration requires a **direct contractual relationship with every merchant in the feed**, reconciled against Google Maps locations. It is a channel for booking system providers to surface their merchants' inventory, not a route for a discovery app to read availability.

**Yelp AI API** is the most interesting new option, offering conversational reservations as part of its feature set. Evaluate during the Yelp trial window.

**Realistic V1 position:** surface the `reservable` flag and booking links present in place data, and deep-link out. Do not represent a booking as confirmed in-app.

**Signal that this is opening up:** ChatGPT added reservation booking through OpenTable, Resy and Yelp on 10 August 2026 — OpenTable globally, Resy US-only, Yelp US and Canada. Negotiated partnerships rather than open APIs, but they establish that these platforms will now do AI-assistant deals. Revisit once there are users to point at.

---

## 8. Events and activities

**Permanent attractions** come from the place sources by venue type. No new integration.

**Timed events:**

| Source | Access | Coverage | Licensing |
|---|---|---|---|
| Ticketmaster Discovery API v2 | Free key, immediate | 230,000+ events; **US strongest**, plus Canada, Mexico, Australia, NZ, UK, Ireland, Europe | Free for discovery; commercial pricing for commerce |
| Eventbrite | Free key, OAuth | Global, community and small events | Free |

**Ticketmaster notes:** root `https://app.ticketmaster.com/discovery/v2/`; auth is a simple `apikey` query parameter; sources include Ticketmaster, TicketWeb, Universe, FrontGate and Ticketmaster Resale. The older **International Discovery API is being consolidated into Discovery v2 and is no longer issuing new keys** — build against v2 directly.

**Skiddle removed.** UK-only, and its API is non-commercial without written approval. Out of scope for a US-primary product. Reconsider only if a UK launch is prioritised.

---

## 9. Speech and transcription

### 9.1 Wispr Flow — closed

Assessed and ruled out. Their documentation states access is by exclusive approval only, that they are **not currently offering the API service**, and that they are **not taking new partnerships**. Enterprise contact: enterprise@wisprflow.ai. An unofficial reverse-engineered Python SDK exists; it depends on undocumented client internals, warns of account suspension, and is unusable in a product.

Wispr is a UX layer over commodity ASR. The capability is available from several vendors and the partnership is not needed.

### 9.2 Provider comparison

| Provider | Model | Diarisation cpWER (lower better) | Latency | Pricing | Notes |
|---|---|---|---|---|---|
| AssemblyAI | Universal-3.5 Pro | **30.17** | ~300ms streaming | ~$0.21/hr | Best diarisation; up to 10 speakers; end-of-stream re-clustering ~0.5s |
| ElevenLabs | Scribe v2 | 35.26 | <150ms realtime (claimed) | from $0.40/hr | Best raw accuracy (~3–4% WER EN), 99 languages |
| Gladia | Solaria-1/3 | 36.87 | ~103ms partial | Bundled audio intelligence | 100+ languages, code-switching |
| Deepgram | Nova-3 | 37.92 | sub-250ms | $0.0043/min (~$0.26/hr) | Cheapest accurate English; 36 languages |
| Whisper | large-v3 | — | — | Free self-hosted; $0.006/min via API | 99+ languages, robust on noisy audio |
| Speechmatics | Ursa 2 | DER-reported | Streaming | — | On-premise and air-gapped options |

### 9.3 Selection criteria

**Diarisation accuracy matters more than word accuracy here.** A misheard adjective degrades one comment; a misattributed speaker corrupts a family member's preference model. That points at AssemblyAI on current benchmarks.

For a global product, multilingual breadth becomes a second axis — Gladia and ElevenLabs lead there, Deepgram trails at 36 languages.

### 9.4 Real-world caveats

- Published cpWER figures come from benchmark audio. A busy restaurant or pub is close to the worst case: reverberation, crockery, cross-talk, simultaneous speakers.
- **ASR performs notably worse on children's speech**, and a child is a core user.
- Cost is negligible at any realistic volume. Choose on accuracy, not price.

### 9.5 The design mitigation

Do not perform open-ended transcription. At capture the system knows who is present and exactly what was ordered — constrain interpretation to that closed set. This matters more than provider choice.

**Speaker identification is by self-announcement, not voice enrolment.** See L6 in §14 — this is a legal constraint, not merely a design preference.

---

## 10. Vision and menu parsing

- Current vision models parse menus reliably into structured output: item name, description, price, section, plus inferred tags (vegetarian, spicy, likely allergens).
- Cost per menu is negligible at family scale.
- **Failure modes are physical, not technical:** dim lighting, multi-page and folded menus, chalkboards in a different typeface across the room, reflective lamination, and — relevant now that pubs are in scope — drinks lists behind the bar.
- Design implications: multi-shot capture; a correction screen before the parse is committed; failure that names what could not be read.
- The correction screen doubles as free training signal.
- **Allergen sets differ by market.** The US FDA recognises 9 major allergens; the EU and UK recognise 14. The canonical list needs deciding — see Requirements Epic 1 Q&A.

---

## 11. Free evaluation allowances

What each source gives before it costs anything. **The distinction between recurring and one-time matters operationally.**

| Source | Free allowance | Type | Card required |
|---|---|---|---|
| Google Places | Per-SKU monthly: 10,000 Essentials, 5,000 Pro, 1,000 Enterprise. Place Details IDs-Only and Autocomplete Session Usage unlimited | **Recurring monthly** | Yes |
| TripAdvisor Terra (Discover) | 1,000 entities (location IDs returned) | **One-time** | Yes |
| Yelp Places API | 5,000 calls over a 30-day window | **One-time trial** | Business email |
| Ticketmaster Discovery | Free key, no charge for discovery | **Ongoing** | No |
| Eventbrite | Free key | **Ongoing** | No |
| Geoapify | Free tier | **Ongoing** | No |
| Mapbox | Some sources cite 100,000 isochrones/month | **Recurring monthly** | Yes |
| TravelTime | Trial only, sales-led | **One-time** | Contact sales |
| Speech providers | Pay-as-you-go from ~$0.21/hr | N/A — cost negligible | Yes |

**Operational consequence:** Google, Ticketmaster and Eventbrite can be left running indefinitely at zero cost during a four-person private beta. Tripadvisor's 1,000 free entities do not renew, so it runs at low single-figure dollars a month once they are spent (a browse costs about 20 entities). **Yelp and TravelTime cannot.** Their trials burn on a clock whether used or not, so they should be switched on only when there is a specific comparison to run and someone available to judge the results.

**Recommended evaluation sequence:**

1. Google alone — validate the isochrone and dish-search assumptions (§16 items 3 and 4). Costs nothing.
2. Add TripAdvisor — 1,000 free entities then pennies per page, tests the entity resolution logic with a second source.
3. Add Ticketmaster and Eventbrite — free, adds the activities dimension.
4. **Then** open the Yelp trial with a defined comparison and a defined window.
5. **Then** approach TravelTime with usage figures in hand, which also improves the negotiating position.

---

## 12. Cost model

### 12.1 Google Maps Platform rates (2026)

The universal $200 monthly credit was retired 1 March 2025 and replaced with **per-SKU free thresholds that do not pool**.

| SKU | Tier | Free/month | 0–100k | 100k–500k | 500k–1M | 1M–5M | 5M+ |
|---|---|---|---|---|---|---|---|
| Text Search | Pro | 5,000 | $32.00 | $25.60 | $19.20 | $9.60 | $2.40 |
| Text Search | Enterprise | 1,000 | $35.00 | $28.00 | $21.00 | $10.50 | $2.63 |
| Text Search | Ent + Atmosphere | 1,000 | $40.00 | $32.00 | $24.00 | $12.00 | $3.40 |
| Nearby Search | Pro | 5,000 | $32.00 | $25.60 | $19.20 | $9.60 | $2.40 |
| Place Details | Essentials | 10,000 | $5.00 | $4.00 | $3.00 | $1.50 | $0.38 |
| Place Details | Pro | 5,000 | $17.00 | $13.60 | $10.20 | $5.10 | $1.28 |
| Place Details | Enterprise | 1,000 | $20.00 | $16.00 | $12.00 | $6.00 | $1.51 |
| Place Details | Ent + Atmosphere | 1,000 | $25.00 | $20.00 | $15.00 | $7.50 | $2.28 |
| Place Details Photos | — | 1,000 | $7.00 | — | — | — | — |
| Autocomplete Requests | Essentials | 10,000 | $2.83 | $2.27 | $1.70 | — | — |
| Autocomplete Session Usage | — | Unlimited | Free | Free | Free | Free | Free |
| Place Details — IDs Only | — | Unlimited | Free | Free | Free | Free | Free |
| Geocoding | Essentials | 10,000 | $5.00 | $4.00 | $3.00 | $1.50 | $0.38 |
| Routes | — | — | ~$5.00 | — | — | — | — |
| Dynamic Maps | Essentials | 10,000 | $7.00 | $5.60 | — | — | — |

**Cost-control levers:** IDs-Only and Autocomplete Session Usage are unlimited free — use them wherever the screen needs no display fields. Field masks determine the SKU tier. Search bills per request even when zero results return.

### 12.2 Fixed monthly commitments

Distinct from per-call charges and payable regardless of usage:

| Source | Monthly floor | Notes |
|---|---|---|
| Yelp Places (Premium) | $643 | Plus $14.13 per additional 1,000 calls |
| Yelp Places (Enhanced) | $299 | Plus $6.57 per 1,000 — 3 review excerpts instead of 7 |
| TravelTime | TBC, sales-led | Fixed annual, unlimited requests |
| Mapbox support tier | $6,000/year on some plans | Only if support is contracted |

**All sources on at Yelp Premium: roughly $650–$1,000+ per month before a single user.** This is the number that makes the sequencing in §11 worth following.

### 12.3 Worked session estimates

**Simple session — "dinner near the theatre", multi-source:**

| Call | SKU | Qty | Cost |
|---|---|---|---|
| Isochrone | TravelTime (fixed fee) | 1 | $0 marginal |
| Search formulations | Text Search Pro | 3 | $0.096 |
| Venue detail on shortlist | Place Details Pro | 10 | $0.170 |
| Yelp enrichment on shortlist | Yelp Premium overage | 10 | $0.141 |
| TripAdvisor enrichment | TripAdvisor (free tier) | 10 | $0 |
| **Total** | | | **~$0.41** |

**Complex session — full day trip, three stops, three options:**

| Call | SKU | Qty | Cost |
|---|---|---|---|
| Route calculations | Routes | 5 | $0.025 |
| Isochrone / corridor | TravelTime (fixed fee) | 2 | $0 marginal |
| Search formulations (shared pool) | Text Search Pro | 5 | $0.160 |
| Venue detail across options | Place Details Pro | 25 | $0.425 |
| Yelp enrichment | Yelp Premium overage | 25 | $0.353 |
| TripAdvisor enrichment | TripAdvisor (free tier) | 25 | $0 |
| Event lookups | Ticketmaster (free) | 2 | $0 |
| **Total** | | | **~$0.96** |

**At scale:** 10,000 households at four complex sessions per month is roughly **$38,000/month** in variable cost, plus fixed floors, before volume discounts and before any owned base layer reduces the call count.

**None of this is amortisable.** The retention constraint means the same search for the same user in the same area next week bills again. This is the strongest argument for the V2 owned place layer and for the source rationalisation in Requirements Appendix B.

**Partly answered, 4 Sep 2026.** The owned place layer (§13.10) does not make searching cheaper — a search is still a search — but it means that everything a household *keeps* is researched once, from free sources, and never bought again. Opening a saved place costs nothing after the first time, works with no signal, and the record improves rather than expiring.

### 12.4 Other running costs

- **Speech:** negligible. ~$0.21–$0.40 per hour of audio; a family debrief is one minute.
- **Vision (menu parsing):** negligible at family scale.
- **Events:** free at beta volumes.
- **Hosting:** minimal for a prototype.
- **[V3] Video storage:** materially different from everything above. Video is the first feature with a storage cost that grows monotonically and never falls, since the whole point is that it is kept for years. Model this before committing to the feature — a household capturing one minute per visit at two visits a week accumulates roughly 100 minutes a year, and the retention promise is indefinite.

---

## 13. Architectural decisions and workarounds

### 13.1 The place ledger

Store venue identifiers plus household-generated annotations only — shown on date, dismissed, saved, visited. On the next search, fetch fresh results and filter client-side. Delivers "show me somewhere different" with zero retention of licensed content. Venue identifiers can change, so the ledger needs a refresh strategy.

### 13.2 Query diversification instead of pagination

Issue several deliberately different query formulations against the same area and deduplicate. Three formulations at ~$0.032 each yields 50+ candidates for about 10 cents. The formulations should attack the ranking from genuinely different angles, not be minor rewordings.

### 13.3 Shared candidate pool across trip options

Search once into a shared pool, then compose multiple day options by varying selection, ordering and intensity. Roughly one third the cost of three independent searches for the same output.

### 13.4 Per-field provenance and expiry — **built** (4 Sep 2026)

A combined venue record carries, per field, which source supplied it and when it must be discarded. Required because provider retention allowances differ — see §4.

Implemented as `place_facts` (migration 021): one row per venue, field and source, carrying the licence, the retention rule and the computed `expires_at`. `sweepExpired()` deletes what has run out and rebuilds the record that lost it. Nothing in the table has an expiry today, because every source feeding it is indefinite — but the machinery is in place and running before the day a 30-day source is enabled, which was the requirement.

### 13.10 The owned place layer — **built** (owner, 4 Sep 2026)

> "We don't need to store all this data for every single search of every single record that's returned. What would be good to store is the shortlisted venues, the activities, hotels, and restaurants that they've actually visited previously… once they add that action to store it, or say we visited it, we go off and get our own research… that way we then own it, and we're building up that store."

The answer to §1 and to the "not amortisable" finding in §12.3. Not a cache of anybody's search results: a **second, parallel record**, researched only when a household does something that means the place matters — shortlists it, saves it, marks it special, or records a visit — from sources whose licences permit keeping the answer for good.

| Source | What it gives | Licence | Cost |
|---|---|---|---|
| OpenStreetMap (Overpass) | The same place in the open map: name, category, cuisine, diets, hours, address, phone, website | ODbL, attribution required | free |
| Photon (Komoot) | Cities, towns and regions matched on a prefix, for the "where are we going?" box — the same OSM data, indexed for typing rather than for exact lookup | ODbL, attribution required | free, no key |
| The venue's own website | The schema.org block a business publishes for machines: phone, address, hours, price band, booking link, menu URL | published for republication | free |
| Wikipedia | A description for places with an article | CC BY-SA 4.0, credit and link required | free |
| Wikidata | Official website, year opened | CC0 | free |

The rented record is used only as a **description of what to go and find** — a name and a point on the map — and is never written down. `place_records` holds only fields whose facts have no expiry, which is what makes it the copy a device may keep.

Two consequences worth naming:

- **A Google-identified place becomes an open-data one.** Matching to OpenStreetMap replaces a coordinate we may keep for 30 days with one we may keep for ever, and gives the place an `osm_ref` that outlives our relationship with any provider.
- **The research compounds.** `place_records` is not scoped to a household: a restaurant researched because one family shortlisted it is known to every family after them. This is the asset that a competitor signing up for the same APIs does not get.

Files: `api/src/sources/own.js` (claim, research, compose, sweep, the background loop), `openMatch.js`, `encyclopedia.js`, `site.js`. Triggered from `POST /api/places/save`, `POST /api/visits` and `addShortlistItem`.

### 13.11 Offline — **built** (owner, 4 Sep 2026)

> "Sometimes, often, users will be offline or not have signal. It's very important to me that when a user does research, that research is stored… They do not have to research every time they come back to the page."

Three parts:

1. **The app opens with no signal.** A service worker (`web/public/sw.js`) caches the shell — bundle, fonts, icons. It never touches `/api`, so no licence decision is made twice.
2. **Every answer the app is given is saved, if its licence allows.** `web/src/offline/policy.ts` is the licence in code: an endpoint not named there is not saved, so a new one has to be thought about rather than inherited. Searches, plans, routes and photos are never written down; the atlas, the trips, the visits and the owned records are. A GET that cannot reach the API is answered from the copy and the screen says so.
3. **The rule on a device is stricter than on the server.** A phone is somewhere we cannot reach to delete anything from, so nothing rented goes to one at all — not even the 30-day coordinates §4 would permit. That is affordable precisely because 13.10 exists.

`navigator.onLine` is not used as the test for "offline": it reports a network interface, not a working connection. What the app shows is whether answers actually came off the device.

### 13.5 Closed-vocabulary matching for voice

Used twice, for the same reason: rating capture interprets against known attendees and known ordered items; trip assembly interprets against the stops on screen. Constraining to a small known set matters more than ASR vendor choice.

### 13.6 Dish concept normalisation at write time

Normalise item names into shared concepts when a menu is parsed or a rating saved, not at search time. Without it, five ratings across five venues are five orphaned opinions about five specific plates.

### 13.7 Backend proxy for all third-party calls

No API key reaches the client. Two reasons: key security, and the fact that providers impose obligations (attribution, privacy policy, retention limits) we can only guarantee by controlling the call path.

### 13.8 Intensity as a proportion, not a count

A target proportion of available time scales sensibly across a four-hour afternoon and a ten-hour Saturday; a stop count does not.

### 13.9 Web app for V1 — decided

**V1 ships as an installable web app. Native iOS and Android are V2.** This is now a requirement, not an engineering preference — the earlier contradiction between the two documents is resolved in favour of web.

A mobile web app added to the home screen gives camera, microphone and offline storage, which covers every V1 feature, and removes the build-upload-review cycle at the point where iteration speed matters most. It also removes App Store submission, privacy nutrition labels and store review from the V1 critical path entirely.

What is deferred to V2 by this choice: background location, richer offline storage guarantees, push notifications on some platforms, and anything requiring store distribution.

### 13.10 Offline reconciliation

Orders created offline carry a client-generated identifier. On reconnect the order is reconciled against the visit exactly once, keyed on that identifier. Without it, a retry after a failed sync produces a duplicate visit and a duplicate order — the most likely data corruption in the product, because it happens at the moment of worst connectivity.

### 13.11 The visit as the layer boundary

A visit holds a venue identifier from the rented layer and everything else from the owned layer: the order, the ratings, and later the photos and video. This makes the visit the single join between rented and owned data, and the reason the household's history survives even though none of the venue content behind it may be retained.

---

## 14. Spend containment patterns

Cost is the central commercial risk: provider content cannot be retained between sessions, so the same search for the same household next week bills again. Nothing amortises. A client retry loop is a direct billing event.

**Required before any provider key is used in code:**

- **Provider-side billing caps.** Set at each provider's console, independent of application logic. This is the backstop that survives a bug in everything else.
- **Per-session call bounds.** Every outbound call attributed to a household and a session, bounded per session. On reaching the bound, serve what has already been retrieved and tell the user rather than continuing to call.
- **Per-household period bounds.** A monthly ceiling per household, so one user's behaviour cannot produce an unbounded bill.
- **In-session deduplication.** Identical calls within one session served from the in-session result set. Distinct from caching between sessions, which the retention terms prohibit — this is transient working memory for one request cycle, not storage.
- **Shared candidate pool for trip options.** Composing several day plans from one retrieved pool rather than issuing independent searches per option. Roughly one third the cost for the same output, and now bound by an acceptance criterion rather than left as guidance.
- **Field mask discipline.** Requesting only fields the current screen renders. On the primary place source this is the difference between the $32 and $40 per thousand tiers.

**Instrumentation to build alongside:** cost per session, cost per household per period, and cost per source. Without these the source rationalisation planned for V2 has no evidence base.

---

## 15. Legal, licensing and permissions register

**Reframed for a US-primary, global product.** None of this is legal advice; each item needs qualified counsel in the relevant jurisdiction.

| # | Item | Status | Required before | Action |
|---|---|---|---|---|
| L1 | **COPPA — verifiable parental consent** | **Not applicable to V1** | Public beta supporting households with a child under 13 | COPPA governs *operators of online services* collecting data from children. An unreleased product used only by its author's own household is not operating a service, so V1 as scoped is out of reach of it. It returns at public beta. Note that "verifiable parental consent" is a defined standard — the FTC's accepted methods include signed forms, card transactions, calls to trained personnel and ID verification. **An in-app checkbox does not meet it.** V1 mitigates structurally: child member records are created and owned by an adult account, children have no login, and no voice is captured from a child |
| L2 | **State biometric law (Illinois BIPA, Texas CUBI, Washington)** | Design decision made | Any voice identification feature | Voiceprints are biometric identifiers. BIPA carries a private right of action with statutory damages and extensive litigation history. **V1 mitigates by identifying speakers via self-announcement and storing no voiceprint.** Any future voice enrolment needs explicit written consent flows and counsel review |
| L3 | **CCPA / CPRA and state privacy laws** | Not started | US public launch | Disclosure, deletion and opt-out rights across a growing patchwork of state regimes |
| L4 | **GDPR / UK GDPR** | Not started | Any EU or UK launch | Applies if EU/UK users are served, regardless of where the company sits |
| L5 | **Terms of Use and Privacy Policy** | Not started | Any release | Must incorporate each place provider's ToS and Privacy Policy by reference. Also required for App Store submission |
| L6 | **Multi-source attribution implementation** | Not started | Any release | Each provider imposes its own crediting rules. A combined venue view must satisfy all of them at once — Google logo and third-party credits, Yelp crediting, TripAdvisor crediting, author info and links on every review shown |
| L7 | **Per-source retention compliance** | **Built** (4 Sep 2026) | Second source going live | Different expiry per provider. A single cache lifetime breaches the strictest source. `place_facts` carries licence, retention and `expires_at` per field; `sweepExpired()` runs on the API's background loop. See §13.4 |
| L8 | **Bystander audio capture** | Not started | Voice feature release | Recording in a public venue captures third parties who have not consented. Some US states require all-party consent for recording. Mitigation: transcribe and discard; prefer on-device processing |
| L9 | **Menu prose copyright review** | Not started | Any menu database beyond the capturing household | Item names are not protectable; descriptive prose is. Gates the V3 menu search feature |
| L10 | **OpenTable affiliate application** | Not started | V2 booking improvements | 3–4 week review, approval not guaranteed |
| L11 | **Resy partner approach** | Not started | V2 US booking | Partner-only, direct agreement required |
| L12 | **App Store name and trademark clearance** | Not started | Name commitment | See §16. Trademark search in US classes 9 and 42, plus each launch market |
| L13 | **Scraping — confirmed excluded** | Decided | — | Functional but breaches source ToS. Not viable for a paid product |
| L16 | **Data export and deletion** | Not started | Any public release | CCPA/CPRA and GDPR both require it. Exclusion from recommendation calculations is not deletion. Bound by Epic 1 C9 and C10 |
| L14 | **App Store privacy disclosures** | Not started | **V2** native submission | Privacy nutrition labels covering location, microphone, camera, and children's data. Apps directed at children face additional review scrutiny |
| L15 | **[V3] Video and image rights** | Not started | Video memories feature | User-generated video in a public venue may capture other patrons and staff. Retention, deletion and export obligations apply |

---

## 16. App Store naming mechanics

Relevant to the naming decision and commonly misunderstood.

- **App names are globally unique across the entire App Store.** Two apps cannot share a name, including two apps from the same developer.
- Uniqueness is **case-insensitive** — "ROAM" does not get around a taken "Roam".
- **Name limit: 2–30 characters.** Single-character names are not permitted.
- **The subtitle is a separate 30-character field with no uniqueness requirement.** Many apps share subtitles.
- **The home screen display name is a third, separate value and need not be globally unique.** The store listing can be "Roam: Places You'll Love" while the icon reads "Roam".
- **Promotional text** is 170 characters, editable without shipping a new build. Useful for a secondary line.
- Other limits: keywords 100 bytes, description 4,000 characters. The 30-character name limit applies per localisation.
- **A domain is not required and is entirely independent** of App Store naming.
- **Trademark trumps availability.** A name can be unique on the store and still be rejected or pulled for infringement.
- Dormant developer accounts can hold a name indefinitely; reclaiming a squatted name is not something to count on.

---

## 17. Open items to verify empirically

1. **Does the 60-result pagination ceiling still hold in Places API (New)?** Run a high-cardinality query and page to exhaustion.
2. **Actual TravelTime pricing.** Sales-led. Approach with usage figures in hand — see §11.
3. **Isochrone quality in target metros.** Compare a 20-minute transit isochrone in New York and a 20-minute driving isochrone in a car-first US metro against reality. Riskiest assumption in the product.
4. **Dish-level match quality.** Does a free-text dish query return venues that genuinely serve it, and do the `justifications` carry usable evidence?
5. **Entity resolution accuracy.** Run Google, Yelp and TripAdvisor over one dense neighbourhood and hand-check the merges. Measure both false merges and false splits; false merges are the more damaging error.
6. **Yelp's current caching terms.** The 24-hour allowance is historical; confirm against the current licence.
7. **Venue identifier churn rate.** How often do stored IDs go stale, and what refresh cadence does the ledger need?
8. **Menu parse accuracy in real conditions**, including pub drinks lists and chalkboards. Not testable at a desk.
9. **Diarisation accuracy with a child's voice in venue noise.** Benchmark figures will not predict this.
10. **Non-US coverage depth** for each source in candidate launch markets.
11. **Attraction and activity data quality.** Venue-type queries for museums, galleries and parks return results, but whether the returned detail is rich enough to rank against household preference is untested. Check on the same dense neighbourhood used for item 5.
12. **Web app capability on target devices.** Confirm camera, microphone and offline storage behave acceptably in an installed web app on current iOS, since this now carries all of V1.

---

## 18. Source index

All sources verified 3 September 2026.

| Topic | URL |
|---|---|
| Places API policies, caching, attribution | https://developers.google.com/maps/documentation/places/web-service/policies |
| Text Search reference (pagination, contextual content) | https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places/searchText |
| Text Search guide (field masks, SKU triggers) | https://developers.google.com/maps/documentation/places/web-service/text-search |
| Search along a route | https://developers.google.com/maps/documentation/places/web-service/search-along-route |
| Maps Platform service-specific terms | https://cloud.google.com/maps-platform/terms/maps-service-terms |
| Yelp data product pricing | https://business.yelp.com/data/resources/pricing/ |
| Yelp Fusion / Places API | https://fusion.yelp.com/ |
| TripAdvisor Content API | https://tripadvisor-content-api.readme.io/ |
| Isochrone provider comparison | https://traveltime.com/blog/google-isochrones-api-vs-traveltime |
| Geoapify isoline API and licensing | https://www.geoapify.com/isoline-api/ |
| Foursquare usage guidelines and retention | https://docs.foursquare.com/docs/usage-guidelines |
| FSQ OS Places open dataset | https://docs.foursquare.com/data-products/docs/fsq-places-open-source |
| Ticketmaster Discovery API v2 | https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/ |
| Wispr Flow API access status | https://api-docs.wisprflow.ai/quickstart |
| Speech diarisation benchmarks | https://www.assemblyai.com/blog/top-speaker-diarization-libraries-and-apis |
| Reserve with Google eligibility | https://developers.google.com/actions-center/verticals/reservations/e2e/overview |
| App Review Guidelines (2.3.7, naming) | https://developer.apple.com/app-store/review/guidelines/ |
| App Store Connect app information reference | https://developer.apple.com/help/app-store-connect/reference/app-information/app-information |
| Railway MCP server | https://docs.railway.com/ai/mcp-server |
