# Roam — Trips: Competitive Analysis and Design

| | |
|---|---|
| **Version** | v1.0 |
| **Date** | 3 September 2026 |
| **Status** | Design — drives the trip rebuild |
| **Supersedes** | The single-outing "Trip" in Requirements v5.0 §5, which becomes one kind of trip |

> The requirements defined a trip as a same-day outing. The household plans holidays too: several days in another country, a hotel to come back to, some days packed and some slow, restaurants and activities researched into lists before any day is planned. This document looks at what the best trip products do, names what Roam must match and where it can be decisively better, and specifies the model and screens.

---

## 1. Who we are up against

| Product | What it does well | Where it falls short | Sources |
|---|---|---|---|
| **TripIt** | The master itinerary from forwarded confirmations: flights, hotels, cars in one timeline; Pro alerts on delays, gates, seats, fares | *Doesn't plan.* No suggestions, no routes, no day building, view-only sharing without Pro | [BluePlanIt](https://blueplanit.co/blog/wanderlog-vs-tripit), [Wandrly](https://www.wandrly.app/comparisons/wanderlog-vs-tripit), [TripStone](https://tripstone.app/blog/wanderlog-vs-tripit) |
| **Wanderlog** | The reference itinerary builder: day-by-day, saved places per trip, hotels, map with every pin, travel times between stops, day totals, route optimisation, Gmail import, Docs-style collaboration, offline, budget, checklists | *Manual labour.* Every place searched and added one by one — "3–4 hours for a 10-day trip"; suggestions are generic, not personal; no sense of who is going; multi-editor chaos with no history | [Wanderlog](https://wanderlog.com/), [help: optimize route](https://help.wanderlog.com/hc/en-us/articles/13545624787867-Optimize-route), [AItravel.tools](https://aitravel.tools/wanderlog-review/), [Faroway](https://www.faroway.ai/blog/ai-travel-planner-vs-wanderlog), [TripStone](https://tripstone.app/blog/wanderlog-review) |
| **Stippl** | Destinations → days → items; stays, activities, transport and restaurants on one daily timeline without rigid time slots; drag to reorder; route map with distances; AI day plans; packing and budget | Date handling confuses users (overnight flights); AI plans are generic; nothing about the people travelling | [Stippl](https://www.stippl.io/itinerary-planner), [Wandrly](https://www.wandrly.app/reviews/stippl), [JustUseApp](https://justuseapp.com/en/app/6443617088/stippl-the-travel-planner/reviews) |
| **Mindtrip** | AI-generated, editable itinerary with Morning / Afternoon / Evening per day; restaurants, hotels and activities with drive times; group comments | Weak at trade-offs ("near transport *and* under $400" gets one or the other); reorders itself unexpectedly; no drag-and-drop; no durable model of the family | [AItravel.tools family test](https://aitravel.tools/mindtrip-review/), [SearchSpot](https://www.searchspot.ai/blog/mindtrip-ai-review-2026), [Product Hunt](https://www.producthunt.com/products/mindtrip/reviews) |
| **Polarsteps** | Beautiful tracking and reliving; simple planner with notes, accommodation, must-sees, transport between stops; AI itineraries from past trips | Planner is thin; no bookings; nothing per person | [Polarsteps planner](https://www.polarsteps.com/travel-planner), [PilotPlans review](https://www.pilotplans.com/blog/polarsteps-review) |
| **Tripomatic (Sygic Travel)** | Day-by-day with estimated travel times and walking distances; offline maps | Walk or drive only — no transit; thin coverage of restaurants; commercialised | [Rick Steves forum](https://community.ricksteves.com/travel-forum/tech-tips/sygic-travel-planner-been-amazing-albeit-quite-commercialized), [Will Fly for Food](https://www.willflyforfood.net/sygic-travel-the-awesome-travel-planning-app-formerly-known-as-tripomatic/) |
| **Mapstr** | Map-first saving with unlimited tags and colours; friends' places; "alert me when I pass a saved place"; book a table from the pin | Not an itinerary tool; subscription backlash (300-place cap on free) | [Mapstr](https://en.mapstr.com/), [Compass & Key](https://thecompassandkey.com/mapstr-app-review), [App Store reviews](https://apps.apple.com/us/app/mapstr-save-follow-places/id917288465?see-all=reviews) |
| **Google Maps lists / Apple Guides** | Free, shareable, synced lists of places; the maps everyone already has | No multi-day planner at all — "how do I get there", not "what do we do each day" | [Yopki](https://yopki.com/guides/how-to-plan-a-trip-on-google-maps/), [Simology](https://simology.io/blog/build-shareable-maps-lists-googleapple-maps-itinerary-planning) |

Two things every serious planner has converged on, and Roam must simply have:

1. **Trip → days → items, with a per-trip shortlist of saved places and a map** (Wanderlog, Stippl, Mindtrip). Lodging is a first-class item on the day.
2. **Travel time between items and a per-day total** (Wanderlog, Tripomatic), shown as you build.

And what none of them has — the wedge:

- **They plan for a generic traveller.** None knows that Phoenix is 8, that Gina is vegetarian and allergic to carrots, that Roger likes historical things but not for six hours, that walks are fine up to 40 minutes, or that the family will drive three hours for something special but thirty minutes for dinner. Roam already holds all of that and applies it to every candidate.
- **They start from a blank canvas.** Wanderlog's own reviewers call it hours of manual work; Mindtrip fills the canvas but can't reason about trade-offs. Roam composes *options* from one pool and lets the household react — by tapping or by talking — which is faster than both.
- **They don't learn.** A visit in Roam changes the next recommendation. Nothing above does that.
- **Families specifically** want shared visibility, kid-aware filtering, offline, and the flexibility to change the day when a child is tired ([Chasin' Surf](https://www.chasinsurf.com/best-family-travel-apps-2026/), [Nori](https://heynori.com/blog/best-family-trip-planner-apps), [Stardrift](https://stardrift.ai/resources/best-ai-trip-planner-family-group-travel)). Roam's re-planning from the same pool is exactly the "child is tired, what now?" move.

---

## 2. The atlas comes first

The household's own record of the world, grown across every trip: **countries → cities → places** they have been to (with what everyone thought), saved to try, or marked special. Going back to a city means the list is longer than last time. Nothing in the competitive set keeps this across trips — Wanderlog and Stippl scope saved places to one trip; Mapstr keeps a map but has no trips.

- Browsing is geographic: **Places → United Kingdom → London → 23 places (14 been · 7 to try · 2 special)**.
- A trip is a **date range in a city**; creating one starts its shortlist from everything already in the atlas for that city, and every place discovered on the trip goes back into the atlas.
- Visits, saves, specials and shortlist entries all write to the atlas automatically.

## 2b. What a trip is now

A **trip** is any span of time away from the normal routine, from a two-hour outing to two weeks abroad. The shape is the same; the number of days differs.

| Concept | Definition |
|---|---|
| **Trip** | A title, a **place** (country + city/region, from geocoding), **start and end dates**, a **base** (hotel, rental, or home for a day out), whether there's a **car**, who's coming, a default pace. A same-day outing is a one-day trip whose base is home. |
| **Day** | One calendar date of the trip, with its own **pace** (relaxed / balanced / packed), **travel mode** (car, transit, walking), optional start and end times, and notes. Days are created automatically from the dates. |
| **Shortlist** | Places the household has researched *for this trip*, before or while planning days: **Restaurants**, **Things to do**, and **Saved** (anything else). Each entry can carry a note, a "must do" flag, and a preferred day. Lists are per trip; the household's global ledger remembers them too. |
| **Stop** | A place scheduled on a day, in a **slot** (morning / afternoon / evening) with an optional start time and a time allowance. Stops come from the shortlist or from Roam's options. |
| **Visit** | Unchanged: a stop the household actually went to, with takes. |

Rules that carry over unchanged from the requirements: allergens exclude; dislikes, diets, limits and learned preferences rank; pace differs by kind; the time budget is recalculated whenever a day changes; options for a day come from **one** pool.

---

## 3. Information architecture

```
Trips
├── list: grouped by country → trips (upcoming / past), plus "Day outings"
└── Trip
    ├── Overview   dates · base · who · car · map of everything · day strip
    ├── Days       one card per date → Day planner
    ├── Shortlist  Restaurants · Things to do · Saved   (search near base or any area; add to a day)
    ├── Stay       the base: hotel or rental; "near my hotel" searches; check-in/out
    └── Map        every pin, coloured by day; unscheduled shortlist in grey
```

**Day planner** (the core screen): the day's pace and mode at the top; a **time bar**; three slots — Morning, Afternoon, Evening — each holding stops with travel legs between them; an **Unscheduled** drawer at the bottom holding shortlist items not yet placed; **Plan this day with Roam** to compose options from the shortlist plus what's near the base (the same options-and-react loop as today, with "plan around the activities", "plan around the meals", "stay near the hotel" as the stated bases); each stop has *We went* → rate.

**Three ways to plan, all supported:**

1. *Research first.* Search restaurants and things to do near the base or a neighbourhood, save to the shortlist over days or weeks, then drop them onto days.
2. *Activities first.* Put the anchors on days (the castle on Tuesday, the boat on Thursday), then ask Roam to fill meals and gaps around them.
3. *Talk.* "Wednesday: something packed, castle in the morning, lunch near it, back to the hotel by six" — options appear, react, accept.

**Desktop:** Trip pages are two-column — left: days or shortlist; right: the map, with the selected day's pins highlighted. **Phone:** the same sections as a segmented control under the trip header; map as its own section; day planner full-screen with the Unscheduled drawer sliding up.

---

## 4. Data model changes

```
trips
  + kind            'outing' | 'trip'
  + start_date, end_date   (date)
  + base_label, base_lat, base_lng, base_kind ('home'|'hotel'|'rental'|'other'), base_check_in, base_check_out
  + has_car         boolean
  + place_label     (city/region as typed), country/country_code/locality (exist)
  (origin/destination/depart_at/return_at remain for outings and are derived for trips)

trip_days
  id, trip_id, date, intensity, travel_mode, start_time, end_time, notes

trip_shortlist
  id, trip_id, venue_ref, venue_label, kind ('food'|'activity'|'other'), category, lat, lng,
  note, must_do boolean, preferred_day_id, added_at

trip_stops
  + day_id, slot ('morning'|'afternoon'|'evening'), start_time (optional)
```

The time budget runs per day (day start/end times default from the household's pace). Options for a day are composed from a pool that is the union of the shortlist and a retrieval near the base, bounded by the day's mode and the household's per-kind travel limits.

---

## 5. Build order

**P1 — this iteration.** Trip creation with dates, place, base, car, who; days generated; shortlist with search near base / any area and "add to day"; day planner with slots, travel legs, budget bar, unscheduled drawer, per-day pace and mode; "Plan this day with Roam" reusing the options loop; map section; trips list grouped by country with outings separated.

**P2.** Drag between days and slots; a stay with check-in/out on the first/last day timeline; import a booking by pasting confirmation text; collaboration; offline day view; "near my hotel now" from the phone at night.

**P3.** Booking hand-offs, provider photos and reviews once licensed sources are enabled; proximity alerts (Mapstr's best idea) in the native app.
