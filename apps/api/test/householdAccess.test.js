/**
 * Inviting the people you live with (migration 056).
 *
 * The failures worth catching here are the quiet ones. An invitation that does
 * not arrive is loud — somebody says so. These are not:
 *
 *   * a second account on a household changing which monthly ceiling is in
 *     force, because `callBoundFor` used an unordered `limit 1`;
 *   * a deleted profile leaving a live way in to the household behind it;
 *   * a mobile number normalised into the wrong country and a link texted to
 *     a stranger;
 *   * one family's provider spending counted once per person in it.
 *
 * Every one of those looks like a working app from the outside.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { aHousehold, testDatabase } from './helpers/db.js';

const { query } = await testDatabase();
const {
  accountByMember, accountByMobile, accountsForHousehold, callBoundFor,
  createAccount, createAccountOnHousehold, listAccounts, normaliseEmail,
} = await import('../src/repositories/accounts.js');
const { explain, normaliseMobile, invitationText, smsStatus } = await import('../src/sources/sms.js');

// ---------------------------------------------------------------------------
// a number is a credential, so it has to be exactly one number
// ---------------------------------------------------------------------------

test('the ways a British family types its own mobile number all mean one number', () => {
  const expected = '+447700900123';
  for (const typed of ['07700 900123', '07700900123', '+44 7700 900123', '+447700900123', '(07700) 900-123', '00447700900123']) {
    assert.equal(normaliseMobile(typed), expected, `${typed} should normalise to ${expected}`);
  }
});

test('anything that is not recognisably a number is refused rather than guessed at', () => {
  // The failure this prevents: half-converting something and texting a link
  // that signs somebody in to this household to whoever owns that number.
  for (const nonsense of ['', '   ', 'ask Gina', '123', '07700', 'gina@example.com', '+0 123']) {
    assert.equal(normaliseMobile(nonsense), null, `${JSON.stringify(nonsense)} should be refused`);
  }
});

test('a number already in international form is never re-dialled through the household country', () => {
  assert.equal(normaliseMobile('+1 415 555 0123', { countryCode: 'GB' }), '+14155550123');
});

test('an empty address is null and not the empty string', () => {
  // '' in a unique column would mean only one account in the estate could be
  // invited by text alone.
  assert.equal(normaliseEmail(''), null);
  assert.equal(normaliseEmail(null), null);
  assert.equal(normaliseEmail('  Gina@Example.COM '), 'gina@example.com');
});

// ---------------------------------------------------------------------------
// two people, one household
// ---------------------------------------------------------------------------

test('a household member signs in to the household they already live in, not a new one', async () => {
  const { household, member } = await aHousehold(query, 'the Rivers household');
  const account = await createAccountOnHousehold(household.id, {
    memberId: member.id, mobile: '07700 900123', name: 'Gina', role: 'customer', plan: 'household',
  });

  assert.equal(account.household_id, household.id, 'the invitation must not create a household of its own');
  assert.equal(account.member_id, member.id);
  assert.equal(account.mobile, '+447700900123', 'the number is stored as a sender will accept it');
  assert.equal(account.email, null, 'somebody invited by text has no address, and that is allowed');

  assert.equal((await accountByMember(member.id))?.id, account.id);
  assert.equal((await accountByMobile('07700 900123'))?.id, account.id, 'found however it is typed back in');
});

test('the household ceiling is the lead\'s, whoever else is signed in', async () => {
  // Before migration 056 this was `select monthly_call_bound ... limit 1` with
  // no order, so with two accounts on one household the ceiling in force
  // changed from request to request depending on which row came back.
  const { household, member } = await aHousehold(query, 'ceiling household');
  const { rows: [lead] } = await query(
    `insert into accounts (household_id, email, name, role, plan, monthly_call_bound)
     values ($1, 'lead@example.com', 'Lead', 'customer', 'trial', 400) returning id`,
    [household.id],
  );
  assert.equal(await callBoundFor(household.id), 400);

  // Somebody invited into the household carries no ceiling of their own, so
  // they cannot raise or lower the family's.
  await createAccountOnHousehold(household.id, {
    memberId: member.id, email: 'gina@example.com', name: 'Gina', role: 'customer', plan: 'household', monthlyCallBound: null,
  });
  for (let i = 0; i < 5; i += 1) assert.equal(await callBoundFor(household.id), 400, 'the ceiling must not move');

  const people = await accountsForHousehold(household.id);
  assert.equal(people.length, 2);
  assert.equal(people[0].id, lead.id, 'the lead is first — the account that made the household');
});

test('deleting a person takes their way in with them', async () => {
  // The worst quiet failure available here: a profile that is gone, and a live
  // sign-in to the household still behind it.
  const { household, member } = await aHousehold(query, 'cascade household');
  const account = await createAccountOnHousehold(household.id, {
    memberId: member.id, mobile: '07700 900999', name: 'Gone', role: 'customer', plan: 'household',
  });
  await query(
    `insert into api_sessions (token_hash, account_id, expires_at) values ($1, $2, now() + interval '90 days')`,
    [`hash-${account.id}`, account.id],
  );

  await query('delete from members where id = $1', [member.id]);

  assert.equal(await accountByMember(member.id), null);
  const { rows: gone } = await query('select id from accounts where id = $1', [account.id]);
  assert.equal(gone.length, 0, 'the account goes with the profile');
  const { rows: sessions } = await query('select id from api_sessions where account_id = $1', [account.id]);
  assert.equal(sessions.length, 0, 'and so do the devices it was signed in on');
});

test('taking the sign-in away leaves the person, their tastes and their ratings', async () => {
  const { household, member } = await aHousehold(query, 'keep the person');
  await query(`insert into member_constraints (member_id, kind, value) values ($1, 'allergen', 'peanuts')`, [member.id]);
  const account = await createAccountOnHousehold(household.id, {
    memberId: member.id, email: 'stay@example.com', name: 'Stays', role: 'customer', plan: 'household',
  });

  // What `DELETE /members/:id/invite` does: the account, and only the account.
  await query('delete from accounts where id = $1', [account.id]);

  const { rows: [still] } = await query('select id, name from members where id = $1', [member.id]);
  assert.ok(still, 'the person is still in the household');
  const { rows: allergens } = await query('select value from member_constraints where member_id = $1', [member.id]);
  assert.deepEqual(allergens.map((a) => a.value), ['peanuts'], 'and so is everything they cannot eat');
});

test('one contact signs one person in, so a number cannot be lent to a second account', async () => {
  const { household, member } = await aHousehold(query, 'unique contacts');
  await createAccountOnHousehold(household.id, { memberId: member.id, mobile: '07700 900555', name: 'First', role: 'customer', plan: 'household' });
  const { rows: [other] } = await query('insert into members (household_id, name) values ($1, $2) returning *', [household.id, 'Second']);
  await assert.rejects(
    () => createAccountOnHousehold(household.id, { memberId: other.id, mobile: '+44 7700 900555', name: 'Second', role: 'customer', plan: 'household' }),
    /duplicate key|unique/i,
    'the same number in two dialects is still the same number',
  );
});

test('an account with neither an address nor a number cannot exist', async () => {
  const { household } = await aHousehold(query, 'unreachable');
  await assert.rejects(
    () => query(`insert into accounts (household_id, name, role) values ($1, 'Nobody', 'customer')`, [household.id]),
    /accounts_reachable/,
    'an account nobody can send a link to is an account nobody can ever use',
  );
});

// ---------------------------------------------------------------------------
// what the back office is told
// ---------------------------------------------------------------------------

test('a family with two people signed in is one household, counted once', async () => {
  const account = await createAccount({ email: 'family@example.com', name: 'Family', plan: 'trial', monthlyCallBound: 200 });
  const { rows: [member] } = await query('insert into members (household_id, name) values ($1, $2) returning *', [account.household_id, 'Partner']);
  await createAccountOnHousehold(account.household_id, {
    memberId: member.id, email: 'partner@example.com', name: 'Partner', role: 'customer', plan: 'household',
  });
  await query(
    `insert into provider_calls (household_id, provider, purpose, estimated_cost_usd) values ($1, 'google', 'discover.search', 0.03)`,
    [account.household_id],
  );

  const rows = (await listAccounts()).filter((r) => r.household_id === account.household_id);
  assert.equal(rows.length, 2, 'both people appear — the owner asked to see who is in');
  assert.equal(rows.filter((r) => r.is_lead).length, 1, 'exactly one of them is the household');
  assert.equal(rows[0].email, 'family@example.com', 'and it is the one that made it');
  // Both rows carry the household's spending, because that is the true answer
  // to "what is this costing"; the totals on the screen add up the leads only.
  assert.equal(Number(rows[0].cost_ever).toFixed(2), '0.03');
  assert.equal(Number(rows[1].cost_ever).toFixed(2), '0.03');
  const leadTotal = rows.filter((r) => r.is_lead).reduce((n, r) => n + Number(r.cost_ever), 0);
  assert.equal(leadTotal.toFixed(2), '0.03', 'counting every row would report twice what was spent');
});

// ---------------------------------------------------------------------------
// what is said when nothing can be sent
// ---------------------------------------------------------------------------

test('with no Twilio key configured the invitation says so rather than pretending', () => {
  const status = smsStatus();
  assert.equal(status.configured, false);
  assert.match(status.message, /Doppler/, 'the owner is told where the key goes');
  assert.match(status.message, /copy the link/, 'and what to do until it is there');
});

test('the text says who it is from before it says anything else', () => {
  // A link that arrives with no name on it looks exactly like the thing people
  // are told never to tap.
  const body = invitationText({ name: 'Gina', url: 'https://roam.example/?signin=abc', from: 'Roger' });
  assert.match(body, /^Hi Gina\. Roger has/);
  assert.ok(body.includes('https://roam.example/?signin=abc'));
  assert.ok(body.length < 320, `a text is short; this one was ${body.length} characters`);
});

// ---------------------------------------------------------------------------
// the two strings on the Twilio dashboard, and which box each goes in
// ---------------------------------------------------------------------------

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

test('an API key in the Account SID box is caught here rather than as a 404 from Twilio', async () => {
  // The whole reason this check exists: an SK… signs a request but does not
  // address one, so Twilio would answer 404 from a URL built around an account
  // that does not exist — which reads as "the feature is broken" rather than
  // "that is the wrong one of the two strings on the page".
  await withEnv({ TWILIO_ACCOUNT_SID: 'SK' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'secret', TWILIO_FROM: '+441234567890' }, () => {
    const status = smsStatus();
    assert.equal(status.configured, false);
    assert.equal(status.reason, 'wrong_sid');
    assert.match(status.setup, /TWILIO_API_KEY_SID/, 'it says which box the SK… belongs in');
    assert.match(status.setup, /AC/, 'and what belongs in the one it was pasted into');
  });
});

test('anything that is not an Account SID is refused, not only an API key', async () => {
  await withEnv({ TWILIO_ACCOUNT_SID: 'my-twilio-account', TWILIO_AUTH_TOKEN: 'secret', TWILIO_FROM: '+441234567890' }, () => {
    const status = smsStatus();
    assert.equal(status.configured, false);
    assert.equal(status.reason, 'wrong_sid');
    assert.doesNotMatch(status.setup, /API key/, 'and is not told it pasted an API key when it did not');
  });
});

test('an account SID with an API key beside it is a configured sender', async () => {
  await withEnv({
    TWILIO_ACCOUNT_SID: 'AC' + 'b'.repeat(32), TWILIO_API_KEY_SID: 'SK' + 'c'.repeat(32),
    TWILIO_AUTH_TOKEN: 'secret', TWILIO_FROM: '+441234567890',
  }, () => {
    const status = smsStatus();
    assert.equal(status.configured, true);
    assert.equal(status.signingWith, 'api_key', 'the key signs; the account is still the address');
  });
});

test('the account token on its own is still a configured sender', async () => {
  await withEnv({
    TWILIO_ACCOUNT_SID: 'AC' + 'd'.repeat(32), TWILIO_API_KEY_SID: null,
    TWILIO_AUTH_TOKEN: 'secret', TWILIO_FROM: 'MG' + 'e'.repeat(32),
  }, () => {
    const status = smsStatus();
    assert.equal(status.configured, true);
    assert.equal(status.signingWith, 'auth_token');
  });
});

test("a trial's unverified-number refusal says what to do about it, not just what happened", () => {
  // 21608 is the first thing a trial account hits, and Twilio's own wording
  // does not mention Verified Caller IDs or the five-recipient allowance.
  const msg = explain(21608, 'The number +447700900123 is unverified.', 400);
  assert.match(msg, /Verified Caller IDs/);
  assert.match(msg, /five|upgrade/);
});

test('a refusal we have no better words for keeps Twilio\'s own', () => {
  const msg = explain(30007, 'Message filtered by carrier.', 400);
  assert.match(msg, /Message filtered by carrier\./, "we do not swallow what we cannot improve on");
});

test('half a Twilio configuration says which half, and that the rest arrived', async () => {
  // The owner added two of the three and saw the same "add all three" sentence
  // as somebody who had added none, which cannot distinguish "one still to go"
  // from "none of them reached the process" — and the second is the likelier
  // fault, because it means the sync is wrong rather than the setup unfinished.
  await withEnv({ TWILIO_ACCOUNT_SID: 'AC' + 'f'.repeat(32), TWILIO_AUTH_TOKEN: 'secret', TWILIO_FROM: null }, () => {
    const status = smsStatus();
    assert.equal(status.reason, 'incomplete');
    assert.deepEqual(status.missing, ['TWILIO_FROM']);
    assert.equal(status.setup, 'To send by text, add TWILIO_FROM in Doppler.');
    assert.match(status.message, /the Doppler sync is working/);
  });
});

test('nothing set at all is a different fact from something set', async () => {
  await withEnv({ TWILIO_ACCOUNT_SID: null, TWILIO_AUTH_TOKEN: null, TWILIO_FROM: null }, () => {
    const status = smsStatus();
    assert.equal(status.reason, 'no_sender');
    assert.equal(status.missing.length, 3);
    assert.doesNotMatch(status.message, /sync is working/, 'because nothing has arrived to prove it');
  });
});

test('an alphanumeric sender is a sender, not a number to be normalised', async () => {
  // The way round the UK long-code bundle: "Roam" as the sender name, which
  // needs no number bought and cannot receive a reply — which an invitation
  // does not need. It must reach Twilio as typed.
  await withEnv({ TWILIO_ACCOUNT_SID: 'AC' + '9'.repeat(32), TWILIO_AUTH_TOKEN: 'secret', TWILIO_FROM: 'Roam' }, () => {
    const status = smsStatus();
    assert.equal(status.configured, true);
    assert.equal(status.from, 'Roam');
  });
});

test('an API key with no account behind it is named as that, not as a missing variable', async () => {
  // How the owner actually got here (6 Sep 2026): Twilio's API key page hands
  // you an SK… and a secret and labels them "SID" and "Secret", so it reads as
  // the whole set. Telling him "TWILIO_ACCOUNT_SID is not set" invites the
  // honest reply "yes it is — it is the SID I was given".
  await withEnv({
    TWILIO_ACCOUNT_SID: null, TWILIO_API_KEY_SID: 'SK' + '1'.repeat(32),
    TWILIO_AUTH_TOKEN: 'secret', TWILIO_FROM: null,
  }, () => {
    const status = smsStatus();
    assert.equal(status.reason, 'key_without_account');
    assert.match(status.setup, /the key signs the request, the account is its address/);
    assert.deepEqual(status.missing, ['TWILIO_ACCOUNT_SID', 'TWILIO_FROM']);
  });
});

test('a refused credential blames the half that is actually likely to be wrong', async () => {
  // With an API key configured, "check your account SID" is the wrong advice —
  // it sent the owner looking at a value that was already correct. An API key's
  // secret and the account's Auth Token are different strings, and Twilio's
  // console invites you to type either into something called AUTH_TOKEN.
  await withEnv({ TWILIO_API_KEY_SID: 'SK' + '2'.repeat(32) }, () => {
    const msg = explain(20003, null, 401);
    assert.match(msg, /API key.{0,20}secret/s);
    assert.match(msg, /delete TWILIO_API_KEY_SID/, 'and names the one-step way out');
  });
  await withEnv({ TWILIO_API_KEY_SID: null }, () => {
    assert.match(explain(20003, null, 401), /TWILIO_ACCOUNT_SID is the AC/);
  });
});

test('an API key secret sitting in the Auth Token box is noticed, but not enforced', async () => {
  // What actually happened, 6 Sep 2026. The two secrets are the same length
  // and go in the same box; only the alphabet distinguishes them, and Twilio's
  // 20003 names neither. It cost four redeploys to find.
  await withEnv({
    TWILIO_ACCOUNT_SID: 'AC' + '3'.repeat(32), TWILIO_API_KEY_SID: null,
    TWILIO_AUTH_TOKEN: 'rLNmQx7ZbK2wY9tD4fH8jS6vC1nP0aGe', TWILIO_FROM: '+447723371807',
  }, () => {
    const status = smsStatus();
    // Still configured: the guess must never stop a working sender sending.
    assert.equal(status.configured, true, 'a guess about a format must not refuse a send');
    assert.match(status.caution, /32 lowercase hexadecimal/);
    assert.match(status.caution, /TWILIO_API_KEY_SID/);
  });
});

test('a real Auth Token draws no caution', async () => {
  await withEnv({
    TWILIO_ACCOUNT_SID: 'AC' + '4'.repeat(32), TWILIO_API_KEY_SID: null,
    TWILIO_AUTH_TOKEN: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', TWILIO_FROM: '+447723371807',
  }, () => {
    assert.equal(smsStatus().caution, null);
  });
});

test('an API key secret is unremarkable when its key is configured beside it', async () => {
  await withEnv({
    TWILIO_ACCOUNT_SID: 'AC' + '5'.repeat(32), TWILIO_API_KEY_SID: 'SK' + '6'.repeat(32),
    TWILIO_AUTH_TOKEN: 'rLNmQx7ZbK2wY9tD4fH8jS6vC1nP0aGe', TWILIO_FROM: '+447723371807',
  }, () => {
    assert.equal(smsStatus().caution, null, 'that is exactly the right pairing');
  });
});
