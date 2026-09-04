# Roam — Requirements

| | |
|---|---|
| **Working title** | Roam *(provisional — subject to trademark and App Store name clearance)* |
| **Subtitle** | Remember every place you love |
| **Version** | v5.0 |
| **Date** | 3 September 2026 |
| **Status** | Draft — for review |
| **Companion** | Technical Constraints & API Reference v3.0 |
| **Owner** | [Owner: TBC] |

---

## 1. Introduction

A day out is a museum, a pub, a walk, a gig and a meal, in whatever combination fits the time available. Planning one currently means jumping between a maps app, a reviews site, a ticketing site and a booking site, none of which know anything about the family doing the planning. Dietary constraints are re-remembered from scratch each time, travel time is guessed from a straight-line distance that ignores how a city actually works, and everything between home and the destination is invisible to every search available today. Worse, none of them remember: the gallery everyone loved and the pub nobody did are equally forgotten by next weekend.

This product holds the household's accumulated taste and history — for places to eat, drink and go — and uses it to answer one question well: given where we are going, how long we have, and who is coming, where should we go?

The product succeeds or fails on the richness and relevance of its results. V1 therefore draws on every commercial place, review and event source available rather than picking one early, and measures which ones earn their place.

**V1 deliverables:**

V1 is a complete working product used privately by the founding household before any public release, delivered as an installable web app. It covers the full loop — knowing the family, planning the day, ordering at the venue, and capturing what everyone thought of everywhere they went — because the loop only proves itself when it runs end to end and each outing makes the next recommendation better.

- **Household and members** — an account per household with a record per member covering what they will not eat, what they dislike, what they have come to like across both food and activities, and how long they typically want to spend at a venue and travelling.
- **Combined place data** — restaurants, pubs, bars, cafés, museums, galleries and attractions drawn from several commercial sources at once and presented as one view of each venue, with the value each source adds measured from the first day.
- **Travel-time search** — anywhere worth going, expressed as "within 20 minutes of here" by transit, on foot or driving rather than as a distance, and searchable by a specific dish, drink or kind of activity.
- **What's on** — timed events and permanent attractions returned within the same reach as the places to eat and drink, so an outing can be built around either.
- **Journey planning** — an outing described as leaving at one time and being back by another, with venues surfaced anywhere along the route rather than only at the destination.
- **Day options** — several complete plans for the same day at whatever pace the household wants, recombined into a new plan by talking to the app.
- **Menu capture and ordering** — photographing a menu to get a tappable list with conflicts flagged, and an order summary to show staff that works without a signal.
- **Visit capture and learned taste** — the family saying what they thought of every place they went, by voice or by tapping, feeding back so later recommendations reflect what they actually enjoyed.

**V2 deliverables:**

V2 puts the product in the App Store as a native app, opens it beyond one household, and brings the cost base under control once V1 has shown which sources earn their keep.

- **Native iOS release** — App Store submission and the platform capabilities a web app cannot reach.
- **Android release** — feature parity with iOS.
- **Public beta onboarding** — sign-up and household creation for households outside the founding family, including verifiable parental consent where a household includes a child under 13.
- **Owned place layer** — a permanently-held venue record underneath the licensed sources, reducing repeat lookups.
- **Source rationalisation** — sources that have not demonstrably influenced household choices during V1 are dropped, and pricing revisited. See Section 7 Commercials.
- **Booking hand-off improvements** — deeper integration with reservation providers as partner access is granted.
- **Shared household planning** — more than one adult contributing to and seeing the same plan.

**V3 deliverables:**

V3 turns the household's accumulated history into something worth returning to for its own sake, and makes the captured data searchable.

- **Video memories** — short videos recorded against a visit and stored with it, so returning to a venue years later surfaces the family as they were. The payoff compounds with time, which makes early capture valuable even though the feature only repays later.
- **Visit timeline** — a browsable history of everywhere the household has been, with its photos, videos, items and ratings.
- **Menu search** — discovery driven by items captured from real menus rather than inferred from third-party review text. Gated on the menu copyright review in Section 4.
- **Cross-household recommendations** — ranking informed by ratings across the user base.
- **General availability** — full public launch at full pricing.

---

## 2. As-Is vs To-Be

> Only dimensions that are net new or materially different from the existing process are listed here.

| Dimension | As-Is | To-Be |
|---|---|---|
| Finding somewhere near a fixed commitment | Manual search in a maps app, filtered by eye | Candidates returned for a stated travel time and travel mode |
| Travel reach | Estimated as a distance on a map | Derived from the area actually reachable in the time available |
| Breadth of source data | One app, one provider's view of a venue | Several providers combined into one view, with conflicts resolved |
| Places to eat and things to do | Separate apps, searched separately | Returned together within the same reach, rankable against one another |
| Places between origin and destination | Not surfaced by any available search | Returned along the route, each showing the time its detour adds |
| Planning a day to a time limit | Estimated by hand, typically over-optimistic | Time remaining recalculated against departure and return times as stops are added |
| Deciding how much to fit in | Judged by feel, often over-ambitious | Stated as a pace, with plans built to fill the day accordingly |
| Comparing alternative plans | Each alternative rebuilt from scratch, so rarely done | Several complete plans offered together and recombinable by voice |
| Family dietary constraints | Re-remembered and re-checked at each venue | Held per member and applied automatically to every result |
| Choosing dishes at the table | Reading the menu and asking about ingredients | Menu shown as a list with conflicts flagged against the person affected |
| Recording what was liked | Not recorded, for meals or for anything else | Captured per person for every visit, and reused in later recommendations |

---

## 3. Onboarding Operational Requirements

