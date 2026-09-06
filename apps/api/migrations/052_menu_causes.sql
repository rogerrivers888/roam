-- Sixty-three sentences for a hundred and twenty-six failures.
--
-- Owner, 5 Sep 2026: "There's definitely some reporting required on places we
-- haven't been able to recover… areas where, in restaurants, it's menus you
-- haven't been able to read."
--
-- `place_menus.why` already says why, and says it well — "Nothing on
-- www.caldesi.com says menu — it may be a picture, or on their booking page."
-- But it carries a hostname or an anchor label in most cases, so production
-- held sixty-three distinct shapes across a hundred and twenty-six rows. That
-- cannot be counted, charted or worked in priority order, and a change to the
-- crawler cannot be shown to have helped.
--
-- So a cause is written **beside** the sentence rather than instead of it. The
-- sentence is what tells you what to do about one place; the cause is what
-- makes a hundred of them a number that moves. The closed set and the reader
-- that fills it live in `domain/menuCauses.js`, deliberately in code rather
-- than in a lookup table: it is a piece of judgement about English, it changes
-- when the crawler changes, and it must be replayable over rows that were
-- written before it existed.

alter table place_menus add column if not exists cause text;

-- Only the rows that failed carry one. A menu that was read has no cause, and
-- a menu whose address is known but unread is work outstanding rather than a
-- failure — counting it as one would inflate every number on the report.
create index if not exists place_menus_cause_idx on place_menus (cause) where cause is not null;
