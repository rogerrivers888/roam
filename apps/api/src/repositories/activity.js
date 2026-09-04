/**
 * What a household has actually done, and how much time they spend doing it.
 *
 * The owner, 4 Sep 2026: "Can I see their activity, like some stuff around what
 * they've done, like creating places, and the level of activity and time on
 * site."
 *
 * **The feed is a union over the tables the work already lives in**, not a
 * parallel event log. A place saved is a row in `household_places`; a rating is
 * a row in `ratings`; a trip is a trip. Reading those means the timeline shows
 * what happened rather than what somebody remembered to instrument — and a
 * feature added next year appears in it the moment it writes its own row, or
 * not at all, which is a defect you can see rather than one you cannot.
 *
 * `activity_events` carries only the two things no other table knows: that
 * somebody was here (heartbeats, which is the only honest source for time on
 * site) and what they were looking at. Deliberately coarse — no scroll depth, no
 * pointer tracking, nothing leaving this database.
 */

import { query } from '../db.js';

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

const KINDS = new Set(['screen', 'heartbeat', 'install', 'action']);
/** A heartbeat may never claim more than this. A tab left open overnight is not five hours of use. */
const MAX_SECONDS = 300;

/**
 * A batch from one device.
 *
 * Batched because the alternative is a request per screen change, which would
 * be more traffic than the app itself makes. Everything is clamped and filtered
 * here rather than trusted: the client is a browser, and the numbers it sends
 * end up in the owner's reporting.
 */
export async function recordEvents({ accountId, householdId, events }) {
  const clean = (Array.isArray(events) ? events : [])
    .filter((e) => e && KINDS.has(e.kind))
    .slice(0, 100)
    .map((e) => ({
      kind: e.kind,
      screen: e.screen ? String(e.screen).slice(0, 60) : null,
      subject: e.subject ? String(e.subject).slice(0, 120) : null,
      seconds: Number.isFinite(e.seconds) ? Math.max(0, Math.min(MAX_SECONDS, Math.round(e.seconds))) : null,
      at: e.at && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at) : new Date(),
    }));
  if (!clean.length) return 0;

  // One statement for the batch: unnest is what keeps a hundred screen changes
  // from being a hundred round trips.
  await query(
    `insert into activity_events (account_id, household_id, kind, screen, subject, seconds, at)
     select $1, $2, k, s, sub, sec, t
       from unnest($3::text[], $4::text[], $5::text[], $6::int[], $7::timestamptz[]) as e(k, s, sub, sec, t)`,
    [accountId ?? null, householdId ?? null,
      clean.map((e) => e.kind), clean.map((e) => e.screen), clean.map((e) => e.subject),
      clean.map((e) => e.seconds), clean.map((e) => e.at)],
  );
  return clean.length;
}

// ---------------------------------------------------------------------------
// one household's timeline
// ---------------------------------------------------------------------------

/**
 * Everything one household has done, newest first.
 *
 * Each branch names itself in the words the screen shows, so the feed reads as
 * sentences rather than table names: "saved a place", "rated a dish", "planned
 * a trip". `weight` is what the activity score counts — a rating is a bigger
 * signal of a household using Roam than a screen view is.
 */
export async function feedFor(householdId, { limit = 60, since = null } = {}) {
  const { rows } = await query(
    `
    with events as (
      select 'place'   as kind, p.first_seen as at, p.label as title,
             coalesce(p.locality, p.country, '') as detail, p.venue_ref as subject, 3 as weight
        from household_places p where p.household_id = $1
      union all
      select 'visit', v.created_at, coalesce(v.venue_label, 'a place'), coalesce(v.locality, ''), v.venue_ref, 4
        from visits v where v.household_id = $1
      union all
      -- take is an enum, so it is cast before it can sit in a text column
      -- beside a locality and a category.
      select 'rating', r.created_at, coalesce(r.subject, r.concept_key, 'a dish'),
             coalesce(r.take::text, ''), r.concept_key, 5
        from ratings r
        join visits v on v.id = r.visit_id
       where v.household_id = $1
      union all
      select 'trip', t.created_at, coalesce(t.title, t.place_label, t.destination_label, 'a trip'),
             coalesce(t.locality, t.country, ''), t.id::text, 5
        from trips t where t.household_id = $1
      union all
      select 'shortlist', s.added_at, coalesce(s.venue_label, 'a place'), coalesce(s.category, ''), s.venue_ref, 2
        from trip_shortlist s join trips t on t.id = s.trip_id where t.household_id = $1
      union all
      select 'plan', ps.created_at, 'Planned a day', coalesce(ps.state->>'phase', ''), ps.id::text, 3
        from plan_sessions ps where ps.household_id = $1
      union all
      select 'menu', m.created_at, coalesce(m.venue_label, 'a menu'), coalesce(m.source_kind, ''), m.venue_ref, 3
        from menus m where m.household_id = $1
      union all
      select 'order', o.created_at, coalesce(o.venue_label, 'an order'), '', o.venue_ref, 4
        from orders o where o.household_id = $1
      union all
      select 'group', g.created_at, coalesce(g.name, 'a group trip'), '', g.id::text, 4
        from trip_groups g where g.household_id = $1
      union all
      select 'sign_in', s.created_at, 'Signed in', coalesce(s.label, s.method), s.id::text, 1
        from account_sign_ins s
        join accounts a on a.id = s.account_id
       where a.household_id = $1
    )
    select * from events
     where ($3::timestamptz is null or at >= $3)
     order by at desc
     limit $2`,
    [householdId, limit, since],
  );
  return rows;
}

