import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../src/validate.js';

test('playlist items are cleaned and defaulted', () => {
  const items = v.playlistItems([
    { type: 'media', mediaId: 'abc' },
    { type: 'web', url: 'https://example.com/x' },
    { type: 'widget', widget: 'weather', options: { city: ' Paris ' } },
    { type: 'widget', widget: 'text', options: { text: 'Hi', color: 'red' } },
  ]);
  assert.equal(items[0].duration, null); // video plays to the end
  assert.equal(items[1].duration, 30);
  assert.deepEqual(items[2].options, { city: 'Paris', units: 'celsius' });
  assert.equal(items[3].options.color, '#ffffff'); // invalid colour replaced
});

test('playlist items reject bad input', () => {
  assert.throws(() => v.playlistItems([{ type: 'web', url: 'javascript:alert(1)' }]), v.ValidationError);
  assert.throws(() => v.playlistItems([{ type: 'widget', widget: 'nope' }]), v.ValidationError);
  assert.throws(() => v.playlistItems([{ type: 'media', mediaId: 'a', duration: 0 }]), v.ValidationError);
  assert.throws(() => v.playlistItems({}), v.ValidationError);
});

test('zones must stay on screen and have unique ids', () => {
  assert.equal(v.layoutZones([{ id: 'a', x: 0, y: 0, w: 75, h: 100 }, { id: 'b', x: 75, y: 0, w: 25, h: 100 }]).length, 2);
  assert.throws(() => v.layoutZones([{ id: 'a', x: 50, y: 0, w: 60, h: 100 }]), /runs off the screen/);
  assert.throws(() => v.layoutZones([{ id: 'a', x: 0, y: 0, w: 1, h: 1 }, { id: 'a', x: 0, y: 0, w: 1, h: 1 }]), /repeats id/);
  assert.throws(() => v.layoutZones([]), v.ValidationError);
});

test('schedule rules need days and valid times', () => {
  assert.deepEqual(v.schedule([{ days: [3, 1, 1], start: '09:00', end: '17:00', layoutId: 'x' }])[0].days, [1, 3]);
  assert.throws(() => v.schedule([{ days: [], start: '09:00', end: '17:00', layoutId: 'x' }]), /at least one day/);
  assert.throws(() => v.schedule([{ days: [1], start: '9:00', end: '17:00', layoutId: 'x' }]), /09:00/);
  assert.throws(() => v.schedule([{ days: [1], start: '09:00', end: '09:00', layoutId: 'x' }]), /same time/);
});

test('time zones are checked', () => {
  assert.equal(v.timezone('Europe/London'), 'Europe/London');
  assert.throws(() => v.timezone('Mars/Olympus'), /Unknown time zone/);
});
