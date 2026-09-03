# Roam — UX Research: Best-in-Class Patterns for Every V1 Capability

| | |
|---|---|
| **Version** | v1.0 |
| **Date** | 3 September 2026 |
| **Status** | Research — precedes prototype work |
| **Companion to** | Requirements v5.0, Technical Constraints v3.0 |
| **Scope** | US-primary product, installable web app on iOS for V1 |

> This document collects what the best US consumer products do for each capability Roam surfaces, what published research says about why those patterns work, and what that means for Roam specifically. Every claim that came from a source is linked. Where the research is thin — and for some of Roam's ideas there is no direct precedent — that is said plainly, and the recommendation is marked as ours rather than the industry's.
>
> It is organised by capability, in the order a household meets them: platform reality first, then setting up, finding, planning, choosing between plans, being at the venue, capturing what everyone thought, and — ahead of V3 — video. It closes with cross-cutting principles, an accessibility floor, and the decisions the research forces before prototyping.

---

## Contents

1. Executive summary — the ten findings that change the design
2. Platform reality: an installed web app on iOS
3. Household, members, defaults and preferences (Epic 1)
4. Time-based discovery, catchments and evidence (Epic 3)
5. Along the route and the time budget (Epic 4)
6. Trip options and assembly, by touch and by voice (Epic 5)
7. Menu capture, ordering and offline (Epic 6)
8. Visit confirmation and rating capture (Epic 7)
9. Voice recording as a first-class input
10. Video snippets — designing ahead for V3
11. Explaining recommendations and calibrating trust
12. Accessibility and inclusion floor
13. Cross-cutting design principles for Roam
14. What this research changes in the requirements
15. Prototype implications, by screen
16. Source index

---

## 1. Executive summary — the ten findings that change the design

