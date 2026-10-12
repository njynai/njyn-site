import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeLayoutId, localParts, ruleMatches } from '../public/player/schedule.js';

const manifest = (schedule, timezone = 'UTC') => ({
  screen: { timezone },
  defaultLayoutId: 'def',
  layouts: { def: {}, lunch: {}, night: {} },
  schedule,
});

test('localParts honours the screen time zone', () => {
  const d = new Date('2026-10-12T23:30:00Z'); // Monday in UTC
  assert.deepEqual(localParts(d, 'UTC'), { day: 1, minutes: 23 * 60 + 30 });
  assert.deepEqual(localParts(d, 'Asia/Tokyo'), { day: 2, minutes: 8 * 60 + 30 }); // Tuesday 08:30
});

test('falls back to the default layout when no rule matches', () => {
  const m = manifest([{ days: [1], start: '12:00', end: '13:00', layoutId: 'lunch' }]);
  assert.equal(activeLayoutId(m, new Date('2026-10-12T11:59:00Z')), 'def');
  assert.equal(activeLayoutId(m, new Date('2026-10-12T12:00:00Z')), 'lunch');
  assert.equal(activeLayoutId(m, new Date('2026-10-12T13:00:00Z')), 'def'); // end is exclusive
});

test('overnight rules run past midnight into the next day', () => {
  const rule = { days: [5], start: '22:00', end: '02:00', layoutId: 'night' }; // Friday night
  assert.equal(ruleMatches(rule, { day: 5, minutes: 23 * 60 }), true);
  assert.equal(ruleMatches(rule, { day: 6, minutes: 60 }), true); // Saturday 01:00
  assert.equal(ruleMatches(rule, { day: 6, minutes: 23 * 60 }), false);
  assert.equal(ruleMatches(rule, { day: 5, minutes: 60 }), false); // Friday 01:00 belongs to Thursday
});

test('the first matching rule wins and missing layouts are skipped', () => {
  const m = manifest([
    { days: [1], start: '00:00', end: '23:59', layoutId: 'gone' },
    { days: [1], start: '00:00', end: '23:59', layoutId: 'lunch' },
    { days: [1], start: '00:00', end: '23:59', layoutId: 'night' },
  ]);
  assert.equal(activeLayoutId(m, new Date('2026-10-12T10:00:00Z')), 'lunch');
});

test('no default and no match means idle', () => {
  const m = { ...manifest([]), defaultLayoutId: null };
  assert.equal(activeLayoutId(m, new Date()), null);
});
