/**
 * The door, tested at the level where getting it wrong is silent.
 *
 * A passcode check that returns true for the wrong length, a "public" list that
 * quietly matches more than it means to, an origin allowlist that lets anything
 * through — none of these break a screen. They just stop protecting anything,
 * and nobody notices until it matters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const withPasscode = async (value, fn) => {
  const before = process.env.ROAM_PASSCODE;
  if (value === null) delete process.env.ROAM_PASSCODE; else process.env.ROAM_PASSCODE = value;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.ROAM_PASSCODE; else process.env.ROAM_PASSCODE = before;
  }
};

const { authConfigured, isPublicPath, originAllowed, passcodeMatches } = await import('../src/auth.js');

test('the right passcode opens it and nothing else does', async () => {
  await withPasscode('correct horse battery staple', () => {
    assert.equal(passcodeMatches('correct horse battery staple'), true);
    assert.equal(passcodeMatches('correct horse battery stapl'), false, 'one character short');
    assert.equal(passcodeMatches('correct horse battery staple '), false, 'one character long');
    assert.equal(passcodeMatches('CORRECT HORSE BATTERY STAPLE'), false, 'case matters');
    assert.equal(passcodeMatches(''), false);
    assert.equal(passcodeMatches(undefined), false);
    assert.equal(passcodeMatches(null), false);
  });
});

test('a passcode of a different length is refused rather than throwing', async () => {
  // timingSafeEqual throws on a length mismatch; the guard around it is the
  // difference between "wrong passcode" and a 500 that tells you the length.
  await withPasscode('short', () => {
    assert.doesNotThrow(() => passcodeMatches('a much longer guess entirely'));
    assert.equal(passcodeMatches('a much longer guess entirely'), false);
  });
});

test('with no passcode set, nothing matches at all', async () => {
  await withPasscode(null, () => {
    const configured = authConfigured();
    // Locally there is a development fallback; deployed there is not. Either
    // way the empty string must never be the passcode.
    assert.equal(passcodeMatches(''), false);
    assert.equal(passcodeMatches(undefined), false);
    if (!configured) assert.equal(passcodeMatches('roam-dev'), false);
  });
});

test('exactly four kinds of path answer without a session', () => {
  const open = (method, path) => isPublicPath({ method, path });

  assert.equal(open('GET', '/health'), true);
  assert.equal(open('GET', '/robots.txt'), true);
  assert.equal(open('POST', '/api/session'), true);
  assert.equal(open('GET', '/api/join/abc123'), true);
  assert.equal(open('POST', '/api/join/abc123/items/xyz'), true);

  // Everything the household owns is behind the door.
  for (const path of [
    '/api/household', '/api/household/export', '/api/trips', '/api/atlas/places',
    '/api/visits', '/api/plan', '/api/sessions', '/api/photos/google', '/api/orders',
  ]) assert.equal(open('GET', path), false, `${path} must need a session`);
});

test('a path that merely starts with a public one is not public', () => {
  // The join test is a prefix match, so this is the shape that would let
  // `/api/joinery` or `/api/sessionsecret` through if it were written loosely.
  assert.equal(isPublicPath({ method: 'GET', path: '/api/joinery' }), false);
  assert.equal(isPublicPath({ method: 'GET', path: '/api/sessions' }), false);
  assert.equal(isPublicPath({ method: 'GET', path: '/health/secret' }), false);
});

test('the origin list, when the owner has set one', () => {
  const before = process.env.ROAM_WEB_ORIGIN;
  try {
    process.env.ROAM_WEB_ORIGIN = 'https://roam.example.com, https://roam-web.up.railway.app/';
    assert.equal(originAllowed('https://roam.example.com'), true);
    assert.equal(originAllowed('https://roam-web.up.railway.app'), true, 'a trailing slash is the same origin');
    assert.equal(originAllowed('https://roam.example.com.evil.test'), false);
    assert.equal(originAllowed('http://roam.example.com'), false, 'scheme is part of an origin');
    assert.equal(originAllowed(undefined), true, 'no Origin header at all: curl, a native app, same-origin');

    process.env.ROAM_WEB_ORIGIN = '';
    assert.equal(originAllowed('https://anything.test'), true, 'unset: the passcode is the guard');
  } finally {
    if (before === undefined) delete process.env.ROAM_WEB_ORIGIN; else process.env.ROAM_WEB_ORIGIN = before;
  }
});
