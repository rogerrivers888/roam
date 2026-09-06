-- Inviting the people you already live with.
--
-- The owner, 6 Sep 2026: "in the Household tab, how can I invite Gina and
-- anyone else that's in my household to the app?"
--
-- Roam had two half-answers and neither was this one. `members` is a profile —
-- Gina's allergens, her dislikes, what she thought of the tapas place — with no
-- way to sign in. `accounts` (033) is a way to sign in that always brings a
-- household of its own, because it was built to give Roam to *friends*, and its
-- own comment says the failure it was avoiding: "an account that shared a
-- household would see the owner's home address, his children's birthdays and
-- every rating the family has given".
--
-- That is exactly what Gina is supposed to see. She lives there. So this
-- migration joins the two: an account may point at a member of a household that
-- already exists, and then signing in as that account resolves — through the
-- one seam, `currentHousehold()` — to the household she is in rather than to a
-- new empty one.
--
-- Three decisions, each of them a decision rather than a default:
--
--   * **A household member is a full peer** (owner, 6 Sep 2026, asked and
--     answered: "Everything, no exceptions"). There is no new capability and no
--     new door, because there is nothing here to gate: `accessFor` already
--     gives an account with no role the client door and nothing else, and every
--     route inside the client door is scoped to the household both of them are
--     in. Gina can plan a trip, rate a place, change the pace, see the spend and
--     delete the household — the same as the person who invited her.
--
--   * **A mobile is a credential as much as an address is.** Gina may have no
--     e-mail she checks, so `email` becomes nullable and `mobile` joins it; an
--     account needs one of the two and is unique on each. Both are the
--     household's own record of its own people — owned, not rented — so they sit
--     on `members` as well, where the Household tab edits them.
--
--   * **Taking access away is not deleting a person, but deleting a person does
--     take their access away.** Gina's account can go while her profile, her
--     allergens and every rating she has given stay exactly where they are —
--     `DELETE /members/:id/invite` is that, and it is a different act from
--     removing her. The other direction is not symmetrical and must not be:
--     `member_id` cascades, so deleting the profile deletes the account and
--     `api_sessions` cascades behind it. A profile that is gone leaving behind a
--     live way in to the household would be the worst kind of quiet failure.

-- How to reach a person in the household. Their own contact details, kept
-- because they asked us to send them a link — never a provider's, never rented.
alter table members add column if not exists email  text;
alter table members add column if not exists mobile text;

-- Which person in the household this account is. Null for every account that
-- came before: an owner, or a friend on a household of their own.
alter table accounts add column if not exists member_id uuid references members(id) on delete cascade;
create unique index if not exists accounts_member_idx on accounts (member_id) where member_id is not null;

-- A mobile signs in the same way an address does, so it is held to the same
-- rule: one person, one account, however they were invited.
alter table accounts add column if not exists mobile text;
create unique index if not exists accounts_mobile_idx on accounts (mobile) where mobile is not null;

-- An address was mandatory while the only way in was an e-mailed link. It is
-- not any more, but one of the two still is: an account nobody can send a link
-- to is an account nobody can ever use.
alter table accounts alter column email drop not null;
do $$ begin
  alter table accounts add constraint accounts_reachable check (email is not null or mobile is not null);
exception when duplicate_object then null; end $$;

-- The unique index on `lower(email)` was built when the column could not be
-- null. Postgres treats nulls as distinct, so it would already allow any number
-- of mobile-only accounts; it is rebuilt as a partial index to say so out loud.
drop index if exists accounts_email_idx;
create unique index if not exists accounts_email_idx on accounts (lower(email)) where email is not null;

-- How the link was asked to go out, as distinct from what became of it.
-- `delivery` has always recorded the outcome ('email', 'no_sender',
-- 'send_failed'); this records the intent, so "sent by text, and it failed" and
-- "sent by e-mail, and it failed" are different rows rather than the same one.
alter table sign_in_links add column if not exists channel text;