Tasks that must be completed before the private beta can run.

- **Obtain first-source credentials** — the primary place and routing provider, sufficient to run the first slice. Remaining sources are integrated but not enabled — see Section 7 Commercials for the enablement sequence.
- **Obtain reachable-area credentials** — the transit-capable travel-time provider.
- **Obtain speech transcription credentials** — account and key for the speech provider.
- **Create the household account** — one household with a member record per person.
- **Record dietary constraints per member** — allergens separately from dislikes, since they are treated differently.
- **Record household pace defaults** — typical time spent at a venue and maximum tolerated travelling time.
- **Publish a privacy policy** — required by the place data providers' terms.
- **Set spend caps at every provider** — a per-provider billing cap before any key is used in code.
- **Agree the beta test protocol** — how many outings, over what period, and what constitutes a pass.

---

## 4. Business Constraints

- **Place content cannot be retained** — the licensed place sources permit storing an identifier indefinitely but not the venue's name, rating, hours, or photos. Retention allowances differ by provider, so retained data must carry per-field provenance and per-field expiry.
- **Attribution is mandatory and differs by source** — each provider imposes its own crediting requirements. A combined view must satisfy every contributing source's rules simultaneously.
- **Reviews are capped per venue at every source** — no commercial provider offers a full review corpus for venues the caller does not own. Combining sources raises the ceiling but does not remove it.
- **Search depth is capped per query** — a single search returns a bounded number of candidates per page with bounded pagination. Breadth comes from asking different questions, not from paging further.
- **Along-route results are advisory** — the place source biases and ranks results by the detour they add, but does not guarantee a candidate sits on the supplied route. Detour cost must be shown so the user can judge.
- **Transit catchment has a single viable supplier** — only one provider returns public transport reachable areas from timetabled data. That provider is sales-led, offers a one-time evaluation window, and does not cover every region. This is an accepted single point of dependency on a Critical requirement; it is not grounds for weakening the requirement.
- **Fixed monthly commitments alongside per-call cost** — some review sources carry a monthly floor irrespective of usage. A multi-stop journey multiplies both place lookups and route calculations, and offering several alternative plans multiplies them again. See Section 7 Commercials.
- **Free evaluation allowances differ in kind** — some sources renew a free allowance monthly; others offer a one-time trial that expires on a clock whether used or not. Sources are integrated together but enabled in sequence.
- **No third-party reservation completion** — no reservation provider currently permits a third party to complete a booking through their API. Availability may be surfaced; the booking itself is a hand-off.
- **No child accounts in V1** — a member record for a child is created and owned by an adult member's account. Children have no login and no voice is captured from them. Households containing a child under 13 are supported from public beta, subject to verifiable parental consent — see Appendix B.
- **Voice identification creates biometric exposure** — storing a voiceprint to recognise a speaker engages US state biometric law carrying statutory damages. Speakers are identified by self-announcement, not by stored voiceprint.
- **Menu text is third-party content** — item names are not protectable, but descriptive menu prose is. A household's own captured copy is acceptable; a publicly searchable database is not, pending legal review.
- **Venue connectivity is unreliable** — the ordering flow cannot assume a network connection.
- **Coverage varies by provider and region** — no single provider covers every market the product intends to serve. Source selection is region-dependent.
- **V1 is an installable web app** — native platform releases are V2. See Appendix B.

---

## 5. Behaviour

### Domain concepts

- **Household** — the group planning together, and the unit of account. Owns member records, captured menus, visit history and rating history.
- **Member** — one person in a household, with their own allergens, dislikes, learned preferences, and pace defaults. Members are marked attending or not attending per outing. A member need not have a login.
- **Venue** — anywhere the household goes: a restaurant, pub, bar, café, museum, gallery, park, attraction or event location.
- **Resolved venue** — the single view of a venue assembled from several providers' records of it, carrying per-field provenance.
- **Taste concept** — the normalised idea of something the household can have an opinion about, independent of any one venue's naming. Two kinds: a **dish concept** ("penne all'arrabbiata", "arabiata" and "spicy tomato pasta" resolve to one), and an **experience concept** ("aquarium", "modern art gallery", "live folk music"). Ratings, preferences and search all operate on concepts, not on the source's wording.
- **Trip** — a planned outing with a departure time, a return time, an origin, an optional destination, and an ordered set of stops.
- **Stop** — one venue within a trip, with a planned arrival and a time allowance.
- **Trip option** — one complete candidate plan for the same trip inputs. Several may exist at once; the user picks one or assembles a new plan from parts of them.
- **Visit** — a stop the household actually went to. A visit owns any order placed there, any ratings captured for it, and later its photos and videos. A stop becomes a visit when the household confirms attendance; a trip that is planned and abandoned produces no visits.
- **Intensity** — how fully the household wants the available time filled on a given day. Governs how many stops are proposed, how long each is allowed, and how much slack sits between them.
- **Corridor** — the searchable band along a trip's route. Candidates within it are ranked by the additional travel time their detour adds.
- **Place ledger** — the household's own record of which venues have been shown, saved, dismissed or visited, held as identifiers with household-generated annotations.

### Decision rules

**Catchment derivation**

1. Take the starting point, the maximum travel time, and the travel mode.
2. Derive the area genuinely reachable in that time by that mode, accounting for the transport network rather than assuming uniform speed in all directions.
3. Where the mode is public transport, the derivation reflects timetabled services at the relevant time of day.
4. All candidate venues and events are restricted to this area.

*Rationale: a straight-line radius includes places with no route to them and excludes places a fast service reaches easily.*

**Time budget allocation**

