/**
 * The owner's own limit in the Anthropic console, told apart from everything
 * else that can go wrong.
 *
 * Anthropic answers it with a 400 — "You have reached your specified workspace
 * API usage limits. You will regain access on 2026-10-01 at 00:00 UTC" — which
 * is a 400 the way a locked door is a 400: nothing about the request is wrong.
 * Read as an ordinary failure it came out of the app as "their menu would not
 * open… photograph it instead", which blames the restaurant, sends somebody to
 * do a job Roam had already done, and hides the one fact that would have fixed
 * it (owner, 6 Sep 2026).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { asBudgetError, ModelBudgetError } from '../src/claude.js';

const anthropic400 = () => Object.assign(
  new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified workspace API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."},"request_id":"req_011CemwY978WWBnZUmN447Vm"}'),
  { status: 400 },
);

test('the workspace limit is recognised, whatever status it arrives as', () => {
  const err = asBudgetError(anthropic400());
  assert.ok(err instanceof ModelBudgetError);
  assert.equal(err.code, 'model_budget_reached');
  assert.equal(err.status, 429, 'it is a ceiling, not a bad request');
  assert.equal(err.until, '2026-10-01');
});

test('the date is carried so a screen can say when, not just that', () => {
  assert.match(asBudgetError(anthropic400()).message, /2026-10-01/);
  // Worded without a date if they ever stop giving one.
  assert.equal(new ModelBudgetError(null).until, null);
});

test('an ordinary failure is left alone', () => {
  assert.equal(asBudgetError(new Error('400 bad request')), null);
  assert.equal(asBudgetError(new Error('fetch failed')), null);
  assert.equal(asBudgetError(undefined), null);
});

test('it also reads the shape the SDK throws, not only the message', () => {
  const sdkShape = Object.assign(new Error('Request failed'), {
    status: 400,
    error: { error: { type: 'invalid_request_error', message: 'You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.' } },
  });
  assert.equal(asBudgetError(sdkShape).until, '2026-11-01');
});
