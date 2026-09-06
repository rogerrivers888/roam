/**
 * Which branch's menu, when a group has several.
 *
 * A menu for the wrong town is worse than no menu: it puts the wrong prices and
 * the wrong dishes on a place the family is standing outside. Sebastian's has a
 * restaurant in Windsor and one in Richmond on two separate sites, and Roam
 * stored Richmond's menu on the Windsor one (found 6 Sep 2026) because nothing
 * downstream of the researcher knew which town it was looking for.
 *
 * Two halves of the same decision are pinned here: choosing a branch off a
 * group's front page, and refusing one that is plainly somebody else's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { branchLink, branchLooksWrong } from '../src/sources/menuLink.js';

// What the researcher knows about the Windsor restaurant.
const WORDS = ['sebastian', 'windsor', 'peascod'];
const WINDSOR = 'Windsor and Maidenhead';

test('a branch on another town’s domain is not this restaurant', () => {
  assert.equal(branchLooksWrong('https://www.sebastiansrichmond.co.uk/menu.html', WORDS, WINDSOR), true);
  assert.equal(branchLooksWrong('https://www.sebastianswindsor.co.uk/menu.html', WORDS, WINDSOR), false);
});

test('a branch in another town’s folder is not this restaurant either', () => {
  assert.equal(branchLooksWrong('https://intoku.co.uk/intoku-reading/menu', ['intoku', 'windsor'], WINDSOR), true);
  assert.equal(branchLooksWrong('https://intoku.co.uk/intoku-windsor/menu', ['intoku', 'windsor'], WINDSOR), false);
});

test('a street with a town’s name in it is still a street', () => {
  // 88 Maidenhead Road is in Windsor (found 5 Sep 2026).
  assert.equal(branchLooksWrong('https://order.example.com/boleros-pizzeria-cafe-88-maidenhead-road', ['boleros', 'windsor'], WINDSOR), false);
});

test('with no town to go on, nothing is contradicted', () => {
  assert.equal(branchLooksWrong('https://www.sebastiansrichmond.co.uk/menu.html', WORDS, null), false);
});

test('the branch that names our town wins, not the one that shares the brand', () => {
  const html = `
    <a href="https://www.sebastiansrichmond.co.uk">Richmond TW9 1ND</a>
    <a href="https://www.sebastianswindsor.co.uk">Windsor SL4 1RH</a>`;
  const picked = branchLink(html, 'https://www.sebastiansitalian.co.uk/', WORDS, WINDSOR);
  assert.equal(picked.url, 'https://www.sebastianswindsor.co.uk/');
  // Without the town, the brand matches both and the first one takes it — which
  // is exactly the bug.
  const blind = branchLink(html, 'https://www.sebastiansitalian.co.uk/', ['sebastian'], null);
  assert.equal(blind.url, 'https://www.sebastiansrichmond.co.uk/');
});
