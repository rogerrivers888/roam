-- Which place sources a trip's searches and plans may use (docs/technical-constraints.md §3.3):
-- null = the default set (every live source except opt-in ones such as Tripadvisor).
alter table trips add column sources jsonb;
