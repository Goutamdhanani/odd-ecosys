const weekdayNumber = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatterCache = new Map();

function normalizeSendWindow(window = {}) {
  const timezone = typeof window.timezone === 'string' && window.timezone.trim() ? window.timezone.trim() : 'UTC';
  const startHour = Number(window.start_hour);
  const endHour = Number(window.end_hour);
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23
    || !Number.isInteger(endHour) || endHour < 1 || endHour > 24 || endHour <= startHour) {
    throw new TypeError('Send window hours must form a valid same-day interval.');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new TypeError('Send window timezone must be a valid IANA timezone.'); }
  return { timezone, startHour, endHour, weekdaysOnly: window.weekdays_only !== false };
}

function localClock(value, timezone) {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(value);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    weekday: weekdayNumber[values.weekday],
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  };
}

export function isWithinSendWindow(value = new Date(), window = {}) {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('Send window time must be a valid date.');
  const normalized = normalizeSendWindow(window);
  const local = localClock(instant, normalized.timezone);
  const weekdayAllowed = !normalized.weekdaysOnly || (local.weekday >= 1 && local.weekday <= 5);
  return weekdayAllowed
    && local.minuteOfDay >= normalized.startHour * 60
    && local.minuteOfDay < normalized.endHour * 60;
}

export function nextAllowedSendTime(value = new Date(), window = {}) {
  const instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('Send window time must be a valid date.');
  const normalized = normalizeSendWindow(window);
  if (isWithinSendWindow(instant, window)) return instant;

  let candidate = new Date(Math.ceil(instant.getTime() / 60000) * 60000);
  const maximumMinutes = 9 * 24 * 60;
  for (let minute = 0; minute < maximumMinutes; minute += 1) {
    const local = localClock(candidate, normalized.timezone);
    const weekdayAllowed = !normalized.weekdaysOnly || (local.weekday >= 1 && local.weekday <= 5);
    if (weekdayAllowed && local.minuteOfDay >= normalized.startHour * 60
      && local.minuteOfDay < normalized.endHour * 60) return candidate;
    candidate = new Date(candidate.getTime() + 60000);
  }
  throw new Error('No valid send window was found in the next nine days.');
}

export function getSendWindowState(value = new Date(), window = {}) {
  const instant = value instanceof Date ? value : new Date(value);
  const normalized = normalizeSendWindow(window);
  const open = isWithinSendWindow(instant, window);
  return {
    open,
    timezone: normalized.timezone,
    startHour: normalized.startHour,
    endHour: normalized.endHour,
    weekdaysOnly: normalized.weekdaysOnly,
    nextAllowedAt: open ? null : nextAllowedSendTime(instant, window).toISOString(),
  };
}
