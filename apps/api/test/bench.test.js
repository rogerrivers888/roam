// The rating bench: does our order agree with theirs, and where does it not.
//
// The comparison is of two orderings rather than two numbers, deliberately — a
// rating is damped almost flat at the top of a market, so comparing decimals
// mostly compares noise. These tests pin the arithmetic and, more importantly,
// the judgements around it: that a place only one list holds is reported rather
// than dropped, and that a column of identical bands is called out as carrying
// no information rather than left looking like agreement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, spearman } from '../src/domain/bench.js';

test('rank correlation is 1 for the same order and −1 for its reverse', () => {
  assert.equal(spearman([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]), 1);
  assert.equal(spearman([[1, 5], [2, 4], [3, 3], [4, 2], [5, 1]]), -1);
});

test('ties share a position rather than being broken by accident', () => {
  // Two places on the same score genuinely share a rank. Breaking the tie by
  // whatever order they arrived in would invent a disagreement.
  const tied = spearman([[1, 1], [1, 1], [3, 3]]);
  assert.ok(tied === 1, `expected perfect agreement across a tie, got ${tied}`);
});

test('too few places to say anything gives null, not a confident number', () => {
  assert.equal(spearman([[1, 1], [2, 2]]), null);
});

const ours = [
  { venueRef: 'a', name: 'Antalya', roamScore: 6.7, ownedScore: 3.4 },
  { venueRef: 'b', name: 'Meimo', roamScore: 6.7, ownedScore: 3.5 },
  { venueRef: 'c', name: "Sebastian's", roamScore: 6.5, ownedScore: 3.9 },
  { venueRef: 'd', name: 'Sushi Point', roamScore: 5.9, ownedScore: 1.7 },
  { venueRef: 'e', name: 'Kept by us alone', roamScore: 5.0, ownedScore: 2.0 },
];

const theirs = [
  { venueRef: 'd', name: 'Sushi Point', theirRank: 1, crowdBand: 'top', countBand: 'many' },
  { venueRef: 'a', name: 'Antalya', theirRank: 2, crowdBand: 'top', countBand: 'thousands' },
  { venueRef: 'c', name: "Sebastian's", theirRank: 3, crowdBand: 'top', countBand: 'many' },
  { venueRef: 'b', name: 'Meimo', theirRank: 4, crowdBand: 'top', countBand: 'many' },
  { venueRef: 'z', name: 'Ranked by them alone', theirRank: 5, crowdBand: 'high', countBand: 'few' },
];

test('a place only one list holds is a finding, not something to drop', () => {
  const { rows, verdict } = compare({ ours, theirs });
  assert.equal(verdict.onlyOurs, 1);
  assert.equal(verdict.onlyTheirs, 1);
  assert.equal(rows.find((r) => r.venueRef === 'e').only, 'ours');
  assert.equal(rows.find((r) => r.venueRef === 'z').only, 'theirs');
  // Neither counts towards the correlation: there is no pair to correlate.
  assert.equal(verdict.compared, 4);
});

test('the biggest disagreements come first, and the unmatched come last', () => {
  const { rows } = compare({ ours, theirs });
  const deltas = rows.filter((r) => r.delta != null).map((r) => Math.abs(r.delta));
  assert.deepEqual(deltas, [...deltas].sort((a, b) => b - a));
  assert.ok(rows.at(-1).only, 'a place only one list holds belongs at the bottom');
});

test('a band that is the same for everybody is called out as carrying nothing', () => {
  // Every one of Windsor's twenty-five bands "top". A column of identical words
  // must not be allowed to read as agreement.
  const allTop = theirs.slice(0, 4).map((t) => ({ ...t, crowdBand: 'top' }));
  const { verdict } = compare({ ours, theirs: allTop });
  assert.equal(verdict.bandSaturated, 'top');

  const mixed = compare({ ours, theirs });
  assert.equal(mixed.verdict.bandSaturated, null, 'two different bands is not saturation');
});

test('owned agreement is measured, because it is what survives the key dying', () => {
  const { verdict } = compare({ ours, theirs });
  assert.ok(typeof verdict.ownedAgreement === 'number');
  // Our composite and our owned score disagreeing means the ranking would move
  // if the licensed input went away — which is the whole reason it is stored.
  assert.ok(verdict.ownedAgreement < 1);
});

test('nothing in the answer carries a rating', () => {
  const { rows } = compare({ ours, theirs });
  const forbidden = ['rating', 'userRatingCount', 'count', 'adjusted'];
  for (const row of rows) {
    for (const key of forbidden) {
      assert.ok(!(key in row), `${key} must not reach the bench's answer`);
    }
  }
});
