# Roam — data and imagery

| | |
|---|---|
| **Version** | v1.0 |
| **Date** | 5 September 2026 |
| **Status** | Governing for anything that fetches, stores or shows third-party content |
| **Companion to** | Technical Constraints §4 (retention), §13.10 (owned places), §13.12 (the atlas), §15 (licensing register) |

> Written because the estate now holds content rather than identifiers, and the rules that make that safe live in several heads and one or two commit messages. Nothing here is legal advice.

---

## 1. The one rule

**Everything Roam shows is either rented or owned, and the two are never mixed in a stored record.**

- **Rented** is somebody else's product. We may look at it, show it to a household while they are looking, and then we must let go of it. Google's names, photographs, ratings and reviews are rented. So are Tripadvisor's and Yelp's.
- **Owned** is what we may keep for good: open data, openly licensed pictures, a business's own published facts, and everything a household generates.

The test for any new field is one question: **if this provider ended our contract tonight, would this row still be true and still be ours?** If not, it does not get written down.

This is not caution for its own sake. A product built on stored rented content is one contract change away from having to delete its own database, and the deletion is not the worst part — the worst part is that a competitor signing up for the same API has exactly the same thing. What we own compounds; what we rent does not.

---

## 2. The sources ledger

What we use today, what it lets us keep, and what it costs.

| Source | What we take | Licence | May we keep it? | Cost |
|---|---|---|---|---|
| **Wikidata** | What a place is, where, how notable, visitors a year, operator | CC0 | Yes, outright | Free, no key |
| **Wikipedia** | The description, and article sections for what there is to do | CC BY-SA 4.0 | Yes, with credit and a link | Free, no key |
| **Wikimedia Commons** | Photographs | Per file — CC0, PD, CC BY, CC BY-SA | **Only if the file's own licence permits.** Checked per file, twice | Free, no key |
| **Wikipedia pageviews** | How many people look a place up | CC0 | Yes | Free, no key |
| **OpenStreetMap** | Names, positions, tags, what is inside a place's grounds | ODbL, attribution required | Yes, indefinitely | Free, no key |
| **The venue's own site** | Hours, phone, address, price band, booking link (schema.org) | Published for republication | Yes — these are facts a business publishes in order to be found | Free |
| **Google Places** | **That a place exists, and its place ID** | Google Maps Platform terms | **Place ID only.** Coordinates 30 days. Names, photos, ratings, reviews: never | $0.032/request past 5,000 free a month |
| **Foursquare OS Places** | Bulk venue index | Apache 2.0 | Yes, everything, indefinitely | Free — needs a HuggingFace token, dataset is gated |

Everything above the Google row needs no account and no key. That is deliberate: the parts of Roam that must never stop working are built only on those.

---

## 3. What we are doing

### 3.1 Places — three layers, in order of preference

1. **Wikidata and Wikipedia** give us the notable places: the castles, museums, cathedrals, country parks. ~2,000 across the UK at 18 a county, more where we deepen. Every one carries a description we may keep and a photograph we own.
2. **OpenStreetMap** gives us the outdoors: parks, nature reserves, lakes, woods, playgrounds. Free and ours.
3. **Google Places** gives us the rest — and only the *existence* of the rest. Soft play, trampoline parks, karting, flying lessons, farm parks. None of this is in Wikipedia, because none of it is notable, and notability is the only thing an encyclopedia sorts on. `leisure=indoor_play` is 3,414 objects in the whole of OpenStreetMap.

**How layer 3 stays legal.** The sweep asks Google what exists, holds the answer in memory, looks each result up in OpenStreetMap, and writes the *OpenStreetMap* record. Where a match is found the place becomes ours outright. Where none is, we keep the place ID and the fact that something is there, and the row is marked `display_source = 'google'` — meaning its name and picture must be fetched live at display and are never written down.

That is the same pattern §13.10 already established: the rented answer is "a description of what to go and find", never the thing that gets kept.

### 3.2 Ranking

Composed only from things we own: Wikipedia readership over twelve months, Wikidata sitelinks, published visitor counts, whether somebody operates it, whether it has an official website, heritage designation. The working is stored on the row, because "why is this fourth" is the first question anybody asks of a ranked list.

Readership is measured **against the best-read place in the same region**, which is what stops a log scale flattening a threefold difference in interest into three points of a hundred. A score comparable within a region is not comparable between them, so anything ranking across regions damps by distance.

### 3.3 Ratings

There is no free, storable source of star ratings. Not OpenStreetMap, not Wikidata, and not Google, Tripadvisor or Yelp, all of which forbid keeping them. Three honest layers, in order:

