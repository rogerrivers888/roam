// A search's meter: how many billable units each provider consumed while it
// ran. `searchAllSources` hands one to every adapter through `params.meter`;
// the route writes the totals to provider_calls.units so Settings › Usage can
// show how much of each free allowance has gone (Technical Constraints §11,
// §14 "cost per source"). Adapters count what the provider bills for —
// requests for most, location IDs for Tripadvisor, elements for Routes.
export const bump = (meter, key, n = 1) => {
  if (!meter || !n) return;
  meter[key] = (meter[key] || 0) + n;
};
