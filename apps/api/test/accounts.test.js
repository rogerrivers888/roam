/**
 * Accounts, at the level where getting it wrong is silent.
 *
 * The dangerous failure here is not a screen that looks wrong. It is one
 * household being served another household's data, which looks exactly like a
 * working app to everybody except the person whose home address it was. Two
 * things stand between Roam and that, and both are tested here:
 *
 *   * the async-local store (context.js) keeping two requests in flight apart;
 *   * `requireOwner` refusing a customer, and refusing them in a way that does
 *     not confirm the admin module exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { currentAccount, runAsAccount, runOutsideRequest } = await import('../src/context.js');

const withEnv = async (vars, fn) => {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};

// ---------------------------------------------------------------------------
// whose request is this
// ---------------------------------------------------------------------------

test('two requests in flight at once never see each other\'s account', async () => {
  // The whole reason `currentHousehold()` could be changed without touching its
  // 86 call sites. If this ever fails, those call sites are reading whichever
  // request happened to start last, and Roam is serving households to each
  // other.
  const seen = [];
  const request = (account, delay) => runAsAccount(account, async () => {
    await new Promise((r) => setTimeout(r, delay));
    // Read it back after an await, which is the only case that matters: before
    // the first await any implementation would look right.
    seen.push([account.email, currentAccount()?.email]);
    await new Promise((r) => setTimeout(r, delay));
    seen.push([account.email, currentAccount()?.email]);
  });

  await Promise.all([
    request({ email: 'roger@example.com', household_id: 'a' }, 20),
    request({ email: 'friend@example.com', household_id: 'b' }, 5),
    request({ email: 'other@example.com', household_id: 'c' }, 12),
  ]);

  assert.equal(seen.length, 6);
  for (const [expected, actual] of seen) assert.equal(actual, expected, `${expected} saw ${actual}`);
});

test('outside a request there is no account, and no leftover from the last one', async () => {
  await runAsAccount({ email: 'roger@example.com' }, async () => {
    assert.equal(currentAccount().email, 'roger@example.com');
    // Background work must not inherit whoever happened to trigger it.
    await runOutsideRequest(async () => {
      assert.equal(currentAccount(), null);
    });
    assert.equal(currentAccount().email, 'roger@example.com', 'the request is itself again afterwards');
  });
  assert.equal(currentAccount(), null);
});

test('the passcode carries no account, which is what makes it the founding household', async () => {
  await runAsAccount(null, async () => {
    assert.equal(currentAccount(), null);
  });
});

// ---------------------------------------------------------------------------
// the admin door
// ---------------------------------------------------------------------------

const { isPublicPath, requireOwner } = await import('../src/auth.js');

const call = (req) => {
  let passed = false;
  let refused = null;
  const res = {
    status(code) { refused = { code }; return this; },
    json(body) { if (refused) refused.body = body; return this; },
  };
  requireOwner(req, res, () => { passed = true; });
  return { passed, refused };
};

test('the owner gets in, on an account or on the passcode', () => {
  assert.equal(call({ session: { account_id: null }, account: null }).passed, true, 'shared passcode');
  assert.equal(call({ session: { account_id: 'x' }, account: { role: 'owner' } }).passed, true, 'owner account');
});

test('a customer is told the admin module does not exist, not that they may not have it', () => {
  const { passed, refused } = call({ session: { account_id: 'x' }, account: { role: 'customer' } });
  assert.equal(passed, false);
  assert.equal(refused.code, 404, '403 would confirm there is something there');
  assert.equal(refused.body.error, 'not_found');
  assert.match(JSON.stringify(refused.body), /Not found/);
  assert.doesNotMatch(JSON.stringify(refused.body), /owner|admin|account/i, 'the refusal says nothing about what was refused');
});

test('signing in by link answers without a session, and nothing else new does', () => {
  const p = (path) => isPublicPath({ path, method: 'POST' });
  assert.equal(p('/api/session/link'), true, 'redeeming a link is how a session is obtained');
  assert.equal(p('/api/session/request-link'), true, 'asking for a link cannot need one');
  assert.equal(p('/api/accounts'), false, 'the admin list is not public');
  assert.equal(p('/api/accounts/123/invite'), false, 'inviting is not public');
  assert.equal(p('/api/session/linkage'), false, 'the match is exact, not a prefix');
});

// ---------------------------------------------------------------------------
// the sender
// ---------------------------------------------------------------------------

const { invitationEmail, mailConfigured, mailStatus, sendMail, webUrl } = await import('../src/sources/mail.js');

test('with no key, sending says so rather than pretending', async () => {
  await withEnv({ RESEND_API_KEY: null, ROAM_MAIL_FROM: null }, async () => {
    assert.equal(mailConfigured(), false);
    assert.equal(mailStatus().reason, 'no_sender');
    const result = await sendMail({ to: 'friend@example.com', subject: 'x', text: 'y' });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'no_sender');
    // The owner has to be told what to do about it, on the screen that tried.
    assert.match(result.message, /Doppler/);
  });
});

test('a key with no from-address is not a working sender', async () => {
  await withEnv({ RESEND_API_KEY: 're_test', ROAM_MAIL_FROM: null }, () => {
    assert.equal(mailConfigured(), false);
    assert.equal(mailStatus().reason, 'no_from');
  });
});

test('the invitation says what the link is and what to do if it was not expected', () => {
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  const { subject, text, html } = invitationEmail({ name: 'Ella', url: 'https://roam.app/?signin=abc', from: 'Roger', expiresAt });
  assert.match(subject, /invitation/i);
  assert.match(text, /Hi Ella,/);
  assert.match(text, /https:\/\/roam\.app\/\?signin=abc/);
  assert.match(text, /works once, within 7 days/);
  assert.match(text, /If you were not expecting this/);
  assert.match(html, /https:\/\/roam\.app\/\?signin=abc/);
});

test('a link sent to somebody signing back in does not welcome them to Roam again', () => {
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const { subject, text } = invitationEmail({ url: 'https://roam.app/?signin=abc', expiresAt, returning: true });
  assert.match(subject, /back in/i);
  assert.match(text, /sign back in/i);
  assert.match(text, /within 1 day\b/, 'one day, not "1 days"');
});

test('links point at the app, not at the API', async () => {
  await withEnv({ ROAM_WEB_URL: 'https://roam.example.com/' }, () => {
    assert.equal(webUrl({ headers: { origin: 'https://api.example.com' } }), 'https://roam.example.com', 'the setting wins, and the trailing slash goes');
  });
  await withEnv({ ROAM_WEB_URL: null }, () => {
    assert.equal(webUrl({ headers: { origin: 'http://localhost:8081' } }), 'http://localhost:8081', 'a developer gets a link that works with nothing set');
  });
});
