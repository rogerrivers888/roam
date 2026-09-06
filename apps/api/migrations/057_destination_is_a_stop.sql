-- The place a day is for belongs on the day, not on the shortlist beside it.
--
-- Owner, 6 Sep 2026: "I've done another trip to Wembley Stadium. Wembley
-- Stadium is in my trip. That's where I'm going, but when I click on shortlist,
-- Wembley Stadium's there. When it's already selected, it should either be in
-- the trip or in the shortlist. It can't be in both." And, on the same trip:
-- "I did see Wembley Stadium in the events. It was like 'leave home, Wembley
-- Stadium, head home', but then I added a restaurant, and now Wembley has
-- disappeared… there is no stop at Wembley Stadium."
--
-- Both come from the same gap. A day out made from a card — Inspire → a place →
-- Create trip — wrote the venue twice: once as `trips.destination_*`, which is
-- geometry and has no identifier and cannot be a stop, and once as a shortlist
-- must-do, which is a *suggestion*. The day itself stayed empty, and the
-- timeline covered for that by drawing the destination only while there were no
-- stops at all. Add anything and the reason for the trip fell out of the plan.
--
-- New trips now put the destination on the day when it is a venue (a `ref` from
-- the card that was tapped), and this heals the ones already made. The
-- identifier is recovered from the shortlist row, because that is the only
-- place it was written down: a shortlist must-do sitting on top of the trip's
-- own destination is not a coincidence, it is the same tap recorded twice.
--
-- The shortlist row itself is left where it is. It carries the position, the
-- booking state and the day assignment the journey planner runs on, and the
-- rule the screens now keep — on the day, or on the shortlist, never both —
-- makes it disappear from the shortlist for the right reason rather than by
-- being deleted here.

insert into trip_stops (trip_id, day_id, slot, position, venue_ref, venue_name, lat, lng, dwell_minutes)
select
  t.id,
  d.id,
  'afternoon',
  coalesce((select max(s.position) from trip_stops s where s.day_id = d.id), 0) + 1,
  i.venue_ref,
  coalesce(t.destination_label, i.venue_label),
  t.destination_lat,
  t.destination_lng,
  -- The window, less the driving each way at the speed the estimator would
  -- have used anyway. An hour at the least: a day out that cannot fit an hour
  -- at the place it is named after is a day out with a wrong window, not a
  -- stop worth shortening.
  greatest(60, round(extract(epoch from (t.return_at - t.depart_at)) / 60)::int - 120)
from trips t
join trip_days d on d.trip_id = t.id
join trip_shortlist i on i.trip_id = t.id
where t.kind = 'outing'
  and t.destination_lat is not null
  and d.date = (select min(d2.date) from trip_days d2 where d2.trip_id = t.id)
  -- The shortlist row that is standing on the destination, within 250 metres.
  and sqrt(
        power((i.lat - t.destination_lat) * 111.32, 2)
      + power((i.lng - t.destination_lng) * 111.32 * cos(radians(t.destination_lat)), 2)
      ) < 0.25
  -- Only where the day has not got it already.
  and not exists (
    select 1 from trip_stops s where s.trip_id = t.id and s.venue_ref = i.venue_ref
  );
