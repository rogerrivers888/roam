-- A like can be a favourite: "we like lots of dishes, but Phoenix will
-- generally pick this one". Favourites rank above ordinary likes; they never
-- exclude anything.

alter table member_constraints add column favourite boolean not null default false;