1. Total available time is the return time less the departure time.
2. The intensity setting determines what proportion of that total the plan aims to fill.
3. Subtract the travel time for the planned route, including any detours already added.
4. Subtract the time allowance for each stop, taken from the household default unless overridden.
5. What remains is the unallocated budget, shown to the user.
6. Where the remaining budget is negative, the plan is over its window and the stop causing the overrun is identified.

*Rationale: a plan that cannot be completed in the time stated is worse than no plan, and the overrun is only visible if travel and dwell time are counted together.*

**Preference confidence**

1. A stated preference applies immediately.
2. A learned preference derived from ratings requires a minimum number of rating events against the same taste concept before it influences results.
3. Below that threshold the signal is held but treated as unconfirmed and does not exclude anything.
4. More recent ratings carry greater weight than older ones.

*Rationale: a single bad plate on a bad night, or one wet afternoon at a castle, is not evidence of a preference.*

**Constraint application**

1. An allergen recorded against an attending member excludes a candidate.
2. A dislike recorded against an attending member lowers a candidate's ranking and is surfaced as a reason.
3. Constraints belonging to members not attending are ignored for that outing.

*Rationale: allergens are safety, dislikes are preference, and conflating them makes the product either dangerous or useless.*

**Spend containment**

1. Every outbound provider call is attributed to a household and a session.
2. Calls are bounded per session and per household per billing period.
3. On reaching a bound, the product serves what it already has and tells the user, rather than continuing to call.
4. Repeated identical calls within a session are served from the in-session result set rather than re-issued.

*Rationale: provider content cannot be retained between sessions, so cost scales directly with call volume and a retry loop is a billing event.*

---

## 6. Epics

### Epic 1 — Household, Members & Taste Model

*Problem: recommendations that do not know who is going are no better than a generic search, and a household has no way to tell an app what it already knows about itself.*

**Description:** Creates and authenticates a household, holds each member's constraints, pace defaults and learned preferences across both food and activities, and applies them to every recommendation.

- Separates allergens from dislikes, because one excludes and the other only ranks.
- Learns from every visit, not only from meals, so preferences accumulate for galleries and pubs as readily as for restaurants.
- Gives members without a login — including children — a full profile owned by an adult's account.

#### Workflow

| |
|---|
| User creates a household account and authenticates |
| User adds a member record per family member |
| User records allergens, dislikes, and known likes per member, for food and for activities |
| User records typical visit duration and maximum tolerated travelling time |
| **Decision:** for a given outing, user marks which members are attending |
| System applies attending members' constraints to all discovery |
| Rating events from completed visits update learned preferences over time |
| User may export or delete the household's data at any point |

#### Acceptance Criteria

**CRITICAL**

| # | Given | Then & And |
|---|---|---|
| C1 | A member attending an outing has a recorded allergen | Candidates known to conflict with that allergen are excluded, and the exclusion is attributed to the named member |
| C2 | A member attending an outing has a recorded dislike | Candidates conflicting with it are ranked lower rather than excluded, and the reason is shown against the candidate |
| C3 | A member is marked as not attending | Their constraints have no effect on that outing's results |
| C4 | Fewer rating events exist for a taste concept than the confidence threshold | The signal is retained but does not exclude or strongly rank any candidate |
| C5 | Ratings have been captured for activities as well as meals | Both feed the same preference model, and an activity preference influences activity recommendations as a dish preference influences venue recommendations |
| C6 | Two attending members hold conflicting preferences for the same taste concept | Both are surfaced against the candidate rather than one silently overriding the other |
| C7 | The household has recorded a typical visit duration and a maximum travelling time | Both are applied as defaults when a trip is planned, and either can be overridden for an individual trip without changing the stored default |
| C8 | A member has no login of their own | Their profile is fully usable and is created, edited and deleted only by an authenticated adult member of the household |
| C9 | The household requests its data | Everything the household has generated is exported in a readable form, covering profiles, visits, orders, ratings and captured menus |
| C10 | The household requests deletion | All household-generated data is deleted, not merely excluded from future recommendations, and the deletion is confirmed |

<details><summary>Minor AC ▼</summary>

| # | Given | Then & And |
|---|---|---|
| M1 | A household has one member only | Attendance selection is skipped and that member's constraints always apply |
| M2 | A member has no recorded preferences | Recommendations proceed on the remaining members' constraints without error |
| M3 | A single member is deleted rather than the household | Their profile and rating history are deleted and no longer influence recommendations |
| M4 | No pace defaults have been recorded | Trip planning proceeds using system defaults and prompts the user to set their own |
| M5 | A member's profile is edited | The change applies to the next search performed |

</details>

<details><summary>Q&A — Open ▼</summary>

| Question | Owner |
|---|---|
| What is the minimum number of rating events before a learned preference is treated as confirmed, and does it differ for dishes and experiences? | [Owner: TBC] |
| Over what period does an older rating stop carrying weight? | [Owner: TBC] |
| Are pace defaults held per household or per member? | [Owner: TBC] |
| Which allergen set is canonical, given US and EU regimes recognise different numbers? | [Owner: TBC] |
| What authentication method is used for the household account? | **Answered (owner, 4 Sep 2026).** A single-use magic link, e-mailed to the address the owner enters on the Accounts screen; a session lasts 90 days and only its hash is stored. The owner keeps a passcode (`ROAM_PASSCODE`) as his own way in, so the estate is never locked out by a mail sender that is not configured. No passwords. |

</details>

<details><summary>Engineering Notes ▼</summary>

| Decision | Rationale |
|---|---|
| Learned preferences are stored against taste concepts rather than against venues | A preference transfers to venues the household has never visited; a preference for a venue does not |
| Dish and experience concepts share one model with a type discriminator | The confidence, recency-weighting and conflict rules are identical; splitting them would duplicate the logic |

