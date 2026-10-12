// Shape checks for everything the dashboard can save. Each function returns a
// cleaned copy or throws a ValidationError whose message is shown to the user.

export class ValidationError extends Error {}

const fail = (msg) => { throw new ValidationError(msg); };

export const WIDGETS = ['clock', 'weather', 'ticker', 'text'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_ITEMS = 200;
const MAX_ZONES = 8;

function str(v, field, max = 200) {
  if (typeof v !== 'string') fail(`${field} must be text`);
  const s = v.trim();
  if (s.length > max) fail(`${field} is longer than ${max} characters`);
  return s;
}

function num(v, field, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${field} must be between ${min} and ${max}`);
  return n;
}

export function name(v, field = 'Name') {
  const s = str(v ?? '', field, 120);
  if (!s) fail(`${field} is required`);
  return s;
}

function httpUrl(v, field) {
  const s = str(v, field, 2000);
  let u;
  try { u = new URL(s); } catch { fail(`${field} must be a full URL starting with https://`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(`${field} must start with https://`);
  return u.toString();
}

function widgetOptions(widget, o = {}) {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) fail('Widget options must be an object');
  switch (widget) {
    case 'clock':
      return { hour24: !!o.hour24, showDate: o.showDate !== false };
    case 'weather':
      return {
        city: name(o.city, 'Weather city'),
        units: o.units === 'fahrenheit' ? 'fahrenheit' : 'celsius',
      };
    case 'ticker':
      return {
        text: name(o.text, 'Ticker text').slice(0, 1000),
        speed: o.speed == null ? 80 : num(o.speed, 'Ticker speed', 10, 500),
      };
    case 'text':
      return {
        text: str(o.text ?? '', 'Text', 2000),
        color: /^#[0-9a-f]{6}$/i.test(o.color ?? '') ? o.color : '#ffffff',
        background: /^#[0-9a-f]{6}$/i.test(o.background ?? '') ? o.background : '#000000',
        size: o.size == null ? 12 : num(o.size, 'Text size', 1, 60), // % of zone height
      };
  }
}

// items: [{ type: 'media', mediaId, duration? } | { type: 'web', url, duration }
//         | { type: 'widget', widget, options, duration }]
// duration is seconds. For a video, a missing duration means "play to the end".
export function playlistItems(items) {
  if (!Array.isArray(items)) fail('Items must be a list');
  if (items.length > MAX_ITEMS) fail(`A playlist can hold at most ${MAX_ITEMS} items`);
  return items.map((it, i) => {
    const at = `Item ${i + 1}`;
    if (typeof it !== 'object' || it === null) fail(`${at} is not valid`);
    const duration = it.duration == null || it.duration === ''
      ? null : num(it.duration, `${at} duration`, 1, 86400);
    switch (it.type) {
      case 'media':
        return { type: 'media', mediaId: str(it.mediaId, `${at} media`, 64), duration };
      case 'web':
        return { type: 'web', url: httpUrl(it.url, `${at} URL`), duration: duration ?? 30 };
      case 'widget':
        if (!WIDGETS.includes(it.widget)) fail(`${at} has an unknown widget`);
        return { type: 'widget', widget: it.widget, options: widgetOptions(it.widget, it.options), duration: duration ?? 30 };
      default:
        fail(`${at} has an unknown type`);
    }
  });
}

// zones: [{ id, name, x, y, w, h, playlistId }], geometry in percent of the screen.
export function layoutZones(zones) {
  if (!Array.isArray(zones) || zones.length === 0) fail('A layout needs at least one zone');
  if (zones.length > MAX_ZONES) fail(`A layout can have at most ${MAX_ZONES} zones`);
  const ids = new Set();
  return zones.map((z, i) => {
    const at = `Zone ${i + 1}`;
    if (typeof z !== 'object' || z === null) fail(`${at} is not valid`);
    const id = str(z.id ?? `z${i + 1}`, `${at} id`, 32) || `z${i + 1}`;
    if (ids.has(id)) fail(`${at} repeats id ${id}`);
    ids.add(id);
    const x = num(z.x, `${at} left`, 0, 100), y = num(z.y, `${at} top`, 0, 100);
    const w = num(z.w, `${at} width`, 1, 100), h = num(z.h, `${at} height`, 1, 100);
    if (x + w > 100.01 || y + h > 100.01) fail(`${at} runs off the screen`);
    return {
      id, x, y, w, h,
      name: str(z.name ?? '', `${at} name`, 60) || `Zone ${i + 1}`,
      playlistId: z.playlistId ? str(z.playlistId, `${at} playlist`, 64) : null,
    };
  });
}

// schedule: [{ days: [0..6] (0 = Sunday), start: 'HH:MM', end: 'HH:MM', layoutId }]
// end before start wraps past midnight. The first matching rule wins.
export function schedule(rules) {
  if (!Array.isArray(rules)) fail('Schedule must be a list');
  if (rules.length > 50) fail('A schedule can have at most 50 rules');
  return rules.map((r, i) => {
    const at = `Schedule rule ${i + 1}`;
    if (typeof r !== 'object' || r === null) fail(`${at} is not valid`);
    if (!Array.isArray(r.days) || r.days.length === 0) fail(`${at} needs at least one day`);
    const days = [...new Set(r.days.map((d) => num(d, `${at} day`, 0, 6)))].sort();
    if (!TIME.test(r.start ?? '') || !TIME.test(r.end ?? '')) fail(`${at} times must look like 09:00`);
    if (r.start === r.end) fail(`${at} starts and ends at the same time`);
    return { days, start: r.start, end: r.end, layoutId: str(r.layoutId, `${at} layout`, 64) };
  });
}

export function timezone(v) {
  const tz = str(v ?? 'UTC', 'Time zone', 64) || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { fail(`Unknown time zone ${tz}`); }
  return tz;
}
