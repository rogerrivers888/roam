/**
 * Doors and capabilities, tested where getting them wrong is silent.
 *
 * A guard that lets the wrong person through does not break a screen. It shows
 * them somebody else's estate, and looks like a working back office while it
 * does it. Three things are checked here, and each is a decision rather than an
 * implementation detail:
 *
 *   * a door refuses with 404, so nobody learns the back office exists;
 *   * a capability refuses with 403 *and names itself*, because the caller is a
 *     colleague who can go and ask for it;
 *   * the owner holds everything, including capabilities added after his role
 *     was created — which is why the owner role carries a flag rather than a
 *     list of ticks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { CAPABILITIES, CAPABILITY_KEYS, DOORS, accessPayload, can, hasDoor, requireDoor, requires } =
  await import('../src/access.js');

const run = (middleware, req) => {
  let passed = false;
  let refused = null;
  const res = {
    status(code) { refused = { code }; return this; },
    json(body) { if (refused) refused.body = body; return this; },
  };
  middleware(req, res, () => { passed = true; });
  return { passed, refused };
};

const asRole = (capabilities, doors = ['client', 'admin']) => ({
  access: { doors, capabilities: new Set(capabilities), isOwner: false, role: { key: 'support', label: 'Support' } },
});

test('the vocabulary is unique, and every capability says what it is for', () => {
  assert.equal(new Set(CAPABILITIES.map((c) => c.key)).size, CAPABILITIES.length, 'two capabilities with one key');
  for (const c of CAPABILITIES) {
    assert.ok(c.label && c.note && c.area, `${c.key} is missing its words`);
    assert.ok(CAPABILITY_KEYS.has(c.key));
  }
  // Reading and changing are a pair wherever both exist: the split is the
  // point, and a `manage_` with no matching read is a capability that cannot be
  // granted usefully.
  for (const c of CAPABILITIES.filter((x) => x.key.startsWith('manage_'))) {
    if (c.key === 'manage_roles' || c.key === 'manage_settings' || c.key === 'manage_plans') continue;
    assert.ok(CAPABILITY_KEYS.has(c.key.replace('manage_', 'view_')), `${c.key} has no read half`);
  }
});

test('without the door, there is nothing to find', () => {
  const { passed, refused } = run(requireDoor('admin'), { access: { doors: ['client'], capabilities: new Set() } });
  assert.equal(passed, false);
  assert.equal(refused.code, 404, '403 would confirm the back office exists');
  assert.doesNotMatch(JSON.stringify(refused.body), /admin|capabilit|permission/i);
});

test('with the door, the door lets you through', () => {
  assert.equal(run(requireDoor('admin'), asRole([])).passed, true);
});

test('a missing capability is a 403 that names itself', () => {
  const { passed, refused } = run(requires('view_financials'), asRole(['view_accounts']));
  assert.equal(passed, false);
  assert.equal(refused.code, 403);
  assert.equal(refused.body.capability, 'view_financials');
  // Something the reader can act on: which tick to ask for.
  assert.match(refused.body.message, /See financials/);
});

test('a held capability passes', () => {
  assert.equal(run(requires('view_accounts'), asRole(['view_accounts'])).passed, true);
});

test('a request with no access at all holds nothing', () => {
  // The default matters: a route reached without the door middleware having run
  // must not fall open.
  assert.equal(can({}, 'view_accounts'), false);
  assert.equal(hasDoor({}, 'admin'), false);
  assert.deepEqual(accessPayload({}).capabilities, []);
});

test('what the app is told is the same as what the API will enforce', () => {
  const payload = accessPayload(asRole(['view_accounts', 'view_activity']));
  assert.deepEqual(payload.capabilities.sort(), ['view_accounts', 'view_activity']);
  assert.deepEqual(payload.doors, DOORS);
  assert.equal(payload.role.label, 'Support');
  assert.equal(payload.isOwner, false);
});

test('the owner holds every capability there is, including ones added later', async () => {
  const { accessFor } = await import('../src/access.js');
  // No account is the shared passcode, which is the owner (auth.js).
  const passcode = await accessFor({ account: null });
  assert.equal(passcode.isOwner, true);
  for (const c of CAPABILITIES) assert.ok(passcode.capabilities.has(c.key), `owner is missing ${c.key}`);
  assert.deepEqual(passcode.doors, DOORS);
});

test('an account with no role gets the household app and nothing else', async () => {
  const { accessFor } = await import('../src/access.js');
  const access = await accessFor({ account: { id: 'a', role_id: null, role: 'customer' } });
  assert.deepEqual(access.doors, ['client']);
  assert.equal(access.capabilities.size, 0);
  assert.equal(access.isOwner, false);
});