/**
 * The figures above the timeline.
 *
 * `time on site` is the sum of heartbeat seconds, not last-minus-first: a tab
 * left open in another window is not two hours of use, and a session that ended
 * when the laptop shut has no closing event to subtract from.
 */
export async function summaryFor(householdId, { days = 30 } = {}) {
  const { rows } = await query(
    `select
       (select count(*)::int from household_places where household_id = $1)                                as places,
       (select count(*)::int from household_places where household_id = $1 and first_seen >= now() - ($2 || ' days')::interval) as places_window,
       (select count(*)::int from visits where household_id = $1)                                          as visits,
       (select count(*)::int from trips where household_id = $1)                                           as trips,
       (select count(*)::int from ratings r join visits v on v.id = r.visit_id where v.household_id = $1)   as ratings,
       (select count(*)::int from plan_sessions where household_id = $1)                                    as plans,
       (select count(*)::int from orders where household_id = $1)                                           as orders,
       (select count(*)::int from menus where household_id = $1)                                            as menus,
       (select coalesce(sum(seconds), 0)::int from activity_events
         where household_id = $1 and kind = 'heartbeat')                                                    as seconds_ever,
       (select coalesce(sum(seconds), 0)::int from activity_events
         where household_id = $1 and kind = 'heartbeat' and at >= now() - ($2 || ' days')::interval)         as seconds_window,
       (select count(distinct date_trunc('day', at))::int from activity_events
         where household_id = $1 and at >= now() - ($2 || ' days')::interval)                                as days_active,
       (select max(at) from activity_events where household_id = $1)                                         as last_active`,
    [householdId, String(days)],
  );
  return rows[0];
}

/** Which screens they spend their time on — "level of activity", by where it happens. */
export async function screensFor(householdId, { days = 30 } = {}) {
  const { rows } = await query(
    `select screen,
            count(*) filter (where kind = 'screen')::int as views,
            coalesce(sum(seconds) filter (where kind = 'heartbeat'), 0)::int as seconds
       from activity_events
      where household_id = $1 and screen is not null and at >= now() - ($2 || ' days')::interval
      group by screen
      order by seconds desc, views desc
      limit 20`,
    [householdId, String(days)],
  );
  return rows;
}

