// Which layout should be on screen right now. Shared by the player and the tests.

const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Day of week (0 = Sunday) and minutes since midnight, in the screen's time zone.
export function localParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return { day: DAY_INDEX[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// A rule like Fri 22:00-02:00 covers Friday 22:00-24:00 and Saturday 00:00-02:00.
export function ruleMatches(rule, { day, minutes }) {
  const start = toMinutes(rule.start), end = toMinutes(rule.end);
  if (start < end) return rule.days.includes(day) && minutes >= start && minutes < end;
  const yesterday = (day + 6) % 7;
  return (rule.days.includes(day) && minutes >= start) || (rule.days.includes(yesterday) && minutes < end);
}

export function activeLayoutId(manifest, date = new Date()) {
  const now = localParts(date, manifest.screen?.timezone || 'UTC');
  for (const rule of manifest.schedule || []) {
    if (manifest.layouts?.[rule.layoutId] && ruleMatches(rule, now)) return rule.layoutId;
  }
  return manifest.layouts?.[manifest.defaultLayoutId] ? manifest.defaultLayoutId : null;
}
