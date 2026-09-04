/**
 * The take and the score, which used to be worked out in the browser.
 *
 * Both directions of the scale now live on the server (rule 7: business logic
 * belongs in the backend), so this is the only place either is written down and
 * the only place either needs testing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreFromTake, takeFromScore } from '../src/routes/places.js';
import { TAKES } from '../src/constants.js';

test('stars become the word the planner learns from', () => {
  assert.equal(takeFromScore(5), 'loved');
  assert.equal(takeFromScore(4.5), 'loved');
  assert.equal(takeFromScore(4), 'loved');
  assert.equal(takeFromScore(3.5), 'fine');
  assert.equal(takeFromScore(3), 'fine');
  assert.equal(takeFromScore(2.5), 'fine');
  assert.equal(takeFromScore(2), 'not_for_me');
  assert.equal(takeFromScore(0.5), 'not_for_me');
});

test('a word on its own still gives the row a number', () => {
  // Owner, 4 Sep 2026: one tap for "everyone loved it". That visit has to rank
  // beside one somebody gave four stars, so the word carries a score.
  assert.equal(scoreFromTake('loved'), 5);
  assert.equal(scoreFromTake('fine'), 3);
  assert.equal(scoreFromTake('not_for_me'), 1);
  assert.equal(scoreFromTake('nonsense'), null);
  assert.equal(scoreFromTake(undefined), null);
});

test('the two directions agree with each other', () => {
  for (const take of TAKES) {
    assert.equal(takeFromScore(scoreFromTake(take)), take, `${take} does not survive the round trip`);
  }
});

test('every take the scale knows is a take the database accepts', () => {
  // `take` is a Postgres enum (migration 002); a word this file invented would
  // fail on insert rather than at the door.
  assert.deepEqual([...TAKES].sort(), ['fine', 'loved', 'not_for_me']);
});