1. **Stars are the wrong instrument for a personal taste model.** Netflix replaced stars with thumbs and saw a 200% increase in rating activity, because stars measure aggregate quality while thumbs teach a personal model ([Netflix](http://about.netflix.com/en/news/goodbye-stars-hello-thumbs)). Apple Maps chose thumbs up/down with separate aspects and only from verified visitors ([BrightLocal](https://www.brightlocal.com/blog/apple-maps-ratings/)). Letterboxd runs two signals — stars for quality, a heart for personal enjoyment — and its recommendation engine is driven by likes, not stars ([Five Star Insider](https://www.fivestarinsider.com/heart-button-letterboxd/)). Scale design itself distorts data: Letterboxd users avoid half-stars and rate more harshly than IMDb users on an equivalent 10-point scale ([Datawrapper](https://www.datawrapper.de/blog/movie-reviews-rating-scales)). Beli avoids absolute scores entirely and derives a 0–10 from pairwise "better or worse than" comparisons ([Today](https://www.today.com/food/trends/what-is-beli-app-rcna217748)). **Roam should capture a per-person binary-plus-comment signal (loved / not for me, with the "why"), not a star.**

2. **Voice needs a screen, and the screen needs a closed set.** NN/g's study of Siri, Alexa and Google Assistant found comparison tasks "nearly impossible" by voice alone, that users could not verify results (including whether restaurants actually lay along their route), and that the fix is on-screen options and visual verification ([NN/g intelligent assistants](https://www.nngroup.com/articles/intelligent-assistant-usability/)). Google's conversation design guidance: explicit confirmation is *rare* and reserved for high-cost misunderstandings; support one-step corrections ([Google](https://developers.google.com/assistant/conversation-design/confirmations)). Roam's requirement that voice is interpreted against known attendees and known items (Epic 7) and known stops on screen (Epic 5) is exactly the mitigation the research points to.

3. **Drag-and-drop itinerary building fails in testing; regenerate-and-swap wins.** A trip-planner team found every tester reaching the organiser screen asked "what am I looking at?" ([Tripping case study, via search](https://medium.com/travel-itinerary-app/tripping-itinerary-planner-ux-case-study-1567dbd9e35d)). Google Trips built whole days at a stated pace with a "magic wand" that regenerated the plan ([Google](https://blog.google/products/travel/see-more-plan-less-try-google-trips/)); Mindtrip swaps stops by asking in language ([Layla comparison](https://layla.ai/blog/ai-travel-planners-comparison)). Roam's "options differ on a stated basis, assemble by selection or voice" is the right shape; it should not lead with freeform drag-and-drop.

4. **Detour cost must be a number on every card.** Google's search-along-route defines detour as two legs minus the direct route and surfaces it as "+5 min" ([Google Maps Platform](https://developers.google.com/maps/documentation/places/web-service/sar-overview)); Apple Maps lets you add up to 14 stops by category with a "Resume Route" escape ([Apple Support](https://support.apple.com/guide/iphone/find-stops-along-your-route-iph837d13d03/ios)). The requirement (Epic 4 C2) is already aligned; the research says make it the *first* number on the card, ahead of rating.

5. **Explanations must be tied to the user's own data and shown as reasons, not scores.** Google Maps' "Your Match" gives a 0–100 with the reasons behind it ([GSMArena](https://www.gsmarena.com/google_maps_adds_a_personalized_match_score_for_places_makes_group_outings_easier_to_organize-news-30937.php)); PAIR recommends categorical confidence or n-best alternatives over raw percentages, and partial explanations focused on what affects the decision ([Google PAIR](https://pair.withgoogle.com/chapter/explainability-trust/)). Roam already has per-member reasons ("Ada dislikes barbecue") — that is the strongest form of explanation available anywhere, because it names a person the user knows.

6. **Allergens and preferences must never share a control.** Allergen apps that work name the specific ingredient ("almond, cashew" not "tree nuts") and check only the user's own allergens to avoid alarm fatigue ([Foods Connected](https://blog.foodsconnected.com/the-best-food-allergy-apps-and-how-they-work)). Baymard's 2026 food-delivery benchmark found dietary needs had "no supported path at any decision point" on any major US app ([Baymard](https://baymard.com/blog/food-delivery-and-takeout-ux-benchmark-2026)). This is an open goal: nobody in the US market does it well.

7. **Ask right after, not later; never on launch.** Uber prompts immediately after the ride; asking on app launch raises the chance of closing the app by 50%; a conversational ask is 5–10× more effective than a bare rating request ([Alchemer](https://www.alchemer.com/resources/blog/ratings-prompts-when-and-how-to-ask-for-an-app-rating-2/), [AppFollow](https://appfollow.io/blog/how-to-ask-for-app-reviews)). Etsy deliberately waits a week for considered reviews ([Smashing](https://www.smashingmagazine.com/2023/01/product-reviews-ratings-ux/)). Roam should do both: a light in-the-moment capture on leaving, and a fuller debrief later that day.

8. **Visits should be suggested, then confirmed — on-device, opt-in.** Apple Journal groups photos, visits and workouts into suggested "moments", ranked under Recommended/Recent, with per-data-type privacy toggles and on-device processing ([MacStories](https://www.macstories.net/reviews/apples-journal-app-journaling-for-all/), [Apple](https://www.apple.com/newsroom/2023/12/apple-launches-journal-app-a-new-app-for-reflecting-on-everyday-moments/)). iOS 26 Apple Maps "Visited Places" is opt-in and end-to-end encrypted ([AppleInsider](https://appleinsider.com/inside/apple-maps/tips/inside-apple-maps---how-to-get-the-most-out-of-your-iphones-navigation-app)). Roam's "a stop becomes a visit when the household confirms" matches the pattern users now expect; V1 (web) can't do background location, so the confirmation is a prompt, not a detection.

9. **The installed web app on iOS carries UX consequences that must be designed for, not discovered.** Camera/microphone permission is re-requested on each application load ([Scandit](https://support.scandit.com/hc/en-us/articles/360008443011-Why-does-iOS-keep-asking-for-camera-permissions)); there is no install prompt API — installation is Share → Add to Home Screen ([MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)); storage can be evicted after seven days unused; there is no background sync, so all sync happens while the app is open ([OJapp](https://tips.ojapp.app/en/pwa-ios-2026-complete-guide/)). MediaRecorder works from Safari 14.5, WebM/Opus from 18.4, otherwise audio/mp4 AAC ([Build with Matija](https://www.buildwithmatija.com/blog/iphone-safari-mediarecorder-audio-recording-transcription)).

10. **Constrained capture beats open capture, for video as for voice.** 1 Second Everyday's one-second-per-day and calendar layout ([Wikipedia](https://en.wikipedia.org/wiki/1_Second_Everyday)), BeReal's two-minute window and no editing ([Goat Agency](https://goatagency.com/blog/what-is-bereal/)), and Apple/Google's auto-compiled ~30-second memories ([DB Labs](https://dblabsapps.com/blog/apple-photos-memories-guide/)) all point one way: a short, fixed-length, unedited clip attached to a visit, with the compilation done by the product later.

---

## 2. Platform reality: an installed web app on iOS

V1 ships as a home-screen web app (Requirements §4, Technical Constraints §13.9). Everything below is a UX consequence, not an engineering note, because each one changes what a screen must say or do.

### 2.1 What works, what doesn't

| Capability | iOS installed web app, 2026 | UX consequence |
|---|---|---|
| Camera & microphone | Works via `getUserMedia`; permission must follow a direct user gesture and is **re-requested on every application load** ([Scandit](https://support.scandit.com/hc/en-us/articles/360008443011-Why-does-iOS-keep-asking-for-camera-permissions), [MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)) | Menu capture and voice capture must each open from an explicit tap with a one-line "why we need this" above the system prompt; never pre-request on launch. Expect the prompt every session and design the copy to survive it. |
| Audio recording | MediaRecorder from Safari 14.5; WebM/Opus from Safari 18.4; earlier falls back to audio/mp4 AAC ([Build with Matija](https://www.buildwithmatija.com/blog/iphone-safari-mediarecorder-audio-recording-transcription), [WebKit](https://webkit.org/blog/11353/mediarecorder-api/)) | Transcription provider must accept both containers; UI must not promise a format. |
| Storage | Reports conflict: some guides state 50 MB and a seven-day purge if unused ([MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)); others state Safari 17 raised quotas to ~60% of disk with a Persistent Storage API that requires notification permission ([OJapp](https://tips.ojapp.app/en/pwa-ios-2026-complete-guide/)) | Tech Constraints §17 item 12 already flags this for device testing. UX must assume the captured menu and in-progress order are the only things that *must* survive, and that a household not opening the app for a week may lose local drafts — so anything unsynced needs an "unsent" state that is visible, not silent. |
| Background sync | Not available: no Background Sync, Periodic Sync or Background Fetch ([MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)) | Offline orders reconcile only while the app is open. The order summary screen must carry a sync status and a "Retry now" that is one tap. |
| Install | No `beforeinstallprompt`; user does Share → Add to Home Screen. iOS 26 opens home-screen sites as web apps by default ([OJapp](https://tips.ojapp.app/en/safari-pwa-limitations-2/)) | One-time illustrated install card with the exact two taps, shown once, dismissible, re-findable in settings. |
| Push | Declarative Web Push exists on iOS 16.4+ outside the EU ([OJapp](https://tips.ojapp.app/en/pwa-ios-2026-complete-guide/)) | Usable for the post-visit "how was it?" nudge, but must be opt-in after the first completed visit, never at install (see §8.2 on timing). |
| Layout | `100vh` includes the Safari bar; safe-area insets required on notched devices; autoplay blocked unless muted ([MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)) | Bottom action bars must respect `env(safe-area-inset-bottom)`; the order summary "show to staff" mode must not rely on autoplaying anything. |
| Wake lock | Screen Wake Lock added in Safari 18.4 ([OJapp](https://tips.ojapp.app/en/pwa-ios-2026-complete-guide/)) | Use it in "show to staff" and in voice capture so the screen doesn't dim mid-sentence. |

### 2.2 Design rules that follow

- **Every permission has a pre-prompt.** A single sentence in Roam's voice, above the system dialog, every time: "Roam needs the microphone to hear the family's review. The recording is deleted once it's turned into ratings." Apple's own guidance and the NN/g voice findings both say the *why* is the difference between granted and denied.
- **Nothing important lives only on the device.** Local state is a draft; the UI says "Saved on this phone — will sync when you're back online" and shows a count of pending items where they were created (see §7.3).
- **The install card is content, not a modal.** It appears once on the home screen after the first successful search, with the two taps illustrated, and can be dismissed.

---

## 3. Household, members, defaults and preferences (Epic 1)

### 3.1 What the best products do

**Profiles exist because shared recommendations get polluted.** Netflix introduced profiles because roughly three-quarters of viewing comes from recommendations, and in households with children those recommendations "become dominated by cartoons" — the single account could not tell viewers apart ([TechCrunch](https://techcrunch.com/2013/08/01/netflix-user-profiles/)). The "Who's watching?" picker is one tap to a personal world; Kids profiles were later redesigned to be more visual, with characters guiding early readers ([TechCrunch](https://techcrunch.com/2021/04/13/netflix-gives-its-kids-profiles-a-visual-upgrade/)). Roam's equivalent is not "who's watching" but **"who's coming?"** — attendance per outing is the moment constraints switch on and off (Epic 1 C3), and it deserves the same one-tap, face-forward treatment.

**Parent-managed child records without a login are the established pattern.** Amazon's Parent Dashboard and Google Family Link both let an adult own and manage a child's profile and settings ([Amazon](https://www.amazon.com/gp/help/customer/display.html?nodeId=GNTST5RQEYKPGLYE), [Google](https://support.google.com/families/answer/6286986)). One parenting-app case study found that combining parent and child flows into one experience "presented problems when tested" ([Marta Fioni, Medium](https://medium.com/@martafioni/ux-design-field-notes-designing-and-app-to-connect-parents-63662c7d35ea)) — keep the adult's editing surface separate from anything a child might be shown on a shared phone.

**Allergen apps that work are specific and quiet.** They ask for allergies, severity, and *separately* for dietary preferences at first run; they plan for multiple allergens per person and start with 8–10 common ones ([Eastern Peak](https://easternpeak.com/blog/how-to-create-food-allergy-apps/), [Bekey](https://bekey.io/blog/top-five-apps-for-food-allergy-sufferers)). When flagging, the good ones name the actual ingredient behind the category — "almond, cashew" rather than "tree nuts" — and check only for the user's own allergens so that warnings stay rare and therefore heeded ([Foods Connected](https://blog.foodsconnected.com/the-best-food-allergy-apps-and-how-they-work)).

**The US market has left this open.** Baymard's 2026 benchmark of food delivery and takeout apps concluded that "dietary and customization needs had no supported path at any decision point", category-specific filters were absent throughout, and no site achieved even a "decent" overall rating ([Baymard](https://baymard.com/blog/food-delivery-and-takeout-ux-benchmark-2026)). DoorDash and Uber Eats treat dietary preference as a hard filter on retrieval ([ByteByteGo](https://blog.bytebytego.com/p/why-doordash-instacart-and-uber-eats)) — the same conflation of allergen and preference that Requirements §5 forbids.

**Onboarding: customise, don't tutor.** NN/g's research finds walkthrough tutorials interrupt, are not memorable, and do not improve task performance; contextual help with progressive disclosure does. The exception they allow is *content customisation* during initial onboarding, which "can create a relevant experience" ([NN/g](https://www.nngroup.com/articles/onboarding-tutorials/)). Roam's onboarding is entirely customisation — who is in the household and what they can't eat — so it is the legitimate kind.

**Data entry:** Apple's HIG pattern for entering data is to show a default value where possible, get information from the system rather than asking, prefer pickers to free text, validate dynamically, and require values only when necessary ([Apple HIG](https://developers.apple.com/design/human-interface-guidelines/patterns/entering-data)).

### 3.2 Recommendations for Roam

1. **Two different controls, two different words.** Allergens are entered through a picker from the canonical list (FDA 9 pending the open Q&A), shown as red-outlined chips with the word "allergen", and confirmed with an explicit "This will *exclude* places" note. Dislikes and likes are free text with autocomplete over taste concepts, shown as neutral chips, with the note "This will *rank* places, not hide them". They must never sit in the same list.
2. **Per-allergen specificity in warnings.** Store the category; display the matched ingredient wherever a menu or venue triggers it: "Contains cashew — tree-nut allergen for Ada."
3. **"Who's coming?" is a face row, not a settings screen.** On every plan and search, the attending members are avatars at the top; tap to toggle; a child's avatar carries a small "managed" glyph. One-member households skip it (M1).
4. **Pace defaults are shown as sentences with editable numbers.** "We usually spend **about 75 min** at a place and will travel **up to 45 min**." System defaults are pre-filled and labelled as such until changed (M4).
5. **The child record lives under the adult.** In the member list, a child appears nested under the adult who owns the record, with "Managed by Roger" beneath the name. There is no child-facing screen in V1.
6. **Export and delete are one screen, two buttons, and the delete says what it deletes.** "Delete everything Roam holds about this household — profiles, trips, visits, orders, ratings, captured menus. Places we've shown you are only ever stored as identifiers, and those go too." Deletion asks for the household name to be typed (C10).

---

## 4. Time-based discovery, catchments and evidence (Epic 3)

### 4.1 What the best products do

**Time, not distance, is now a recognised search primitive.** Isochrone tools answer "where can I get to in X minutes?" and the resulting shapes are "soft and almost organic… stretching along fast corridors and shrinking where movement is slow" ([Marcus Fleckner, Medium](https://medium.com/map-quest/isochrone-maps-when-cities-are-drawn-in-minutes-not-meters-b3036e0fe034)). TravelTime's own app has the user drop a start point, choose a mode, and move a time slider while the reachable area redraws live ([TravelTime](https://app.traveltime.com/)). Their documentation warns that real isochrones contain **holes** (blackspots inside the area) and **islands** (disconnected reachable patches), and that granularity trades smooth lines against exact areas ([TravelTime docs](https://docs.traveltime.com/api/use-cases/isochrones)). For transit, the islands are the point — they are the stations.

**Preferences as filters, not rules.** Citymapper's "Walk Less", "Turbo", "Price" and main-roads-after-dark walking options act as "well-designed constraints that narrow down routes based on user preference… as high-level preferences rather than rigid rules" ([IXD@Pratt](https://www.ixd.prattsi.org/2026/02/design-critique-citymapper-ios-app/)). Its weakness, in more than one design critique, is an overcrowded main screen where the map and route options compete ([Simon Hoffmann, Medium](https://medium.com/@simkhoff/ux-design-challenge-simplifying-city-travel-with-citymapper-132a58e0b200)).

**Personal match, with the reasons shown.** Google Maps' "Your Match" gives a 0–100 score against your own ratings, history and stated food preferences, and shows "the reasoning behind each number" on the card ([GSMArena](https://www.gsmarena.com/google_maps_adds_a_personalized_match_score_for_places_makes_group_outings_easier_to_organize-news-30937.php), [Engadget](https://www.engadget.com/2018-07-31-google-maps-match-feature.html)). Google was explicit that "individual taste often differs from the masses" — the same premise as Roam's taste model.

**Conversation over a map, not instead of one.** Ask Maps (March 2026) opens from a button below the search bar; suggestion bubbles appear under the transport-mode selector; results come back as "a customized map to help you visualize your options" alongside the conversational answer, then hand off to saving, sharing and directions in a few taps ([Google](https://blog.google/products-and-platforms/products/maps/ask-maps-immersive-navigation/), [MacRumors](https://www.macrumors.com/2026/03/12/google-maps-gemini-integration/)). Note what Google did *not* do: it did not replace the map with chat.

**Zero results is a design surface.** Nearly half of sites fail to help users recover from no results; the best strategy is to suggest relaxing one constraint at a time — a broader category, or the same query with one filter removed ([Baymard](https://baymard.com/blog/no-results-page)). Roam's C9 ("offer a wider travel time or a relaxed constraint") is this pattern; the research adds that the relaxation should be *one tap* and *specific* ("Try 30 min instead of 20" / "Search without Sam's dislike of pubs").

**Evidence beside the match.** The Smashing review guide's checklist for trust — decimal score with count, distribution, feature-specific ratings, unedited photos, publication dates — is aimed at commerce, but the transferable point is that a claim without visible evidence is discounted ([Smashing](https://www.smashingmagazine.com/2023/01/product-reviews-ratings-ux/)). Roam's C5 requirement to show "the evidence that caused each match" against a dish or activity search is, in the research's terms, a citation pattern ([Shape of AI — Citations](https://www.shapeof.ai/)).

### 4.2 Recommendations for Roam

1. **The catchment is drawn, always, and labelled by time.** A translucent reachable area on the map with "20 min by transit from Home, leaving 11:00". Islands and holes are drawn as they are; no smoothing that lies. Where the mode is estimated rather than derived (V1 stub until the provider is live), the label says "estimated" — never present an estimate as a catchment.
2. **Three controls above the map, nothing else:** start point (defaults to Home or a named venue), travel time as a stepped slider (10/15/20/30/45/60), mode as four icons. Departure time is inherited from the trip and shown, not edited, here. Everything else lives behind a single "Filters" sheet, per the Citymapper critique.
3. **One list, mixed, with type badges** — food, drink, things to do, events — ranked on one basis, per C6, with a segmented control to narrow to one type (M4). Events show their window ("7:30–9:30 pm") in place of a dwell estimate.
4. **The card, in order:** name · type badge · **travel time** ("14 min") · per-member reasons as chips ("Jules likes seafood", "Ada: tree-nut allergen ✕" if in the excluded list) · evidence quote if the search was a dish or activity · source attribution footer. Rating is present but not the lead.
5. **Excluded places are visible, collapsed.** "3 places hidden for Ada's allergen — show". Hiding silently makes the product feel thin; showing the exclusions makes it feel careful.
6. **No results shows the constraint stack** as a list of one-tap relaxations, most-likely-to-help first, and never a blank state.
7. **"Somewhere different"** is a single button that runs the same search with the ledger exclusion (C4) and reports "Hiding 12 places you've already seen".
8. **Call bound reached (C10)** reads as a status, not an error: "That's everything we can fetch for this outing — you can still plan with these 38 places." Never a red banner; it is not the user's fault.

---

## 5. Along the route and the time budget (Epic 4)

### 5.1 What the best products do

**Detour is a number.** Google's platform defines detour as "the additional time required to visit a place compared to the time taken using a direct route" — the two legs via the place minus the direct route — and its example is "an extra 5 minutes" ([Google Maps Platform](https://developers.google.com/maps/documentation/places/web-service/sar-overview)). Search-along-route results are ranked by that detour, and the documentation is explicit that results are biased toward the route, not guaranteed on it ([Google](https://developers.google.com/maps/documentation/places/web-service/search-along-route)). In the consumer app, a magnifying glass in navigation offers category chips (gas, restaurants, grocery, coffee) and adds the chosen place as a stop ([Onix](https://www.onixnet.com/blog/discover-whats-on-the-road-ahead-with-google-maps-new-search-along-route-feature/)); Apple Maps offers "Add Stop", categories, up to 14 stops, and a "Resume Route" control to abandon a detour ([Apple Support](https://support.apple.com/guide/iphone/find-stops-along-your-route-iph837d13d03/ios)). Waze allows only one stop per route and is judged clunkier ([Routific](https://www.routific.com/blog/waze-vs-google-maps)).

**NN/g found that users could not verify "along my route".** In the intelligent-assistants study, participants "couldn't verify restaurants actually lay along their specified route without tedious map navigation" ([NN/g](https://www.nngroup.com/articles/intelligent-assistant-usability/)). The detour number and a map pin relative to the drawn route are the verification.

**Time between stops is table stakes in itinerary tools.** Wanderlog shows estimated time and distance between each pair of places, per mode, plus totals per day "to make sure it all fits… and you're not driving too long" ([Wanderlog Help](https://help.wanderlog.com/hc/en-us/articles/5159565134875-See-time-and-distance-between-places), [Wanderlog blog](https://wanderlog.com/blog/2024/11/26/wanderlog-vs-tripit/)). Google Trips, before it was retired, built day plans from saved places using "the distance between those places and the average time people stay there", told users how long visitors usually spend at each attraction, showed transfer times by car or on foot, and showed opening hours ([Google](https://blog.google/products/travel/see-more-plan-less-try-google-trips/), [Transfer Desk](https://transferdesk.com/travel-apps/google-trips-app-review-your-whole-trip-planned-in-seconds/)). That is Roam's time-budget rule, six years early, minus the household's own pace.

### 5.2 Recommendations for Roam

1. **The trip header is a time bar, not a form.** Depart 11:00 ── return 18:30 is a horizontal bar. Travel legs fill it in one shade, stops in another, slack in a third; the intensity target is a tick on the bar. Overrun spills past the right edge in red and the offending stop is labelled on the bar itself (C4). This makes "does it fit?" answerable at a glance and makes C1 (time remaining before any candidate) a permanent fixture rather than a message.
2. **Every along-route card leads with "+X min"**, in the same visual slot that the catchment card uses for travel time. The map shows the route as a line and the candidate as a pin; the detour is drawn as a dashed spur when a card is focused. This is the verification NN/g found missing.
3. **Detour is sortable and cappable.** Default sort by detour; a single chip "under 10 min detour" — the open question on how far off-route is worth showing becomes a user control with a sensible default rather than a hidden threshold.
4. **Adding a stop is a bottom sheet with the dwell pre-filled** from the household default and editable inline ("Stay about **75 min**"), and the sheet shows the *consequence* before confirming: "Adds 22 min travel + 75 min → 48 min left in the day."
5. **Reorder with up/down handles and a "best order" button**, not freeform drag (see §6.1). Times recalculate on every change (C7).
6. **Max-travel tolerance is a second gauge**, small, under the time bar: "Travelling 68 of your 45 min limit" in amber (C6).
7. **Cannot fit in any order (C8)** offers exactly two actions on the same card: "Return at 19:00 instead" and "Remove [named stop]". The research on no-results pages applies: specific, one tap each.

---

## 6. Trip options and assembly, by touch and by voice (Epic 5)

### 6.1 What the best products do

**Whole-day generation at a stated pace has a precedent.** Google Trips asked whether you had "just the morning or afternoon, versus a full day" and filled it; a "magic wand" regenerated the whole plan with different nearby places on each tap ([Google](https://blog.google/products/travel/see-more-plan-less-try-google-trips/), [No Camera Bag](https://nocamerabag.com/blog/review-google-trips-app-for-planning-trips)). Roam's *intensity* is the pace control Google Trips lacked.

**Freeform drag-and-drop failed in user testing.** The Tripping team "thought it made perfect sense, but once in users' hands, none of it made sense"; every test ended at the organiser screen with "what am I looking at?" ([Tripping case study, via search](https://medium.com/travel-itinerary-app/tripping-itinerary-planner-ux-case-study-1567dbd9e35d)). Drag-and-drop still exists in Holicay, WePlanify and TripStone, but the current 2026 field has moved toward AI generate-then-adjust: Mindtrip has no drag-and-drop at all and changes plans by request ("Replace Day 3 museum with a food tour"), which reviewers list as both its strength and its limitation ([Layla](https://layla.ai/blog/ai-travel-planners-comparison), [TripStone](https://tripstone.app/blog/mindtrip-alternatives)). Wanderlog is preferred by people who "would rather build the trip yourself with strong tools" ([Lindy](https://www.lindy.ai/blog/trip-planner-app)); Mindtrip for group and family context ([Stippl](https://www.stippl.io/blog/best-ai-travel-planner-2026)).

**Options should differ on a stated basis, and the basis should be visible.** Citymapper's route options are labelled by what they optimise (fastest, walk less, price) rather than presented as an unlabelled ranked list ([IXD@Pratt](https://www.ixd.prattsi.org/2026/02/design-critique-citymapper-ios-app/)). This is precisely Roam's C4.

**Comparing on a phone.** NN/g's mobile-tables research: sticky headers and a frozen first column keep comparisons legible; forcing rotation frustrates; the strongest alternative is a *filtered* view that shows differences only, as Dell did with "all / similarities / differences" ([NN/g](https://www.nngroup.com/articles/mobile-tables/)). Cards remain the right container for options that mix text, image and action ([NN/g cards](https://www.nngroup.com/articles/cards-component/)).

**The AI pattern vocabulary already names Roam's interactions.** Shape of AI catalogues *Variations* (trace through multiple results to pick the best), *Inpainting* (target a specific area of a result to regenerate or remix), *Branches* (iterate while keeping the original visible), *Verification* (confirm AI decisions before proceeding), *Citations* and *Regenerate* ([Shape of AI](https://www.shapeof.ai/)). Roam's options are Variations; assembling a plan from parts is Inpainting over a day; the confirm-before-change rule for voice (C7) is Verification.

**Voice assembly is safe only against a closed set with visual confirmation.** NN/g: multi-clause sentences were misunderstood, assistants interrupted natural pauses, and comparison was "nearly impossible" without a screen; the recommendation is on-screen options side by side and preserving previous result sets ([NN/g](https://www.nngroup.com/articles/intelligent-assistant-usability/)). Google's conversation guidance: implicit confirmation for parameters ("Taking the museum from Plan B…"), explicit confirmation only where a mistake is costly, and one-step correction ("no, the *other* museum") ([Google](https://developers.google.com/assistant/conversation-design/confirmations)). Requirement M4 (ask which option when ambiguous) is the disambiguation case in the same guidance.

### 6.2 Recommendations for Roam

1. **Options are three cards in a horizontal pager, each titled by its basis**: "Slow morning, big lunch" · "Museum first, pub after" · "All within walking distance". Each card is a mini time bar (the same component as the trip header) plus its stops as a vertical list. The intensity control sits above the pager; changing it recomposes from the same pool (C3, M2) and says so: "Recomposed from the same 38 places — no new lookups."
2. **A "Differences" toggle** de-emphasises stops shared by all options and highlights what changes — the NN/g filtered-comparison pattern, applied to plans.
3. **Assembly is selection, not dragging.** Each stop on each option card has a checkbox. Checked stops accumulate into a fourth card, "Your plan", that live-validates against the window (C6) and names the conflict ("Museum + Green Fig + Jazz doesn't fit — drop one, or return at 19:00").
4. **Voice does the same thing with the same result surface.** A mic button on the options screen; the transcript renders live; the interpretation is shown as *checked boxes on the cards*, not as prose — then a single "Use this plan" button. That is Verification in the Shape of AI sense and explicit confirmation in Google's, applied once at the end rather than per utterance. Ambiguity is resolved by highlighting both candidate stops and asking "Which one?" with two tap targets (M4).
5. **Prompt suggestions above the mic**, in the style of Ask Maps' suggestion bubbles: "Swap lunch for the pizza place", "Take everything from Plan A except the museum". They teach the closed vocabulary without a tutorial.
6. **Keep the previous options.** NN/g found users wanted to return to earlier results without re-querying; a "previous" chip on the pager restores the last set from the in-session pool at zero cost.

---

## 7. Menu capture, ordering and offline (Epic 6)

### 7.1 What the best products do

**Review before commit.** Allergen-label scanners and menu OCR products all expose the parsed result for correction before it is used, because the failures are physical — lighting, folds, chalkboards ([Veryfi](https://www.veryfi.com/restaurant-menu-ocr-api/), Technical Constraints §10). The correction screen is also the training signal.

**Specific, personal, sparse warnings.** Name the ingredient behind the flag, and flag only the attending members' allergens so the flags are rare enough to be read ([Foods Connected](https://blog.foodsconnected.com/the-best-food-allergy-apps-and-how-they-work)). Baymard's finding that customisation options were "undescribed on item pages" across the industry is the negative example ([Baymard](https://baymard.com/blog/food-delivery-and-takeout-ux-benchmark-2026)).

**Offline is calm, not alarming.** The design guidance that repeats across sources: a subtle indicator rather than a warning banner; a "pending" badge on the screen where the edit happened; an Outbox that lists pending items in plain language; status vocabulary limited to Pending / Syncing / Failed; optimistic UI so the action appears done immediately; last-synced timestamps; and a status bar that "avoids looking like an error state" ([AppMaster](https://appmaster.io/blog/offline-first-background-sync-conflict-retries-ux), [Google Open Health Stack](https://developers.google.com/open-health-stack/design/offline-sync-guideline), [LeanCode](https://leancode.co/blog/offline-mobile-app-design)). Progress bars beat spinners because a spinner cannot show it is stalled ([Google OHS](https://developers.google.com/open-health-stack/design/offline-sync-guideline)).

### 7.2 Recommendations for Roam

1. **Capture is a multi-shot flow with a running count**: "Page 1 of ? — add another page or done". Each shot shows its parse immediately as a section list; unreadable regions are drawn as a highlighted box on the photo with "Couldn't read this — retake or type it" (C9).
2. **The review list is editable inline and grouped by section**, with prices right-aligned and an "indicative" badge once the staleness threshold passes (C8). Editing an item name re-runs taste-concept matching silently and shows the resulting concept as a small grey label beneath ("→ arrabbiata") so wrong collapses are visible and correctable (Epic 2 C8).
3. **Allergen flags are per member, on the item row, naming both**: a red chip "Ada · tree nuts (almond)". Tapping the chip shows the source text that triggered it. Items with an *inferred* allergen (from a description rather than a stated ingredient) use an amber "check with staff" chip — resolving the open Q&A toward *prompt*, not *certain*, because a false "safe" is the dangerous error.
4. **Ordering is per member, by tapping the face then the item**, so the order summary is naturally grouped by person (C7, M4). Modifications are a free-text line under the item (C6).
5. **"Show to staff" is a distinct full-screen mode**: large type, high contrast, no chrome, wake lock on, grouped by person, allergen lines in bold ("Ada — tree-nut allergy: no almonds"). It is the one screen in the product designed to be read upside-down across a table.
6. **Offline state is a single quiet line under the summary**: "Saved on this phone · will sync when online", switching to "Synced 14:02" — and, on failure, "Couldn't sync · Retry" with the client-generated identifier doing the deduplication behind it (C5, Technical Constraints §13.10).

---

## 8. Visit confirmation and rating capture (Epic 7)

### 8.1 Confirming a visit

**Suggest, then let the user choose.** Apple Journal builds suggestions from photos, visits, workouts and music using on-device intelligence; each suggestion carries up to 13 assets; a picker shows Recommended and Recent tabs; the user previews and chooses which attachments to keep before an entry exists; every data type has its own privacy toggle ([MacStories](https://www.macstories.net/reviews/apples-journal-app-journaling-for-all/), [Apple Developer](https://developer.apple.com/videos/play/tech-talks/111384/)). Google Maps Timeline has long shown "unconfirmed places" for the user to confirm or correct ([Google Maps Community](https://support.google.com/maps/thread/5243541?hl=en)). iOS 26's Apple Maps "Visited Places" is opt-in, detected on-device, and end-to-end encrypted ([AppleInsider](https://appleinsider.com/inside/apple-maps/tips/inside-apple-maps---how-to-get-the-most-out-of-your-iphones-navigation-app)).

Requirements Epic 7 Q&A asks whether a visit should be created automatically from location or always confirmed. The research says: **the confirmed-by-user pattern is what users now expect from Apple and Google**, and in V1 there is no background location anyway (Technical Constraints §13.9). Design for a suggestion — "Did you go to Sagano Ramen?" — with Yes / Skipped / Went somewhere else, and let V2 native add detection behind the same prompt. The Journaling Suggestions API is worth noting for V2: third-party apps can consume Apple's own visit suggestions ([Apple Developer](https://developer.apple.com/videos/play/wwdc2024/10209/)).

### 8.2 When to ask

Uber asks the moment the ride ends and is cited as getting "the timing and minimal design right" ([UX Planet](https://uxplanet.org/how-to-design-user-rating-and-reviews-1b26c0208d3a)). Prompting on app launch increases the chance of closing the app by 50%; a conversational opener is 5–10× more effective than a bare rating request; e-commerce should ask after delivery, not purchase ([Alchemer](https://www.alchemer.com/resources/blog/ratings-prompts-when-and-how-to-ask-for-an-app-rating-2/), [AppFollow](https://appfollow.io/blog/how-to-ask-for-app-reviews)). Etsy deliberately delays a week for a "full experience" review ([Smashing](https://www.smashingmagazine.com/2023/01/product-reviews-ratings-ux/)). Requirements §6 Epic 7 says the opinion "is formed in the twenty minutes after leaving".

**Recommendation: two moments, one model.** A *quick take* when the stop's planned end passes or the user marks it done — one tap per person per place, thirty seconds total — and a *debrief* prompt that evening (push, if granted) for the spoken version. Both write to the same visit; the debrief can override the quick take (M3).

### 8.3 What to ask — the rating instrument

The evidence, in one place:

| Product | Instrument | What it taught |
|---|---|---|
| Netflix | Thumbs up/down (from 5 stars, 2017) | 200% more ratings; stars were read as quality, thumbs as personal; thumbs-down lets the system learn what *never* to show ([Netflix](http://about.netflix.com/en/news/goodbye-stars-hello-thumbs)). Some users miss a neutral option ([Appcues](https://www.appcues.com/blog/rating-system-ux-star-thumbs)). |
| Apple Maps | Thumbs up/down, separate aspects, verified visitors only | Aspect ratings avoid one blanket verdict; verification is a trust feature ([BrightLocal](https://www.brightlocal.com/blog/apple-maps-ratings/)) |
| Letterboxd | Half-stars **and** a heart | Stars for quality, heart for enjoyment; recommendations run on likes ([Five Star Insider](https://www.fivestarinsider.com/heart-button-letterboxd/)). Users avoid half-stars and rate lower than on a 10-point scale — "2/5 feels less harsh than 4/10" ([Datawrapper](https://www.datawrapper.de/blog/movie-reviews-rating-scales)) |
| Beli | Pairwise "which was better?" → 0–10 | No absolute scale; a strict personal order; users ask for within-category comparisons ([Today](https://www.today.com/food/trends/what-is-beli-app-rcna217748), [UChicago Bite](https://uchicagobite.com/blog/2023/3/1/beli-app-restaurant-hot-spots)) |
| Untappd | 5 stars, optional, .25 or .1 granularity | Rating is optional; qualitative check-ins are fine ([Untappd](https://help.untappd.com/hc/en-us/articles/360034404451-How-to-Check-In-a-Beer)) |
| Commerce (Smashing) | Decimal average, distribution, per-attribute | Attribute-level ratings and tags carry the useful information; 70% prefer more ratings over a higher average ([Smashing](https://www.smashingmagazine.com/2023/01/product-reviews-ratings-ux/)) |

Roam is a personalisation system, not a review site. Its ratings are never averaged across strangers in V1; they feed one household's model. Every product above that optimises for a personal model chose a binary or comparative signal over stars, and every product that kept stars did so for public quality display.

**Recommendation: per person, per thing — a three-way take plus words.** *Loved it* / *Fine* / *Not for me*, rendered as three large targets, plus the comment. Three rather than two answers the "no neutral" complaint about Netflix's thumbs while keeping the meaning personal; the labels are written in the first person so nobody reads them as a public score. For dishes and activities the same three states apply (Epic 1 C5). The comment is the transferable part (C6) — a placeholder prompts for it: "What made it that?" A whole-visit take sits above the per-item takes and is the *only* thing asked for a visit with no order (C3).

Beli-style comparison ("better than last time at Nonna's?") is a strong V2 addition once a household has history in a category; it should not be in V1, because it has nothing to compare against for the first dozen visits.

### 8.4 The debrief by voice

See §9 for the recording surface. The specific flow:

1. **Prime the closed set on screen before recording.** Show the attendees' faces and the ordered items as chips. This is not decoration: it tells the family what to say ("I'm Jules — the octopus was great") and it tells them the system only knows those names and those items.
2. **Self-announcement is the design, and the screen supports it.** No published pattern exists for self-announced speaker ID in consumer apps; the closest analogue is Otter's assign-a-speaker flow, where unnamed speakers appear as "Speaker 1" and a name is applied to all their segments ([Otter help](https://help.otter.ai/hc/en-us/articles/360048258753-Speaker-identification)). Roam should render the transcript as segments, each with a face; segments where attribution is uncertain show a "Who said this?" row of faces (C5); tapping one assigns it, and a "same speaker" affordance applies it to adjacent segments.
3. **Confirmation is one screen, then Save.** Mapped takes and comments appear as the same three-way controls as the tap flow, pre-selected; unmatched comments are listed under "Didn't match anything — assign or discard" (M1). Nothing is saved until the single Save (C4).
4. **The audio-deletion promise is on the screen, in words**: "Recording deleted · ratings kept" appears after Save (C7). Given L8 (bystander audio) this line is doing legal work as well as reassurance.

---

## 9. Voice recording as a first-class input

**Capture affordance.** Apple Voice Memos and Google Recorder both use a single large red record button at the bottom of the screen; Google Recorder toggles between a live waveform and a live transcript while recording ([Pocket-lint](https://www.pocket-lint.com/apple-voice-memos-google-recorder-comparison/), [PopSci](https://www.popsci.com/story/diy/best-voice-recorder-apps/)). WhatsApp uses press-and-hold with slide-to-lock for hands-free, and is moving to a single tap that starts a locked recording, because hold-to-talk causes accidental recordings and cannot be sustained one-handed at a table ([Dignited](https://www.dignited.com/29799/whatsapp-voice-recording-lock/), [BeingGuru](https://beingguru.com/whatsapp-to-roll-out-easier-voice-recording/)).

**What NN/g found in the field.** Voice detection fails in noise; after three items in a list users abandoned voice for faster methods; verbal confirmation after each action is expected; users pre-formulate and over-enunciate after a failure; non-native speakers are penalised; natural pauses are cut off ([NN/g voice interaction](https://www.nngroup.com/articles/voice-interaction-ux/), [NN/g intelligent assistants](https://www.nngroup.com/articles/intelligent-assistant-usability/)). Children's speech is recognised worse still (Technical Constraints §9.4) — and in V1 no child is recorded.

**Recommendations**

- **Tap to start, tap to stop; never hold.** A large round button, a visible timer, a live waveform so the family can see it is hearing them, and the live transcript beneath. A soft cap of two minutes with a gentle "that's plenty" — the research on multi-item voice fatigue says long recordings degrade, and the debrief is meant to be short.
- **Turn-taking is on screen.** The attendee faces are the prompt: the family taps the face of whoever is speaking next *or* announces themselves; either produces the attribution. This gives the closed set two routes, one of which needs no ASR at all.
- **Always a tap alternative, on the same screen** (C8). The three-way controls are visible under the transcript from the start; voice is a way of filling them, not a separate mode.
- **Permission copy is written for the table.** "Roam listens only while you're recording. The audio is deleted once it's turned into ratings." Because iOS asks again every session, the copy must make sense the tenth time.
- **Noise is expected.** If the transcript confidence is low, say so before Save rather than after: "Loud room — check these", with low-confidence segments highlighted.

---

## 10. Video snippets — designing ahead for V3

**Constraint produces capture.** 1 Second Everyday records one second per day, arranges clips on a calendar, and compiles months or years automatically; its Webby awards were for "Best Use of a Mobile Camera" ([Wikipedia](https://en.wikipedia.org/wiki/1_Second_Everyday), [Miss Freddy](https://missfreddy.com/digital-organizing/1-second-everyday/)). BeReal enforced a two-minute capture window with no filters or edits, and its authenticity was the appeal that Instagram and TikTok copied ([Goat Agency](https://goatagency.com/blog/what-is-bereal/), [Bloomberg](https://www.bloomberg.com/news/articles/2022-09-15/tiktok-launches-spontaneous-photo-feature-similar-to-bereal)). Snapchat's dual camera has no time limit and, by comparison, is judged less spontaneous ([Nerdschalk](https://nerdschalk.com/bereal-and-snapchat-dual-camera-differences-and-similarities/)).

**Compilation is the product, capture is the input.** Apple Photos Memories are ~30 s when short, set to music, with visual themes, and since iOS 18.1 can be generated from a typed description; Google Photos builds featured memories from "best photos, trips you've taken, and moments you've celebrated" ([DB Labs](https://dblabsapps.com/blog/apple-photos-memories-guide/), [AppleInsider](https://appleinsider.com/inside/ios/tips/how-to-create-your-own-memories-movies-in-photos-on-ios-or-ipados-18), [Google Photos Help](https://support.google.com/photos/answer/9454489)). Apple Journal attaches photos, voice and location to a moment, but reviewers criticised the lack of search and date browsing ([MacStories](https://www.macstories.net/reviews/apples-journal-app-journaling-for-all/)) — a warning for the V3 visit timeline.

**Recommendations for V3, with V1 groundwork**

- **A fixed-length clip on the visit** — three to five seconds, no editing, one per visit, captured from the quick-take screen. The constraint is the feature.
- **The compilation is "this place, over the years"** — when a household returns to a venue, the previous clips play as a strip before anything else. That is the emotional payoff the requirements describe, and it needs only the clip and the venue identifier.
- **V1 groundwork:** the quick-take screen should already have the camera affordance slot (disabled, "coming later"), and the visit record should already carry a media list, so that V3 is an attachment, not a migration.
- **Cost and consent** are called out in Requirements Appendix C and L15; the UX consequence is a clear "who's in frame" moment before capture, and a delete path per clip.

---

## 11. Explaining recommendations and calibrating trust

**Tie explanations to the user's own actions and data.** PAIR: present explanations in response to what the user did, so cause and effect is learnable; use categorical confidence (high/medium/low) or n-best alternatives rather than raw percentages, which users misread; give partial explanations focused on what affects the decision; and be explicit about data *scope*, *reach* and *removal* ([Google PAIR](https://pair.withgoogle.com/chapter/explainability-trust/)). Their do/don't pairs are directly usable: "Be careful — it's after 6 pm and our route recommendations don't include street-light data" beats "Be careful on your evening run".

**"Because you…" outperforms "Recommended for you".** Explanations increase transparency, scrutability (the user can correct the system), trust and satisfaction; the specific phrasing that names the cause is what works ([CDT report](https://cdt.org/wp-content/uploads/2022/10/algorithmic-transparency-ux-final-100322.pdf), [Clutch](https://clutch.co/resources/ux-ai-driven-interfaces)). NN/g's participants distrusted Alexa's "top" recipe because nothing said what "top" meant ([NN/g](https://www.nngroup.com/articles/intelligent-assistant-usability/)).

**Recommendations**

- Roam's per-member reasons are the explanation. Render them as the person's face plus a short clause, never as a percentage: "Jules · likes seafood", "Roger · dislikes Italian". Contested preferences (Epic 1 C6) show both faces on the same chip.
- **Confidence is categorical and about the *data*, not the taste**: "Estimated travel time", "Merged from 2 sources — hours differ", "Learned from 2 ratings (needs 3 to count)". The last is the preference-confidence rule made visible, and it doubles as a nudge to rate.
- **Scrutability is a tap away**: every reason chip opens the profile line it came from, so a wrong inference is corrected at the source.
- **The spend bound is explained the same way** (Epic 3 C10): a status line with the reason ("We fetch a limited number of places per outing to keep Roam affordable"), never a paywall tone.

---

## 12. Accessibility and inclusion floor

- **Targets:** WCAG 2.2 SC 2.5.8 requires 24×24 CSS px minimum; Apple's HIG recommends 44×44 pt and Material 48×48 dp ([Deque](https://dequeuniversity.com/rules/axe/4.9/target-size), [AllAccessible](https://www.allaccessible.org/blog/wcag-258-target-size-minimum-implementation-guide)). Roam's chips, faces and three-way rating targets should all be ≥44 pt; the "show to staff" screen larger still.
- **Colour is never the only signal for an allergen.** Red chips also carry the word "allergen" and an icon; this is a safety flag and must survive colour-blindness and bright sunlight on a terrace.
- **Every voice path has a tap path on the same screen** (Epic 7 C8; also WCAG's spirit for redundant entry). Every map has a list.
- **Dynamic type** is honoured everywhere, including the time bar — numbers must not truncate.
- **Children are not users in V1** (Requirements §4), so no child-facing UI is designed; but a child's *name and constraints* appear on adult screens constantly, and the copy must be respectful ("Ada · tree-nut allergen", never "kid-safe").
- **Noise and light are the venue's accessibility problems**: live waveform for "is it hearing me", high-contrast staff mode, retake-on-glare for menus.

---

## 13. Cross-cutting design principles for Roam

Distilled from the sources above, in priority order.

1. **Every number the household cares about is drawn, not described.** Reachable area, time bar, detour, remaining budget. The research on voice and on comparison says the screen is where verification happens.
2. **People, not scores, are the explanation.** Faces plus clauses. This is Roam's structural advantage over every product surveyed.
3. **Safety and preference never share a control, a colour, or a sentence.**
4. **Closed sets everywhere voice appears**, with the set visible on screen before the mic opens.
5. **Suggest, then confirm** — visits, attributions, assembled plans. One confirmation at the end, not one per step.
6. **Constrained capture** — three-way takes, short recordings, fixed-length clips — produces more data than open capture.
7. **Calm degradation.** Offline, call bounds, missing transit data and unreadable menus are statuses with a next step, never errors.
8. **Generate-and-adjust over freeform manipulation.** Options, differences, swaps; drag-and-drop only as a secondary affordance, if ever.
9. **Ask at the right moment and once.** Quick take on leaving; debrief that evening; never on launch.
10. **The platform's permission model is part of the copy.** Each capability's "why" line is written once and shown every time iOS asks.

---

## 14. What this research changes in the requirements

Feedback into Requirements v5.0 / Technical Constraints v3.0, for the owner's decision:

| Ref | Proposed change | Basis |
|---|---|---|
| Epic 7 C2/C3, §5 | Specify the rating instrument as a per-person three-state take plus comment, not a numeric scale, and state that V1 ratings are never averaged across households | §8.3 — Netflix, Apple Maps, Letterboxd, Datawrapper |
| Epic 7 Q&A "at venue, after, or both" | Resolve as **both**: quick take at stop end, debrief prompt later the same day | §8.2 — Uber timing, launch-prompt penalty, Etsy delay |
| Epic 7 Q&A "automatic vs confirmed" | Resolve as **confirmed from a suggestion** in V1; detection is a V2 native input to the same prompt | §8.1 — Journal, Visited Places |
| Epic 6 Q&A "inferred allergen: certain or prompt" | Resolve as **prompt** ("check with staff") for inferred, **certain** only for stated ingredients | §7.2 — false-safe is the dangerous error |
| Epic 4 Q&A "how far off-route" | Make it a user-facing detour cap with a default, not a hidden threshold | §5.2 |
| Epic 5 workflow | Add: options are presented with a "differences" view; assembly is by selection with voice as an alternative input to the same selection | §6.1 — Tripping, NN/g tables |
| Epic 3 C10, §5 spend rule | Add: the bound message states the reason and what remains usable, in status (not error) tone | §4.2, §11 |
| §4 Business constraints / TC §13.9 | Add the iOS permission-per-launch behaviour and no-background-sync as explicit constraints, since both change screen copy and flow | §2 |
| Appendix C video | Add: fixed-length clip, no editing, one per visit; "this place over the years" playback as the payoff | §10 |
| New minor AC, Epic 1 | An inferred taste preference below threshold is visible to the household with its count ("learned from 2 ratings") | §11 — scrutability |

---

## 15. Prototype implications, by screen

What the first prototype screens must contain to be true to this research. This is the brief for the build that follows.

**Household**
- Face row with attendance toggles; child nested under owning adult with "Managed by …".
- Allergen picker (canonical list) → red "allergen" chips; likes/dislikes free text → neutral chips; the two never in one list.
- Pace defaults as sentences with editable numbers; "system default" label until changed.
- Export / Delete on one screen with explicit deletion copy.

**Discover**
- Map with drawn catchment labelled by time and mode, "estimated" when it is.
- Three controls only above the map; filters in a sheet.
- One mixed, badged list; card order: name · type · travel time / +detour · reason chips with faces · evidence quote · attribution.
- Hidden-for-allergen count with reveal; no-results relaxation list; "somewhere different"; bound-reached status line.

**Trip**
- Time bar header with legs, stops, slack, intensity tick, overrun spill and named offending stop.
- Along-route cards led by "+X min"; dashed detour spur on focus; detour cap chip.
- Add-stop sheet showing the consequence before confirm; up/down reorder plus "best order"; max-travel gauge.
- Can't-fit card with exactly two actions.

**Options**
- Three basis-titled cards in a pager, each a mini time bar; intensity above; "recomposed, no new lookups" line.
- Differences toggle; checkboxes per stop; "Your plan" card live-validating.
- Mic with prompt bubbles; interpretation shown as checked boxes; one "Use this plan".

**Menu & order**
- Multi-shot capture with page count; unreadable-region highlight with retake/type.
- Editable review list by section; concept label under each item; indicative-price badge.
- Per-member allergen chips naming the ingredient; amber "check with staff" for inferred.
- Order by face-then-item; modifications inline; "Show to staff" full-screen mode with wake lock; quiet sync line with Retry.

**Visit & rating**
- "Did you go?" suggestion with Yes / Skipped / Somewhere else.
- Quick take: faces × items grid of three-way controls; whole-visit take for no-order visits; comment prompt "What made it that?".
- Debrief: tap-to-start recorder with waveform + live transcript, attendee faces as turn prompts, segment attribution with "Who said this?", unmatched list, single Save, "Recording deleted · ratings kept".
- Disabled camera slot reserved for V3 clips.

---

## 16. Source index

Ratings and reviews
- [Netflix — Goodbye Stars, Hello Thumbs](http://about.netflix.com/en/news/goodbye-stars-hello-thumbs)
- [Appcues — 5 stars vs thumbs](https://www.appcues.com/blog/rating-system-ux-star-thumbs)
- [BrightLocal — Apple Maps ratings](https://www.brightlocal.com/blog/apple-maps-ratings/)
- [Five Star Insider — Letterboxd heart](https://www.fivestarinsider.com/heart-button-letterboxd/)
- [Datawrapper — How rating scales shape movie reviews](https://www.datawrapper.de/blog/movie-reviews-rating-scales)
- [Today — Beli](https://www.today.com/food/trends/what-is-beli-app-rcna217748) · [UChicago Bite — Beli](https://uchicagobite.com/blog/2023/3/1/beli-app-restaurant-hot-spots) · [Crumble — ranking apps](https://crumble.me/guides/restaurant-ranking-apps)
- [Untappd — How to check in](https://help.untappd.com/hc/en-us/articles/360034404451-How-to-Check-In-a-Beer)
- [Smashing Magazine — Product reviews and ratings UX](https://www.smashingmagazine.com/2023/01/product-reviews-ratings-ux/)
- [UX Planet — Designing user rating and reviews](https://uxplanet.org/how-to-design-user-rating-and-reviews-1b26c0208d3a)
- [Alchemer — When to ask for a rating](https://www.alchemer.com/resources/blog/ratings-prompts-when-and-how-to-ask-for-an-app-rating-2/) · [AppFollow — How to ask for reviews](https://appfollow.io/blog/how-to-ask-for-app-reviews)

Voice
- [NN/g — Voice interaction UX](https://www.nngroup.com/articles/voice-interaction-ux/)
- [NN/g — Intelligent assistant usability](https://www.nngroup.com/articles/intelligent-assistant-usability/)
- [Google — Conversation design: confirmations](https://developers.google.com/assistant/conversation-design/confirmations)
- [Otter — Speaker identification](https://help.otter.ai/hc/en-us/articles/360048258753-Speaker-identification) · [Recall.ai — Diarization](https://www.recall.ai/blog/speaker-diarization)
- [Pocket-lint — Voice Memos vs Recorder](https://www.pocket-lint.com/apple-voice-memos-google-recorder-comparison/) · [PopSci — voice recorder apps](https://www.popsci.com/story/diy/best-voice-recorder-apps/)
- [Dignited — WhatsApp recording lock](https://www.dignited.com/29799/whatsapp-voice-recording-lock/) · [BeingGuru — single-tap recording](https://beingguru.com/whatsapp-to-roll-out-easier-voice-recording/)
- [Parallel — VUI principles](https://www.parallelhq.com/blog/voice-user-interface-vui-design-principles) · [Aufait — VUI best practices](https://www.aufaitux.com/blog/voice-user-interface-design-best-practices/)

Maps, routes, time
- [Google Maps Platform — Search along route overview](https://developers.google.com/maps/documentation/places/web-service/sar-overview) · [reference](https://developers.google.com/maps/documentation/places/web-service/search-along-route) · [AFI blog](https://blog.afi.io/blog/google-maps-search-along-route/) · [Onix](https://www.onixnet.com/blog/discover-whats-on-the-road-ahead-with-google-maps-new-search-along-route-feature/)
- [Apple Support — Add stops to your route](https://support.apple.com/guide/iphone/find-stops-along-your-route-iph837d13d03/ios) · [AppleInsider — Apple Maps iOS 26](https://appleinsider.com/inside/apple-maps/tips/inside-apple-maps---how-to-get-the-most-out-of-your-iphones-navigation-app)
- [Routific — Waze vs Google Maps](https://www.routific.com/blog/waze-vs-google-maps)
- [Google — Ask Maps and Immersive Navigation](https://blog.google/products-and-platforms/products/maps/ask-maps-immersive-navigation/) · [MacRumors](https://www.macrumors.com/2026/03/12/google-maps-gemini-integration/)
- [GSMArena — Your Match](https://www.gsmarena.com/google_maps_adds_a_personalized_match_score_for_places_makes_group_outings_easier_to_organize-news-30937.php) · [Engadget](https://www.engadget.com/2018-07-31-google-maps-match-feature.html)
- [TravelTime — Isochrone use cases](https://docs.traveltime.com/api/use-cases/isochrones) · [TravelTime app](https://app.traveltime.com/) · [Marcus Fleckner — Isochrone maps](https://medium.com/map-quest/isochrone-maps-when-cities-are-drawn-in-minutes-not-meters-b3036e0fe034)
- [IXD@Pratt — Citymapper critique](https://www.ixd.prattsi.org/2026/02/design-critique-citymapper-ios-app/) · [Simon Hoffmann — Citymapper](https://medium.com/@simkhoff/ux-design-challenge-simplifying-city-travel-with-citymapper-132a58e0b200)

Trip planning and options
- [Google — Google Trips](https://blog.google/products/travel/see-more-plan-less-try-google-trips/) · [No Camera Bag review](https://nocamerabag.com/blog/review-google-trips-app-for-planning-trips) · [Transfer Desk review](https://transferdesk.com/travel-apps/google-trips-app-review-your-whole-trip-planned-in-seconds/)
- [Wanderlog — Time and distance between places](https://help.wanderlog.com/hc/en-us/articles/5159565134875-See-time-and-distance-between-places) · [Wanderlog vs TripIt](https://wanderlog.com/blog/2024/11/26/wanderlog-vs-tripit/)
- [Tripping — itinerary planner UX case study](https://medium.com/travel-itinerary-app/tripping-itinerary-planner-ux-case-study-1567dbd9e35d)
- [Lindy — AI trip planners 2026](https://www.lindy.ai/blog/trip-planner-app) · [Stippl — tested 2026](https://www.stippl.io/blog/best-ai-travel-planner-2026) · [Layla — comparison](https://layla.ai/blog/ai-travel-planners-comparison) · [TripStone — Mindtrip alternatives](https://tripstone.app/blog/mindtrip-alternatives)
- [NN/g — Mobile tables and comparisons](https://www.nngroup.com/articles/mobile-tables/) · [NN/g — Cards](https://www.nngroup.com/articles/cards-component/)
- [Shape of AI — pattern library](https://www.shapeof.ai/)

Preferences, households, onboarding
- [TechCrunch — Netflix profiles (2013)](https://techcrunch.com/2013/08/01/netflix-user-profiles/) · [Netflix Kids redesign (2021)](https://techcrunch.com/2021/04/13/netflix-gives-its-kids-profiles-a-visual-upgrade/)
- [Amazon — Parent Dashboard](https://www.amazon.com/gp/help/customer/display.html?nodeId=GNTST5RQEYKPGLYE) · [Google — Family Link](https://support.google.com/families/answer/6286986)
- [Marta Fioni — parents app field notes](https://medium.com/@martafioni/ux-design-field-notes-designing-and-app-to-connect-parents-63662c7d35ea)
- [Foods Connected — allergy apps](https://blog.foodsconnected.com/the-best-food-allergy-apps-and-how-they-work) · [Eastern Peak — allergy app development](https://easternpeak.com/blog/how-to-create-food-allergy-apps/) · [Bekey — allergy apps](https://bekey.io/blog/top-five-apps-for-food-allergy-sufferers)
- [Baymard — Food delivery UX benchmark 2026](https://baymard.com/blog/food-delivery-and-takeout-ux-benchmark-2026) · [Baymard — No results pages](https://baymard.com/blog/no-results-page)
- [ByteByteGo — DoorDash/Instacart/Uber Eats search](https://blog.bytebytego.com/p/why-doordash-instacart-and-uber-eats)
- [NN/g — Onboarding tutorials vs contextual help](https://www.nngroup.com/articles/onboarding-tutorials/)
- [Apple HIG — Entering data](https://developers.apple.com/design/human-interface-guidelines/patterns/entering-data) · [Apple HIG — Ratings and reviews](https://developer.apple.com/design/human-interface-guidelines/ratings-and-reviews)

Menus, offline
- [Veryfi — Restaurant menu OCR](https://www.veryfi.com/restaurant-menu-ocr-api/)
- [AppMaster — Offline-first sync UX](https://appmaster.io/blog/offline-first-background-sync-conflict-retries-ux) · [Google Open Health Stack — Offline & sync design](https://developers.google.com/open-health-stack/design/offline-sync-guideline) · [LeanCode — Offline app design](https://leancode.co/blog/offline-mobile-app-design)

Visits, memories, video
- [Apple Newsroom — Journal](https://www.apple.com/newsroom/2023/12/apple-launches-journal-app-a-new-app-for-reflecting-on-everyday-moments/) · [MacStories — Journal review](https://www.macstories.net/reviews/apples-journal-app-journaling-for-all/) · [Apple Developer — Journaling Suggestions API](https://developer.apple.com/videos/play/tech-talks/111384/) · [WWDC24 — Enhanced suggestions](https://developer.apple.com/videos/play/wwdc2024/10209/)
- [Google Maps Community — Unconfirmed places](https://support.google.com/maps/thread/5243541?hl=en)
- [Wikipedia — 1 Second Everyday](https://en.wikipedia.org/wiki/1_Second_Everyday) · [Miss Freddy — 1SE](https://missfreddy.com/digital-organizing/1-second-everyday/)
- [Goat Agency — BeReal](https://goatagency.com/blog/what-is-bereal/) · [Bloomberg — BeReal copies](https://www.bloomberg.com/news/articles/2022-09-15/tiktok-launches-spontaneous-photo-feature-similar-to-bereal) · [Nerdschalk — BeReal vs Snapchat](https://nerdschalk.com/bereal-and-snapchat-dual-camera-differences-and-similarities/)
- [DB Labs — Apple Photos Memories](https://dblabsapps.com/blog/apple-photos-memories-guide/) · [AppleInsider — Memory movies](https://appleinsider.com/inside/ios/tips/how-to-create-your-own-memories-movies-in-photos-on-ios-or-ipados-18) · [Google Photos — Featured memories](https://support.google.com/photos/answer/9454489)

Explainability, trust
- [Google PAIR — Explainability + Trust](https://pair.withgoogle.com/chapter/explainability-trust/)
- [CDT — "This is transparency to me"](https://cdt.org/wp-content/uploads/2022/10/algorithmic-transparency-ux-final-100322.pdf) · [Clutch — UX for AI-driven interfaces](https://clutch.co/resources/ux-ai-driven-interfaces)

Platform
- [MagicBell — PWA iOS limitations 2026](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide) · [OJapp — PWAs on iOS 2026](https://tips.ojapp.app/en/pwa-ios-2026-complete-guide/) · [OJapp — Safari limits](https://tips.ojapp.app/en/safari-pwa-limitations-2/) · [MobiLoud — PWAs on iOS](https://www.mobiloud.com/blog/progressive-web-apps-ios/)
- [Scandit — iOS re-asks camera permission](https://support.scandit.com/hc/en-us/articles/360008443011-Why-does-iOS-keep-asking-for-camera-permissions)
- [WebKit — MediaRecorder API](https://webkit.org/blog/11353/mediarecorder-api/) · [Build with Matija — MediaRecorder on iPhone Safari](https://www.buildwithmatija.com/blog/iphone-safari-mediarecorder-audio-recording-transcription)

Accessibility
- [Deque — Target size](https://dequeuniversity.com/rules/axe/4.9/target-size) · [AllAccessible — WCAG 2.5.8](https://www.allaccessible.org/blog/wcag-258-target-size-minimum-implementation-guide)
