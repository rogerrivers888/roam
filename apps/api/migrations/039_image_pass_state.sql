-- A region is not finished when it has been listed. It is finished when the
-- places on it have pictures.
--
-- `regions.harvest_state = 'done'` meant "we listed this county". Berkshire is
-- done by that measure and 186 of its 250 published attractions have no
-- photograph, because the target was raised from 18 to 250 and the image pass
-- was killed by a deploy before it caught up. Nothing in the system considered
-- that unfinished, so nothing would ever have gone back for it.
--
-- Two columns, so that "we already looked" and "we have not looked yet" stop
-- being the same absence:
--
--   image_state       null = never looked. 'found' = we hold one. 'none' = we
--                     looked and Commons had nothing whose licence permits
--                     keeping it, which is a real answer about a real place and
--                     not a failure to retry for ever. 'failed' = the looking
--                     itself broke, which is worth trying again.
--   image_checked_at  when, so a 'none' from six months ago can be revisited
--                     one day without revisiting one from this morning.
--
-- Without this the resume would loop: every pass would re-examine every
-- attraction that has no picture, including the ones that are never going to
-- have one, and the harvest would never converge.

alter table attractions add column if not exists image_state      text;
alter table attractions add column if not exists image_checked_at timestamptz;

-- Anything that already has a card image has plainly been looked at.
update attractions a set image_state = 'found', image_checked_at = now()
 where image_state is null
   and exists (select 1 from image_links l
                where l.subject_type = 'attraction' and l.subject_id = a.id::text and l.role = 'hero');

-- The index the image pass and the resume both ask the same question through:
-- "which published attractions has nobody looked for a picture for yet".
create index if not exists attractions_image_pending_idx
  on attractions (region_slug) where state = 'published' and image_state is null;