</details>

---

### Epic 2 — Entity & Concept Resolution

*Problem: the product lives or dies on the richness of its results, but no single provider has the best data everywhere, and combining them means deciding when two providers describe the same venue — and when two differently-worded things are the same dish or the same kind of outing.*

**Description:** Resolves records from several commercial sources into single venues, normalises item and activity names into shared taste concepts, satisfies every contributing source's retention and attribution rules, and measures which sources influence what the household chooses.

- Refuses to merge below a confidence threshold, because a wrong merge is worse than a duplicate.
- Holds provenance and expiry per field, because retention rules differ by provider.
- Records which source surfaced each candidate and which candidate was chosen, so sources can be judged on value rather than kept out of caution.

#### Workflow

| |
|---|
| System queries the enabled sources for a search |
| System resolves returned records into venues, merging only above the confidence threshold |
| **Decision:** where sources conflict on a field, the higher-confidence value is used and the conflict is retained |
| System normalises item and activity names into taste concepts |
| System assembles the combined venue view with per-field provenance |
| System applies each contributing source's attribution requirements to the display |
| System records which sources contributed to each candidate shown, and which candidate the user selects |

#### Acceptance Criteria

**CRITICAL**

| # | Given | Then & And |
|---|---|---|
| C1 | Two or more sources return records for the same establishment | They are presented as one venue rather than as duplicates, and the user is not shown the same place twice |
| C2 | Two records cannot confidently be judged the same establishment | They are presented separately rather than merged, and no merge occurs below the confidence threshold |
| C3 | Sources disagree on a venue's attributes | The displayed value is the higher-confidence one, and the disagreement is retained rather than discarded |
| C4 | A combined venue view is displayed | Every contributing source's required attribution is shown, including author credit where the source demands it |
| C5 | Retained data reaches the expiry permitted by its originating source | It is discarded on that source's schedule independently of data from other sources on the same venue |
| C6 | Two differently-worded items or activities describe the same thing | They resolve to one taste concept, and a rating against either counts toward the same preference |
| C7 | Two items cannot confidently be judged the same taste concept | They remain separate concepts rather than being merged, on the same principle as C2 |
| C8 | Taste concepts have been wrongly merged or wrongly separated | The household can correct the grouping, and existing ratings follow the correction |
| C9 | A candidate is shown and then selected by the user | Both the impression and the selection are recorded against the contributing sources, so each source's influence on real choices can be measured |
| C10 | A source is unavailable, errors, or is disabled in configuration | Results are assembled from the remaining sources, the user is not blocked, and no code change is required |

<details><summary>Minor AC ▼</summary>

| # | Given | Then & And |
|---|---|---|
| M1 | A venue has moved address since a source last updated | The mismatch is surfaced rather than resolved silently |
| M2 | Several distinct businesses share one address, such as a food hall | They are resolved as separate venues |
| M3 | Only one source returns a given venue | It is displayed with that source's attribution alone |
| M4 | A source returns a venue with no reviews | It is displayed with the data available rather than suppressed |

</details>

<details><summary>Q&A — Open ▼</summary>

| Question | Owner |
|---|---|
| What confidence threshold governs whether two venue records are merged, and is it the same threshold for taste concepts? | [Owner: TBC] |
| Which source is authoritative when two disagree on hours or closure? | [Owner: TBC] |
| What evidence from V1 would justify dropping a source at V2? | [Owner: TBC] |
| Do different regions need different default source sets? | [Owner: TBC] |
| How granular should experience concepts be — "museum", or "maritime museum"? | [Owner: TBC] |

</details>

<details><summary>Engineering Notes ▼</summary>

| Decision | Rationale |
|---|---|
| Sources sit behind a single internal interface from the first commit | Sources will be added and removed throughout V1 and V2; the abstraction is cheaper to build now than to retrofit |
| Venue resolution is by fuzzy match on name, address and coordinates, since no shared identifier exists across providers | The major providers share no common venue key — this is the hardest problem in the epic |
| Concept normalisation runs when a menu is parsed or a rating saved, not when a search is run | Search-time normalisation would have to reconcile every historical variant on every query |
| Retained data carries per-field provenance and per-field expiry rather than one cache with one lifetime | Provider retention allowances differ; a single expiry would breach the strictest source — see Section 4 |
| Source attribution logging is built before any source beyond the first is enabled | Without it there is never grounds to remove a source, and every source is kept forever out of caution |

</details>

---

### Epic 3 — Time-Based Discovery

*Problem: "somewhere near the theatre" is a question about time, not distance, and no general-purpose search answers it that way — least of all for things to do rather than places to eat.*

**Description:** Returns venues, attractions and events reachable from a starting point within a stated travel time, ranked against the attending household's preferences.

- Bounds every search by a reachable area rather than a radius, per the catchment rule in Section 5.
- Treats somewhere to go and something to do as equal citizens of the same search.
- Supports searching by a specific dish, drink or kind of activity, with supporting evidence shown against each result.

#### Workflow

| |
|---|
| User sets a starting point and an outing time |
| User sets a maximum travel time and travel mode |
| **Decision:** user chooses places to eat and drink, things to do, or both |
| System derives the catchment |
| System returns resolved venues and events within the catchment, ranked against attending members |
| User views a candidate's detail, supporting evidence, and booking route |
| User saves, dismisses, or asks for alternatives |

#### Acceptance Criteria

**CRITICAL**