/** A day-by-day series for one household, for the sparkline on their record. */
export async function dailyFor(householdId, { days = 30 } = {}) {
  const { rows } = await query(
    `select to_char(d.day, 'YYYY-MM-DD') as day,
            coalesce(sum(e.seconds) filter (where e.kind = 'heartbeat'), 0)::int as seconds,
            count(e.id) filter (where e.kind = 'screen')::int as views
       from generate_series(date_trunc('day', now()) - (($2 - 1) || ' days')::interval, date_trunc('day', now()), '1 day') as d(day)
       left join activity_events e
              on e.household_id = $1 and date_trunc('day', e.at) = d.day
      group by d.day order by d.day`,
    [householdId, days],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// the estate
// ---------------------------------------------------------------------------

/**
 * Daily active households, and what they did, across everybody.
 *
 * "Active" is a household that produced any event that day — a heartbeat counts,
 * because being in the app is the behaviour the number is about.
 */
export async function estateDaily({ days = 30 } = {}) {
  const { rows } = await query(
    `select to_char(d.day, 'YYYY-MM-DD') as day,
            count(distinct e.household_id)::int                                     as households,
            coalesce(sum(e.seconds) filter (where e.kind = 'heartbeat'), 0)::int    as seconds,
            count(e.id) filter (where e.kind = 'screen')::int                        as views,
            (select count(*)::int from household_places p
              where date_trunc('day', p.first_seen) = d.day)                         as places,
            (select count(*)::int from trips t where date_trunc('day', t.created_at) = d.day) as trips,
            (select count(*)::int from visits v where date_trunc('day', v.created_at) = d.day) as visits
       from generate_series(date_trunc('day', now()) - (($1 - 1) || ' days')::interval, date_trunc('day', now()), '1 day') as d(day)
       left join activity_events e on date_trunc('day', e.at) = d.day
      group by d.day order by d.day`,
    [days],
  );
  return rows;
}

/** Active households over three windows, and the stickiness ratio between two of them. */
export async function activeCounts() {
  const { rows } = await query(
    `select
       (select count(distinct household_id)::int from activity_events where at >= now() - interval '1 day')  as dau,
       (select count(distinct household_id)::int from activity_events where at >= now() - interval '7 days') as wau,
       (select count(distinct household_id)::int from activity_events where at >= now() - interval '30 days') as mau,
       (select coalesce(sum(seconds), 0)::int from activity_events where kind = 'heartbeat' and at >= now() - interval '30 days') as seconds_30d`,
  );
  return rows[0];
}

/**
 * Retention by joining week: of the households that started in a week, how many
 * came back in each of the weeks after it.
 *
 * The standard cohort grid, and the one figure that says whether Roam is worth
 * having rather than worth trying.
 */
export async function retentionCohorts({ weeks = 8 } = {}) {
  // Two small reads rather than one clever one: the cohorts and their sizes,
  // then one row per cohort × week. The grid is weeks × cohorts — dozens of
  // rows — so the second query costs nothing and the first stays readable.
  const { rows: cohorts } = await query(
    `select to_char(date_trunc('week', a.created_at), 'YYYY-MM-DD') as cohort,
            count(distinct a.household_id)::int as size
       from accounts a
      where a.created_at >= date_trunc('week', now()) - (($1 - 1) || ' weeks')::interval
      group by 1 order by 1`,
    [weeks],
  );
  const { rows: cells } = await query(
    `with joined as (
       select a.household_id, date_trunc('week', a.created_at) as cohort
         from accounts a
        where a.created_at >= date_trunc('week', now()) - (($1 - 1) || ' weeks')::interval
     )
     select to_char(j.cohort, 'YYYY-MM-DD') as cohort,
            floor(extract(epoch from (date_trunc('week', e.at) - j.cohort)) / 604800)::int as week_no,
            count(distinct j.household_id)::int as households
       from joined j
       join activity_events e on e.household_id = j.household_id and e.at >= j.cohort
      group by 1, 2 order by 1, 2`,
    [weeks],
  );
  return { cohorts, cells };
}

/** The busiest screens across every household — what the product is actually for. */
export async function estateScreens({ days = 30 } = {}) {
  const { rows } = await query(
    `select screen,
            count(*) filter (where kind = 'screen')::int as views,
            count(distinct household_id)::int as households,
            coalesce(sum(seconds) filter (where kind = 'heartbeat'), 0)::int as seconds
       from activity_events
      where screen is not null and at >= now() - ($1 || ' days')::interval
      group by screen order by views desc limit 25`,
    [String(days)],
  );
  return rows;
}

/**
 * Everything that has happened lately, across every household — the estate's
 * own feed, for the Activity screen.
 */
export async function estateFeed({ limit = 100 } = {}) {
  const { rows } = await query(
    `select k.kind, k.at, k.title, k.detail, k.household_id,
            h.name as household_name, a.email as account_email
       from (
         select 'place' as kind, p.first_seen as at, p.label as title, coalesce(p.locality, '') as detail, p.household_id
           from household_places p
         union all
         select 'visit', v.created_at, coalesce(v.venue_label, 'a place'), coalesce(v.locality, ''), v.household_id from visits v
         union all
         select 'trip', t.created_at, coalesce(t.title, t.place_label, 'a trip'), coalesce(t.locality, ''), t.household_id from trips t
         union all
         select 'order', o.created_at, coalesce(o.venue_label, 'an order'), '', o.household_id from orders o
         union all
         select 'menu', m.created_at, coalesce(m.venue_label, 'a menu'), '', m.household_id from menus m
       ) k
       join households h on h.id = k.household_id
       left join accounts a on a.household_id = k.household_id
      order by k.at desc limit $1`,
    [limit],
  );
  return rows;
}

/** Per-account engagement, for the People table's activity columns. */
export async function engagementByAccount({ days = 30 } = {}) {
  const { rows } = await query(
    `select a.id as account_id,
            coalesce(sum(e.seconds) filter (where e.kind = 'heartbeat'), 0)::int as seconds,
            count(e.id) filter (where e.kind = 'screen')::int                     as views,
            count(distinct date_trunc('day', e.at))::int                          as days_active,
            max(e.at)                                                             as last_active
       from accounts a
       left join activity_events e
              on e.household_id = a.household_id and e.at >= now() - ($1 || ' days')::interval
      group by a.id`,
    [String(days)],
  );
  return rows;
}
