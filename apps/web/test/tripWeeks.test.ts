import test from 'node:test';
import assert from 'node:assert/strict';
import { weeksOf } from '../src/screens/tripWeeks';

const days = (n: number, from = '2026-08-09') =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T12:00:00`);
    d.setDate(d.getDate() + i);
    return { date: d.toISOString().slice(0, 10) };
  });

test('a week or less is one strip and no tabs', () => {
  const w = weeksOf(days(8));
  assert.equal(w.length, 1);
  assert.equal(w[0].days.length, 8);
});

test('a fortnight and a day is two weeks and the last day, named for what it is', () => {
  const w = weeksOf(days(17));
  assert.deepEqual(w.map((x) => x.label), ['Week 1', 'Week 2', 'Last day']);
  assert.deepEqual(w.map((x) => x.days.length), [8, 8, 1]);
  assert.equal(w[2].when, '25');
});

test('a week that crosses a month says both months', () => {
  const w = weeksOf(days(10, '2026-08-28'));
  assert.equal(w[0].when, '28 Aug – 4 Sep');
});

test('a tail long enough to be a week is called one', () => {
  const w = weeksOf(days(21));
  assert.deepEqual(w.map((x) => x.label), ['Week 1', 'Week 2', 'Week 3']);
});

test('every day lands in exactly one week', () => {
  for (const n of [9, 16, 17, 24, 30]) {
    const w = weeksOf(days(n));
    assert.equal(w.reduce((a, x) => a + x.days.length, 0), n);
  }
});