| # | Given | Then & And |
|---|---|---|
| C1 | A starting point, maximum travel time, and travel mode are set | Candidates are restricted to the area genuinely reachable in that time by that mode, and no candidate outside it is returned |
| C2 | Public transport is the selected mode in a market with timetabled transit | The reachable area reflects services running at the outing time, and a change to a period of reduced service produces a correspondingly smaller area |
| C3 | The search covers a market where transit data is unavailable | The available travel modes are stated rather than a transit area being estimated |
| C4 | The user asks for alternatives in an area already searched | Venues previously shown to this household in this area are excluded from the new set |
| C5 | The user searches for a named dish, drink or kind of activity | Candidates are matched on it and the evidence that caused each match is displayed against it |
| C6 | Things to do are included in the search | Both permanent attractions and events taking place within the outing window are returned, within the same reachable area and ranked on the same basis as places to eat |
| C7 | A candidate is bookable | A route to the provider's booking page is offered, and the app does not indicate that a booking has been made |
| C8 | More candidates exist than are displayed | Further candidates can be requested without repeating any already shown |
| C9 | A search returns no candidates meeting the attending members' constraints | The reason is stated and the user is offered a wider travel time or a relaxed constraint |
| C10 | A session reaches its call bound | Results already retrieved remain usable, the user is told, and no further provider calls are made in that session |

<details><summary>Minor AC ▼</summary>

| # | Given | Then & And |
|---|---|---|
| M1 | A saved default travel time exists | It is pre-filled and can be overridden for the individual outing without changing the default |
| M2 | The starting point is a venue rather than an address | The search runs from that venue's location |
| M3 | The device has no location permission | The user is asked to enter a starting point manually and search proceeds |
| M4 | The user filters to a venue type such as pubs, cafés or galleries | Only venues of that type are returned within the same catchment |

</details>

<details><summary>Q&A — Open ▼</summary>

| Question | Owner |
|---|---|
| Should the place ledger's "already shown" exclusion expire, and after how long? | [Owner: TBC] |
| How many distinct search formulations should run per user query, given each is separately billed? | [Owner: TBC] |
| Should activity results and food results be ranked in one list or presented separately? | [Owner: TBC] |
| Which event sources are in scope for each launch market? | [Owner: TBC] |
| What are the per-session and per-household call bounds? | [Owner: TBC] |

</details>

<details><summary>Engineering Notes ▼</summary>

| Decision | Rationale |
|---|---|
| Catchment derivation uses the single provider supporting timetabled public transport | No alternative supplier satisfies C2. The dependency is accepted rather than designed around — see Section 4 |
| Result breadth is achieved by issuing several distinct query formulations and deduplicating, not by paging further | Pagination requires every other search parameter to remain identical, so a varied query is a new search regardless |
| The place ledger holds identifiers and household annotations only | Retention of place content beyond identifiers is not permitted under the sources' terms — see Section 4 |

</details>

---

### Epic 4 — Journey & Trip Planning

*Problem: an outing is a journey with time to fill, but every available search treats it as a single destination and makes everything in between invisible.*

**Description:** Plans an outing as a trip between a departure time and a return time, surfacing candidates along the whole route as well as at the destination, and keeping the accumulating plan inside its time window.

- Treats the route itself as searchable, so the choice of where to stop is not confined to the destination area.
- Shows what each candidate costs in added travel time, so a detour is a visible decision.
- Recalculates the remaining time as stops are added, using the household's pace defaults from Epic 1.

#### Workflow

| |
|---|
| User sets an origin, a departure time and a return time |
| User sets a destination, or leaves the trip open-ended |
| User confirms the travel mode |
| System calculates the route and the time remaining after travel |
| **Decision:** user searches at the destination, along the route, or both |
| System returns candidates ranked by detour cost and household preference |
| User adds a candidate as a stop |
| System recalculates the remaining time and warns if the window is exceeded |
| User reorders or removes stops until the plan fits |

#### Acceptance Criteria

**CRITICAL**

| # | Given | Then & And |
|---|---|---|
| C1 | An origin, departure time and return time are set | The time remaining after travel is calculated and displayed before any candidate is offered |
| C2 | The user searches along the route | Candidates away from the destination are returned, and each displays the additional travel time its detour adds |
| C3 | A candidate is added as a stop | The remaining time is recalculated to include travel to and from that stop as well as its time allowance |
| C4 | The accumulated plan exceeds the stated return time | The user is warned, and the stop causing the overrun is identified |
| C5 | A stop is added without an explicit time allowance | The household default for that kind of stop is applied and can be overridden for this trip |
| C6 | The household's maximum tolerated travelling time would be exceeded | The plan is flagged as exceeding it, and the total travelling time is shown |
| C7 | A trip contains more than one stop | The stops are presented in a workable order and the user can reorder them, with times recalculated on reorder |
| C8 | The stops added cannot fit the window in any order | The user is told, and offered a later return time or the removal of a named stop |
| C9 | The trip has no destination other than its origin | Discovery falls back to catchment search from the origin, per Epic 3 |

<details><summary>Minor AC ▼</summary>

| # | Given | Then & And |
|---|---|---|
| M1 | The departure or return time is changed after stops have been added | Remaining time is recalculated for the whole plan |
| M2 | A stop is removed | Remaining time is recalculated and any previous overrun warning is cleared if resolved |
| M3 | The travel mode is changed during planning | The route and all times are recalculated, and any stop no longer reachable within the window is flagged |
| M4 | A candidate sits further from the route than the user expects | Its detour time is displayed so the user can dismiss it on that basis |

</details>

<details><summary>Q&A — Open ▼</summary>

