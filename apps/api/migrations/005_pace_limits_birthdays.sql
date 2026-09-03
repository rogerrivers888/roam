-- Nuance the household asked for: a preference can carry a time limit
-- ("walks, up to 40 minutes"), age comes from a birthday, pace differs between
-- eating and doing, and a place can be special enough to bend the rules.

alter table member_constraints add column max_minutes integer;   -- "up to N minutes" for this preference

alter table members add column birth_date date;                  -- exact; birth_year kept for older rows

-- Pace by kind of stop. Shape:
-- { "food":     { "typicalMinutes": 60,  "maxMinutes": 120, "maxTravelMinutes": 30,  "maxTravelIfSpecialMinutes": 45 },
--   "activity": { "typicalMinutes": 150, "maxMinutes": 360, "maxTravelMinutes": 60,  "maxTravelIfSpecialMinutes": 180 } }
alter table households add column pace jsonb;

-- A place the household would go further for.
alter type ledger_status add value if not exists 'special';
