// The menu-failure classifier, against sentences the crawler really wrote.
//
// Every string below was taken from production on 5 Sep 2026, where a hundred
// and twenty-six failures carried sixty-three distinct sentences between them.
// The classifier is a piece of judgement about English, so it is the kind of
// thing that quietly stops working when somebody rewords a message in
// `menuLink.js`; these are here so that rewording fails loudly instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { causeOf, CAUSES, CAUSE_KEYS } from '../src/domain/menuCauses.js';

test('the sentences production actually wrote each land on one cause', () => {
  const cases = [
    // the site answered, and had no menu anchor on it
    ['Nothing on www.caldesi.com says menu — it may be a picture, or on their booking page.', 'no_menu_link'],
    ['Nothing linked on their site; /menus answers.', 'no_menu_link'],
    ['Their website is the menu.', 'no_menu_link'],

    // a link was found; whether the right one won is in its label
    ['Followed “Menu” on littlelahoreslough.com.', 'menu_empty'],
    ['Followed “Christmas Menu” on theswinleyascot.co.uk.', 'seasonal_anchor'],
    ['Followed “Festive Menu” on www.mcmullens.co.uk.', 'seasonal_anchor'],
    ['Followed “Sunday Menu” on thecoachmarlow.co.uk.', 'seasonal_anchor'],
    ['Followed “Breakfast Menu” on www.pinewoodhotel.co.uk.', 'seasonal_anchor'],
    ['Followed “Order Online” on www.khyber-shinwari.co.uk.', 'delivery_platform'],

    // the crawler's own codes, thrown from menuRead.js
    ['menu_had_no_items', 'menu_empty'],
    ['menu_unreadable', 'menu_unreadable'],
    ['menu_url_required', 'no_website'],

    // nothing to open, or nothing answering
    ['No website for this place, so there is nothing to read.', 'no_website'],
    ['Their site did not answer.', 'site_dead'],
    ['Their site did not answer (unreachable).', 'site_dead'],
    ['Their site did not answer (timed out).', 'site_dead'],

    // a website that is not a website
    ['Nothing on www.instagram.com says menu — it may be a picture, or on their booking page.', 'social_only'],

    // a group site pointing at the wrong town
    ['The only menu link on their site goes to another branch (/menus/oxford), not the one in Windsor.', 'wrong_branch'],
  ];

  for (const [why, expected] of cases) {
    assert.equal(causeOf({ why, state: 'none' }), expected, `"${why.slice(0, 48)}…"`);
  }
});

test('a failure of ours is never counted as a place we cannot read', () => {
  // The report is about their websites. Our own outage in the middle of it
  // would be read as thirty restaurants having gone dark.
  const ours = [
    'Could not resolve authentication method. Expected one of apiKey, authToken…',
    'rate_limit_error: quota exceeded',
    'Request failed with status 429',
    'Your credit balance is too low',
    'socket hang up',
    // The one this cause was worth adding for: a parameter added to two call
    // sites and never to the function holding them failed a hundred and one
    // reads, and every one of them sat in the backlog looking like a restaurant
    // with a broken website.
    'searchTheWeb is not defined',
    'Cannot read properties of undefined (reading \'url\')',
    'menuFor is not a function',
  ];
  for (const why of ours) assert.equal(causeOf({ why, state: 'none' }), 'ours', why.slice(0, 40));
});

test('a menu whose address is known but unread is work, not a failure', () => {
  // `found` means the finder did its job and the reader has not run. Counting
  // it would inflate every number on the report.
  assert.equal(causeOf({ why: null, state: 'found' }), null);
});

test('a social profile is read as one even when the sentence blames the anchor', () => {
  // "Nothing on … says menu" is true of an Instagram page too, and only one of
  // those two readings has a fix behind it.
  assert.equal(
    causeOf({ why: 'Nothing on their site says menu.', website: 'https://www.instagram.com/thedukebox', state: 'none' }),
    'social_only',
  );
});

test('every cause carries a label and a fix, and nothing outside the set is returned', () => {
  for (const c of CAUSES) {
    assert.ok(c.label && c.detail && c.fix, `${c.key} is missing its words`);
  }
  // A cause with no distinct fix has no business being its own row.
  assert.equal(new Set(CAUSES.map((c) => c.fix)).size, CAUSES.length);
  const sample = ['', 'something nobody has seen', 'Followed “Menu” on x.co.uk.', 'menu_had_no_items'];
  for (const why of sample) {
    const got = causeOf({ why, state: 'none' });
    assert.ok(CAUSE_KEYS.includes(got), `${got} is not one of the closed set`);
  }
});