| Question | Owner |
|---|---|
| How far off the direct route should a candidate be allowed to sit before it is not worth showing? | [Owner: TBC] |
| Should the plan include buffer time between stops, and if so how much? | [Owner: TBC] |
| Can a trip span more than one day? | [Owner: TBC] |
| Should the outbound and return legs be searchable separately? | [Owner: TBC] |
| Should a trip be saved and reopened later, or discarded once the outing is over? | [Owner: TBC] |

</details>

<details><summary>Engineering Notes ▼</summary>

| Decision | Rationale |
|---|---|
| Along-route discovery uses the place source's native route-biased search, ranking candidates by the minimum detour they add between origin and destination | This is the correct ranking semantic and avoids building corridor geometry and detour scoring from scratch |
| The corridor is a bias, not a restriction — displayed detour cost is mandatory | The provider does not guarantee returned candidates sit on the supplied route — see Section 4 |
| Each added stop triggers a route recalculation | Trip cost scales with the number of stops as well as the number of searches |

</details>

---

### Epic 5 — Trip Options & Assembly

*Problem: there is rarely one right plan for a day, and comparing alternatives by rebuilding each from scratch is more work than anyone will actually do.*

**Description:** Offers several complete plans for the same day at a pace the household chooses, and lets the user assemble a new plan by taking parts of the ones on offer.

- Lets the household say how full they want the day to be, rather than how many stops they want.
- Produces options that differ from each other on a stated basis, not variations on one ranking.
- Accepts spoken instructions to combine stops from different options into a new plan.

#### Workflow

| |
|---|
| User sets the intensity for the day |
| System retrieves one candidate pool for the trip inputs |
| System composes several complete options from that pool within the time window |
| User compares the options |
| **Decision:** user accepts one option, or assembles a new plan from parts of several |
| User states which stops to take from which options, by voice or by selection |
| System assembles the new plan and re-validates it against the time window |
| System reports any conflict and offers the nearest workable plan |
| User accepts the assembled plan as the active trip |

#### Acceptance Criteria

**CRITICAL**

| # | Given | Then & And |
|---|---|---|
| C1 | An intensity is set | Proposed plans fill a correspondingly greater or lesser proportion of the available time, and the same intensity on a longer day produces a fuller plan rather than the same number of stops |
| C2 | Intensity is set at its lowest | Plans contain fewer stops, with longer time allowances and more slack between them |
| C3 | Several options are generated for the same trip inputs | All are composed from one candidate pool retrieved once, and generating additional options issues no further provider calls |
| C4 | Several options are presented | Each differs from the others on a stated basis, and that basis is shown to the user |
| C5 | The user selects stops drawn from more than one option | A new plan is assembled containing exactly the selected stops |
| C6 | An assembled plan does not fit the time window | The user is told which combination causes the conflict, and offered the nearest plan that does fit |
| C7 | The user states their selection by voice | The instruction is interpreted against the stops in the options currently displayed, and the result is presented for confirmation before the plan changes |
| C8 | An assembled plan is accepted | It becomes the active trip and behaves as any other trip, per Epic 4 |
| C9 | No plan can be built at the chosen intensity within the window | The user is told, and offered a lower intensity or a longer window |

<details><summary>Minor AC ▼</summary>

| # | Given | Then & And |
|---|---|---|
| M1 | Only one viable plan exists for the inputs | It is presented as a single option rather than padded out with near-identical alternatives |
| M2 | Intensity is changed after options have been generated | Options are recomposed from the existing candidate pool where the pool still supports the new intensity |
| M3 | A stop appears in more than one option and is selected once | It appears once in the assembled plan |
| M4 | A spoken instruction does not identify which option a stop is taken from | The user is asked which one before the plan is changed |

</details>

<details><summary>Q&A — Open ▼</summary>

| Question | Owner |
|---|---|
| How many options should be offered at once? | [Owner: TBC] |
| On what basis should options differ — geography, theme, pace, or a mix? | [Owner: TBC] |
| Should intensity have a stored household default? | [Owner: TBC] |
| Can intensity vary across a single day? | [Owner: TBC] |
| Should an assembled plan be saveable as a template? | [Owner: TBC] |

</details>

<details><summary>Engineering Notes ▼</summary>

| Decision | Rationale |
|---|---|
| Intensity is expressed as a target proportion of available time, not as a stop count | A stop count tuned for a four-hour window produces an absurd plan in a ten-hour one |
| Voice instruction interpretation is constrained to the stops present in the options on screen | Matching against a closed set is far more reliable than open interpretation |

</details>

---

### Epic 6 — Menu Capture & Ordering

*Problem: at the table, the menu is the only source of truth about what is actually available, and it is not available in any digital form.*

**Description:** Turns a photographed menu into a tappable list, flags conflicts against attending members, and produces an order summary to show to staff.

- Presents the parsed menu for correction before it is used, since venue lighting and folded menus produce imperfect reads.
- Flags items conflicting with an attending member's allergen at the point of ordering.
- Works without a network connection once the menu has been captured, and reconciles cleanly when the connection returns.

#### Workflow

| |
|---|
| User photographs the menu |
| System presents the parsed items, sections and prices for review |
| User corrects errors or adds further pages |
| System flags items conflicting with attending members' allergens |
| User selects items per member and attaches any modifications |
| System displays the order summary |
| User shows the summary to staff |
| **Decision:** on reconnect, system reconciles the offline order against the visit |

#### Acceptance Criteria

**CRITICAL**

