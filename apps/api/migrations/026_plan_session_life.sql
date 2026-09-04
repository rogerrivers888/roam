-- How long a planning session lives (owner, 4 Sep 2026: "10 hours is also
-- fine, so yes, please do that").
--
-- This is what "come back to what you left" is bounded by: the Plan screen
-- keeps only the session's identifier on the device and asks the server for the
-- ideas again, so the session's life *is* how long the ideas are still there.
--
-- Ten rather than the twelve it was. A run at nine in the morning is still
-- there at seven in the evening, which is the day; and it is licensed content
-- held on our side (the ideas carry the provider's venue names and ratings),
-- so shorter is the better direction to be wrong in.
alter table plan_sessions alter column expires_at set default (now() + interval '10 hours');

-- Sessions already made keep the life they were made with; nothing in flight
-- is cut short by this.
