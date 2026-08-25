/**
 * Local time and reporting ranges.
 *
 * Everything is computed in the store's own timezone. A UTC day boundary
 * would be an hour out for half the year in the UK, which quietly moves
 * the first and last sale of every day into the wrong bucket.
 */

function parts(tz, date) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour12: false, weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: p.hour === "24" ? 0 : +p.hour, minute: +p.minute, second: +p.second,
    weekday: p.weekday,
  };
}

function offsetMs(tz, date) {
  const p = parts(tz, date);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/* UTC instant of local midnight, `back` days before today. */
function midnight(tz, back = 0) {
  const p = parts(tz, new Date());
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day - back, 0, 0, 0));
  return new Date(d.getTime() - offsetMs(tz, d));
}

function monthStart(tz, monthsBack = 0) {
  const p = parts(tz, new Date());
  const d = new Date(Date.UTC(p.year, p.month - 1 - monthsBack, 1, 0, 0, 0));
  return new Date(d.getTime() - offsetMs(tz, d));
}

/* Same day-of-month and clock time, N months ago, clamped to that month's
   length — 31 March has no counterpart in February. */
function sameDayLastMonth(tz, monthsBack = 1) {
  const p = parts(tz, new Date());
  const y = p.year, m = p.month - 1 - monthsBack;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(p.day, lastDay);
  const d = new Date(Date.UTC(y, m, day, p.hour, p.minute, p.second));
  return new Date(d.getTime() - offsetMs(tz, d));
}

const localDay = (tz, date) => {
  const p = parts(tz, date instanceof Date ? date : new Date(date));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};
const dayKey = localDay;
const hourOf = (tz, iso) => parts(tz, new Date(iso)).hour;
const weekdayOf = (tz, iso) => parts(tz, new Date(iso)).weekday;
const clock = (tz, iso) => {
  const p = parts(tz, new Date(iso));
  return String(p.hour).padStart(2, "0") + ":" + String(p.minute).padStart(2, "0");
};

const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (aIso, bIso) =>
  Math.round((new Date(bIso + "T00:00:00Z") - new Date(aIso + "T00:00:00Z")) / 864e5);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekdayIndex = iso => new Date(iso + "T00:00:00Z").getUTCDay();

/* Monday-first week containing `iso`. Retail weeks run Mon–Sun here; a
   Sunday-first week would split the weekend, which is most of the trade. */
function weekStart(iso) {
  const idx = weekdayIndex(iso);
  return addDays(iso, idx === 0 ? -6 : 1 - idx);
}

/* ── Ranges ───────────────────────────────────────────────────
   Comparisons are weekday-matched. A Saturday is measured against
   the previous Saturday, not against Friday — retail trade varies
   far more by day of week than week to week. The multi-day windows
   are whole numbers of weeks precisely so the preceding window holds
   the same weekday mix; 30 days would not.                       */

const RANGES = {
  today:     { label: "Today",         days: 1,  buckets: "hour" },
  yesterday: { label: "Yesterday",     days: 1,  buckets: "hour" },
  week:      { label: "Last 7 days",   days: 7,  buckets: "day"  },
  four:      { label: "Last 28 days",  days: 28, buckets: "day"  },
  thirteen:  { label: "Last 13 weeks", days: 91, buckets: "day"  },
  mtd:       { label: "Month to date", days: 0,  buckets: "day"  },
  since:     { label: "Since opening", days: 0,  buckets: "day"  },
};

function rangeSpec(tz, key, openedISO) {
  const r = RANGES[key] || RANGES.today;
  const now = new Date();
  const WEEK = 7;

  if (key === "since") {
    const start = openedISO
      ? new Date(new Date(openedISO + "T00:00:00Z").getTime() - offsetMs(tz, new Date(openedISO + "T00:00:00Z")))
      : midnight(tz, 364);
    return {
      ...r, buckets: "day", start, end: now,
      prevStart: null, prevEnd: null,
      comparison: "no comparison — this is the whole trading history",
    };
  }

  if (key === "mtd") {
    const days = parts(tz, now).day;
    return {
      ...r, days, buckets: "day",
      start: monthStart(tz, 0), end: now,
      prevStart: monthStart(tz, 1), prevEnd: sameDayLastMonth(tz, 1),
      comparison: "vs the same days last month",
    };
  }

  if (key === "yesterday") {
    return {
      ...r,
      start: midnight(tz, 1), end: midnight(tz, 0),
      prevStart: midnight(tz, 1 + WEEK), prevEnd: midnight(tz, WEEK),
      comparison: "vs the same weekday last week",
    };
  }

  if (key === "today") {
    const start = midnight(tz, 0);
    const prevStart = midnight(tz, WEEK);
    return {
      ...r, start, end: now, prevStart,
      prevEnd: new Date(prevStart.getTime() + (now - start)),
      comparison: "vs the same weekday last week",
    };
  }

  // Rolling windows. The previous window stops at the same point through its
  // final day, so a part-completed today is never set against a full day.
  const start = midnight(tz, r.days - 1);
  const prevStart = midnight(tz, r.days * 2 - 1);
  const weeks = r.days / 7;
  return {
    ...r, start, end: now, prevStart,
    prevEnd: new Date(prevStart.getTime() + (now - start)),
    comparison: `vs the previous ${Number.isInteger(weeks) && weeks > 1 ? weeks + " weeks" : r.days + " days"}`,
  };
}

module.exports = {
  parts, offsetMs, midnight, monthStart, sameDayLastMonth,
  localDay, dayKey, hourOf, weekdayOf, clock,
  addDays, daysBetween, weekStart, weekdayIndex, WEEKDAYS,
  RANGES, rangeSpec,
};