| # | Given | Then & And |
|---|---|---|
| C1 | A menu has been photographed | The extracted items, sections and prices are presented as an editable list before the menu can be used for ordering |
| C2 | A menu spans more than one page or board | Further photographs can be added to the same menu and their items appear in the same list |
| C3 | A parsed item conflicts with an attending member's recorded allergen | The item is flagged, and the flag names both the member and the allergen |
| C4 | The device loses network connection after a menu has been captured | The captured menu and the order in progress remain usable, and the order summary can still be displayed |
| C5 | Connection returns after an order was created offline | The order is reconciled against the visit exactly once, and no duplicate visit or duplicate order is created |
| C6 | An item has been selected for a member | A free-text modification can be attached to it and appears against that item on the order summary |
| C7 | An order has been completed | The summary displays each item against the member who ordered it, and the order is attached to the visit |
| C8 | A captured menu is displayed after the staleness threshold has passed | Its capture date is shown and its prices are marked as indicative |
| C9 | The menu photograph cannot be read | The user is told which part failed and offered a retake or manual entry, rather than an empty list |
| C10 | A venue has separate food and drink menus | Both can be captured against the same visit and appear on one order summary |

<details><summary>Minor AC ▼</summary>

| # | Given | Then & And |
|---|---|---|
| M1 | An item is edited during review | The corrected text is used for ordering and for any subsequent rating |
| M2 | The same venue's menu is captured again | The new capture supersedes the previous one and the previous one is retained against past visits |
| M3 | An order contains no items | The summary is not offered |
| M4 | A member attending has no item selected | The summary shows them with no order rather than omitting them |

</details>

<details><summary>Q&A — Open ▼</summary>

| Question | Owner |
|---|---|
| What is the staleness threshold after which menu prices are marked indicative? | [Owner: TBC] |
| Should allergen inference from an item description be shown as certain or as a prompt to check with staff? | [Owner: TBC] |
| Does the order summary need a printed or shareable form? | [Owner: TBC] |
| Is legal review needed before captured menus are retained beyond the capturing household? | [Owner: TBC] |

</details>

<details><summary>Engineering Notes ▼</summary>

| Decision | Rationale |
|---|---|
| The captured menu and in-progress order are held on the device and reconciled on reconnect | Venue connectivity cannot be assumed — see Section 4 |
| Offline orders carry a client-generated identifier used for reconciliation | Without one, a retry after a failed sync produces a duplicate visit |

</details>

---

### Epic 7 — Visit Capture & Rating

*Problem: the opinion that matters most is formed in the twenty minutes after leaving, applies to everywhere the family went and not only where they ate, and is lost unless capturing it is almost effortless.*

**Description:** Records that a stop became a visit, and captures what each attending member thought of it — every item where there was an order, and the place itself where there was not — by voice or by direct entry.

- Rates any visit, whether or not a menu was captured there, so galleries and parks accumulate opinion as readily as restaurants.
- Matches spoken comment against what is known about the visit rather than transcribing without context.
- Identifies speakers by self-announcement rather than by stored voiceprint.

#### Workflow

| |
|---|
| User confirms the household attended a planned stop, creating a visit |
| User starts rating for the visit |
| **Decision:** user speaks a review or enters ratings directly |
| System transcribes the spoken review and maps it to members, and to items where an order exists |
| System presents the mapped result for confirmation |
| User corrects attribution or scores |
| System saves ratings against taste concepts and discards the recording |

#### Acceptance Criteria

**CRITICAL**

| # | Given | Then & And |
|---|---|---|
| C1 | The household confirms attendance at a planned stop | A visit is created against that venue, carrying the date, the attending members, and any order placed there |
| C2 | Rating is started for a visit with a recorded order | Both the items on that order and the visit as a whole can be rated |
| C3 | Rating is started for a visit with no order, such as a museum or a walk | The visit itself can be rated with no loss of function, and the rating is attributed to the experience concept for that venue |
| C4 | A spoken review has been captured | The transcript is mapped to the attending members, and to items where an order exists, and presented for confirmation before anything is saved |
| C5 | Attribution of a comment to a member is uncertain | The user is asked to confirm which member it belongs to rather than a member being assigned silently |
| C6 | A spoken review contains descriptive comment beyond a score | The comment is retained against the taste concept and is available to later recommendations |
| C7 | A recording has been transcribed | The audio is discarded and not retained after the rating is saved |
| C8 | Voice capture is declined, unavailable, or fails | Rating can be completed by direct entry with no loss of function |
| C9 | A member is identified during voice capture | Identification is by that member announcing themselves, and no voiceprint is stored |
| C10 | A rating is saved | It is attributed to the taste concept as well as to the specific venue, so it transfers to venues the household has not visited |

<details><summary>Minor AC ▼</summary>

| # | Given | Then & And |
|---|---|---|
| M1 | A spoken review mentions an item nobody ordered | The unmatched comment is surfaced for the user to assign or discard rather than being dropped |
| M2 | Only part of a visit is rated | What was rated is saved and the remainder left unrated |
| M3 | A rating is saved and then edited | The revised rating replaces the original in preference calculations |
| M4 | Rating is started some days after the visit | The visit and any order are still available and rating proceeds normally |
| M5 | The household went somewhere that was never a planned stop | A visit can be created directly and rated in the same way |

</details>

<details><summary>Q&A — Open ▼</summary>

| Question | Owner |
|---|---|
| Is voice capture offered at the venue, after leaving, or both? | [Owner: TBC] |
| Is transcription performed on the device or by a service, and does that change the consent wording? | [Owner: TBC] |
| Should a visit be created automatically from location, or always confirmed by the user? | [Owner: TBC] |
| Should a whole-day rating be captured in addition to per-visit ratings? | [Owner: TBC] |

</details>

<details><summary>Engineering Notes ▼</summary>