1. **Popularity we own** — readership, visitor figures. This answers *"is this a big deal"*, not *"is it any good"*, and it should never be presented as a rating.
2. **A licensed star, fetched at display and shown as a band** — `top` / `high` / `good` / `mixed`. A dozen different ratings map to each band, so the band cannot be read backwards into the figure behind it. Never written down.
3. **The household's own ratings**, which Roam already collects and owns outright. Over time this is the only rating that is genuinely ours.

### 3.4 Imagery

- **Attractions**: Wikimedia Commons, licence-checked per file. The file's own terms decide: CC0, public domain, CC BY, CC BY-SA and OGL may be stored; anything non-commercial, no-derivatives or carrying a `Restrictions` note is refused whatever its copyright says.
- **Every stored picture carries its own terms on the same row** — the licence, the deed URL, the photographer, the page that states both, and whether a credit is required.
- **Three widths held** (20px, 500px, 960px). The 20px is a placeholder inlined into the JSON as a data URI, so the first paint owes nothing to the image network.
- **Household uploads**: schema built, camera flow not. Nothing publishes without a person approving it. Rewards are points, never money.

---

## 4. What we are not doing

**Scraping.** Functional, and it breaches every source's terms. Not viable for a paid product, and it is how small travel apps die.

**Storing Google's content.** Not the names, not the photographs, not the ratings, not the reviews, not for a day. The place ID and nothing else.

**Taking a business's photographs from its website.** `site.js` reads a venue's published *facts* — hours, phone, price band — because a business publishes those in order to be found. Its photographs are a different thing and are still its copyright.

**Guessing an image from proximity.** Tested and rejected. Wikimedia geosearch finds something within 150m of almost anywhere in England, and a name test on top still gave "South Ascot Playing Field" a photograph of a car park, then of All Souls church; "Sunningdale Park" the National School of Government; "Bog Lane Play Area" a photograph of the lane. About 57% precision. On a card that prints the place's name underneath, that is not a hit rate, it is a lie rate.

**Showing a photograph without its credit where one is required.** The licence is not satisfied by holding the credit in a database.

**Presenting a picture as being of a place when it is not.** Including a generic category image dressed as the venue.

---

## 5. How we protect ourselves

Rules that live only in a document get broken. These live in code.

| Mechanism | Where | What it stops |
|---|---|---|
| **Licence allow-list** | `sources/wikimedia.js` | An image is storable only if its licence matches a known-good pattern. A deny-list would let through the one nobody thought of |
| **`may_store` checked twice** | `wikimedia.js`, `repositories/library.js` | `saveImage()` throws on a row whose licence was not read and did not permit storage. The check at the write is the one that holds when the check at the read is bypassed |
| **`Restrictions` refusal** | `sources/wikimedia.js` | A freely licensed photograph of a trademarked building is still not ours to put on a card |
| **The offline policy** | `web/src/offline/policy.ts` | An endpoint not named there is never written to a device. New endpoints must be thought about rather than inherited |
| **`display_source`** | `attractions` | Marks a row whose name came from a provider, so it is fetched live and never stored |
| **Banded ratings** | `sources/google.js` | The raw rating never leaves the loop it was fetched in |
| **`provider_calls`** | every provider adapter | Every outbound call attributed to a household and session, so spend is attributable and a source can be switched off with evidence |
| **Per-field provenance and expiry** | `place_facts` | Retention differs by provider; a single cache TTL breaches the strictest one |
| **Attribution on the row** | `image_assets`, `attractions` | The credit travels with the content instead of being reconstructed by a screen |

---

## 6. Adding a source — the checklist

1. **Read the terms and write down what may be retained**, per field, with a date. Add it to §4 of Technical Constraints.
2. **Decide rented or owned.** If rented, what is the pointer we may keep, and what must be fetched live?
3. **Add it to `provider_calls`** before it is enabled. A source with no call log cannot be removed later on evidence.
4. **Add its attribution line**, and make it travel with the content.
5. **Decide the offline answer** in `offline/policy.ts`. The default is "not stored".
6. **If it costs money**: a free allowance, a ceiling, and a figure in `sources/pricing.js`. The owner sets the spend cap, not the code.

---

## 7. What is outstanding

- **Household upload flow** — schema exists, camera does not. Before it ships: the licence grant a household gives Roam, recorded with the file; a bystander rule (a photograph of a playground contains other people's children); a takedown route.
- **Foursquare OS Places** — the storable bulk index. Gated; needs a token.
- **Soft play imagery** — no free licensed source exists. The realistic routes are operator uploads, household uploads, or honestly-labelled category imagery.
- **A rated source with storable ratings** — none found. Assume there isn't one.
