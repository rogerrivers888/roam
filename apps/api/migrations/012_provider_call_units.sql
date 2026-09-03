-- What each provider actually bills for, per call. A search fans out to
-- several sources and each counts differently: Google bills per request,
-- Tripadvisor per location ID returned, Routes per matrix element. One row per
-- search keeps the session and household bounds meaning what they meant; the
-- units say what that search consumed of each provider's allowance, e.g.
-- {"google": 2, "tripadvisor": 12, "datathistle": 1}. Null on rows written
-- before this column existed (Settings › Usage estimates those).
alter table provider_calls add column if not exists units jsonb;