| Decision | Rationale |
|---|---|
| Transcript interpretation is constrained to the known attending members and, where present, the known ordered items | Matching against a closed set is substantially more reliable than open transcription, particularly in venue noise |
| Speaker identification is by self-announcement; no voiceprint is enrolled or stored | Storing a voiceprint engages US state biometric law carrying statutory damages — see Section 4 |
| The visit is the join between the rented and owned layers: it holds a venue identifier plus wholly owned content | Everything attached to a visit — order, ratings, later photos and video — is household-generated and free of retention constraints |

</details>

---

## 7. Commercials

The product is intended as a premium paid subscription. Result quality is the differentiator, so every commercial source that might contribute is integrated during V1 rather than cost being optimised early, and operating at a loss through beta is accepted.

**Subscription**

A paid household subscription covering all members. Price positioning is expected to rise over time as the accumulated history makes the product more valuable to an established household.

**Pricing:** TBC. To be set once V1 source costs are measured against source value, per Epic 2.
**Trial:** TBC.

**Source cost base and enablement sequence**

Sources carry a mix of recurring monthly floors and per-call charges. Some free allowances renew monthly and can be relied on indefinitely; others are one-time trial windows that expire on a clock whether used or not.

All sources are integrated behind the single interface in Epic 2, but **enabled in sequence**: sources with renewing allowances first, sources with expiring trials only when a defined comparison is ready to run against them.

**Pricing:** see Technical Constraints v3.0 §11 and §12 for the current rate card, free allowance inventory, enablement order and worked session costs.

**Source rationalisation [V2]**

Sources that have not demonstrably influenced household choices during V1 are candidates for removal, with subscription pricing revisited once the cost base settles. See Appendix B.

---

## 8. External Data Architecture

The product depends on third-party sources for place, review, routing, travel-time, event and speech data. Retention allowances differ by provider and none permits holding display content indefinitely. The architecture therefore separates what is rented from what is owned.

- **Rented layer** — venue detail, ratings, reviews, event listings and route calculations from several providers, fetched at the point of display and held only for the period each provider permits, with per-field provenance.
- **Owned layer** — household accounts, member profiles, pace defaults, the place ledger, captured menus, taste concepts, trips, visits, orders and rating history. This data has no third-party retention constraint and accumulates with use.
- **Derived layer** — catchments, corridors, time budgets, candidate pools, trip options, resolved venues and recommendation rankings, computed per request from both of the above.

The visit is the join between the two: it holds a venue identifier from the rented layer and everything else about that outing from the owned layer.

The constraints governing the rented layer are listed in Section 4 and detailed in the companion technical document. The behaviour of the owned layer is specified in Epics 1, 6 and 7; the derived layer in Epics 2, 3, 4 and 5.

---

## Appendix A: Open Questions

| Ref | Topic | Detail | Owner |
|---|---|---|---|
| A1 | Ownership | Every Q&A owner in this document is currently unassigned and needs a named individual | [Owner: TBC] |
| A2 | Name clearance | Confirm the working title is clear on App Store name availability and trademark in the US and other launch markets | [Owner: TBC] |
| A3 | Supplier dependency | Transit catchment has one viable supplier, sales-led with a one-time evaluation window. Agree commercial terms, or accept the concentration risk knowingly | [Owner: TBC] |
| A4 | Cost model | What monthly loss is acceptable through beta, and what subscription price would recover the source cost base at scale? | [Owner: TBC] |
| A5 | Spend bounds | What are the per-session and per-household call bounds, and what does the product do on reaching them? | [Owner: TBC] |
| A6 | Launch markets | Which markets beyond the US at launch, and what source coverage exists in each? | [Owner: TBC] |
| A7 | Success criteria | What outcome from the private beta justifies proceeding to public beta? | [Owner: TBC] |

---

## Appendix B: V2 Requirements Summary

V2 puts the product in the app stores, opens it beyond one household, and brings the cost base under control once V1 has shown which sources earn their keep.

- **Native iOS release** — App Store submission, privacy disclosures, and the platform capabilities a web app cannot reach.
- **Android release** — feature parity with iOS.
- **Public beta onboarding** — sign-up and household creation beyond the founding family. Households containing a child under 13 require verifiable parental consent to a defined legal standard; an in-app confirmation does not meet it. This is the gate on supporting child members outside the founding household.
- **Owned place layer** — a permanently-retainable venue record from a source whose licence permits storage, sitting underneath the licensed sources.
- **Source rationalisation** — sources removed on the evidence gathered by Epic 2, with subscription pricing revisited. See Section 7 Commercials.
- **Reservation provider integration** — availability and booking hand-off deepened as partner access is granted.
- **Shared household planning** — multiple adults contributing to and viewing the same outing.

---

## Appendix C: V3 Requirements Summary

V3 turns the household's accumulated history into something worth returning to for its own sake, and makes the captured data searchable.

- **Video memories** — short videos recorded against a visit and stored with it, so returning to a venue years later surfaces the family as they were. Storage cost grows monotonically and never falls; cost this before committing.
- **Visit timeline** — a browsable history of everywhere the household has been, with its photos, videos, items and ratings.
- **Menu search** — discovery driven by items captured from real menus rather than inferred from third-party review text. Gated on the menu copyright review in Section 4.
- **Cross-household recommendations** — ranking informed by ratings across the user base.
- **General availability** — full public launch at full pricing.

---

## Appendix D: Source References

Research underpinning the constraints in Section 4 and the decisions in the Engineering Notes is held in the companion document, **Technical Constraints & API Reference v3.0**, which carries the full source index, rate cards, retention comparison, entity resolution detail, legal register and open verification items.
