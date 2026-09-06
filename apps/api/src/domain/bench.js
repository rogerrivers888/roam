/**
 * Is our number right?
 *
 * Owner, 5 Sep 2026: "I want to be able to hit the API, check this, check our
 * ratings, compare them to their ratings, and show them in a table… that's
 * absolutely fundamental to what we do."
 *
 * The comparison is of two *orderings*, not two numbers. That is not a dodge
 * around the retention rule — it is the better test. A rating is damped almost
 * flat at the top of a market (every one of Windsor's twenty-five bands "top",
 * and the spread across the whole first page is 4.5 to 4.8), so comparing
 * decimals would mostly compare noise. Where the two lists *disagree about
 * order* is where a real difference of opinion lives, and that is the thing
 * worth reading one row at a time.
 *
 * Three numbers come out, and each answers a different question:
 *
 *   agreement    Spearman's ρ over the places both lists hold. 1 is the same
 *                order, 0 is unrelated, −1 is upside down.
 *   disputes     how many places sit five or more positions apart. The average
 *                can look healthy while a handful are badly wrong, and it is
 *                the handful you can actually act on.
 *   ownedAgree   the same ρ between our composite and our *owned* score — the
 *                one with the licensed input removed. This is the number that
 *                says whether the ranking survives the key dying, and it is the
 *                reason `owned_score` is stored at all.
 */

/**
 * Spearman's rank correlation.
 *
 * Written out rather than pulled in: it is six lines, and a dependency for six
 * lines is a dependency to keep up to date for ever. Ties are averaged, because
 * two places on the same score genuinely share a position and breaking the tie
 * by name would invent a disagreement.
 */
export function spearman(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  const rank = (values) => {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
      const average = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[order[k][1]] = average;
      i = j + 1;
    }
    return out;
  };
  const a = rank(pairs.map((p) => p[0]));
  const b = rank(pairs.map((p) => p[1]));
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(a); const mb = mean(b);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? Math.round((num / Math.sqrt(da * db)) * 1000) / 1000 : null;
}

/** Five or more positions apart is a disagreement worth a person reading. */
const DISPUTE = 5;

/**
 * Join our ranking to theirs and say where they differ.
 *
 * `ours` is our rows for the area, best first; `theirs` is `benchArea`'s ranks.
 * Anything only one list holds is reported as such rather than dropped: a place
 * we keep that they do not rank at all is itself a finding, and so is the
 * reverse.
 */
export function compare({ ours = [], theirs = [] } = {}) {
  const theirsByRef = new Map(theirs.map((t) => [t.venueRef, t]));
  const oursByRef = new Map(ours.map((o) => [o.venueRef, o]));

  const rows = [];
  const pairs = [];
  const ownedPairs = [];

  ours.forEach((o, i) => {
    const ourRank = i + 1;
    const t = theirsByRef.get(o.venueRef);
    if (o.roamScore != null && o.ownedScore != null) ownedPairs.push([o.roamScore, o.ownedScore]);
    if (!t) {
      rows.push({ ...o, ourRank, theirRank: null, delta: null, only: 'ours' });
      return;
    }
    pairs.push([ourRank, t.theirRank]);
    rows.push({
      ...o,
      ourRank,
      theirRank: t.theirRank,
      delta: t.theirRank - ourRank,
      crowdBand: t.crowdBand,
      countBand: t.countBand,
      only: null,
    });
  });

  for (const t of theirs) {
    if (oursByRef.has(t.venueRef)) continue;
    rows.push({
      venueRef: t.venueRef, name: t.name, roamScore: null, ownedScore: null,
      ourRank: null, theirRank: t.theirRank, delta: null,
      crowdBand: t.crowdBand, countBand: t.countBand, only: 'theirs',
    });
  }

  // Biggest disagreements first: the whole point of the screen is the handful
  // that are badly wrong, not the many that agree.
  rows.sort((a, b) => {
    if (a.only && !b.only) return 1;
    if (b.only && !a.only) return -1;
    return Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0);
  });

  const bands = rows.map((r) => r.crowdBand).filter(Boolean);
  const topOnly = bands.length ? bands.every((b) => b === bands[0]) : false;

  return {
    rows,
    verdict: {
      compared: pairs.length,
      onlyOurs: rows.filter((r) => r.only === 'ours').length,
      onlyTheirs: rows.filter((r) => r.only === 'theirs').length,
      agreement: spearman(pairs),
      // How well our own number tracks the one with their input taken out. Low
      // here means the ranking would move a long way if the key died.
      ownedAgreement: spearman(ownedPairs),
      disputes: rows.filter((r) => r.delta != null && Math.abs(r.delta) >= DISPUTE).length,
      disputeThreshold: DISPUTE,
      // A band that is the same for every place carries no information at all,
      // and it is worth saying so out loud rather than letting a column of
      // identical words look like agreement.
      bandSaturated: topOnly && bands.length > 3 ? bands[0] : null,
      bandsSeen: [...new Set(bands)],
    },
  };
}
