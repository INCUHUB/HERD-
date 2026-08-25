/**
 * The diary — one calendar carrying four different kinds of thing.
 *
 *   rota       who is working, live from Square's schedule
 *   social     posts planned, drafted, scheduled or published
 *   events     in-store events, brand drops, late openings
 *   deliveries expected arrivals, created automatically whenever a
 *              reorder is marked as ordered on the Stock tab
 *
 * Rota and deliveries are derived — Square owns one, the purchase order
 * store owns the other. Only social and events are edited here.
 */

const store = require("./store");
const T = require("./time");
const stock = require("./stock");

const DIARY = "diary";
const blank = { entries: [] };

const CHANNELS = ["Instagram", "Instagram Story", "TikTok", "Email", "Website", "Press", "Other"];
const STAGES = ["idea", "drafting", "scheduled", "published"];

const id = prefix => prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function entries() {
  return store.read(DIARY, blank).entries;
}

function addEntry(input) {
  const entry = {
    id: id(input.type === "social" ? "soc" : "evt"),
    type: input.type === "social" ? "social" : "event",
    title: String(input.title || "").slice(0, 200),
    day: input.day,                              // YYYY-MM-DD
    time: input.time || "",                      // HH:MM, optional
    endDay: input.endDay || null,                // multi-day events
    channel: input.channel || "",
    stage: STAGES.includes(input.stage) ? input.stage : "idea",
    owner: input.owner || "",
    notes: String(input.notes || "").slice(0, 2000),
    link: input.link || "",
    createdAt: new Date().toISOString(),
  };
  if (!entry.title || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day || "")) {
    const err = new Error("An entry needs a title and a date");
    err.status = 400;
    throw err;
  }
  store.update(DIARY, blank, s => { s.entries.push(entry); return s; });
  return entry;
}

function updateEntry(entryId, patch) {
  let found = null;
  store.update(DIARY, blank, s => {
    const e = s.entries.find(x => x.id === entryId);
    if (e) {
      for (const k of ["title", "day", "time", "endDay", "channel", "stage", "owner", "notes", "link"]) {
        if (k in patch) e[k] = patch[k];
      }
      e.updatedAt = new Date().toISOString();
      found = e;
    }
    return s;
  });
  return found;
}

function removeEntry(entryId) {
  let removed = false;
  store.update(DIARY, blank, s => {
    const before = s.entries.length;
    s.entries = s.entries.filter(e => e.id !== entryId);
    removed = s.entries.length < before;
    return s;
  });
  return removed;
}

/* Expected arrivals, derived from open purchase orders. Not editable here:
   the way to change one is to change the order it came from. */
function deliveries() {
  return stock.purchaseOrders()
    .filter(po => po.status === "open")
    .map(po => ({
      id: po.id,
      type: "delivery",
      title: po.label || `${po.brand} order`,
      day: po.expected,
      brand: po.brand,
      qty: po.qty,
      raised: po.raised,
      notes: po.note || "",
      overdue: po.expected < new Date().toISOString().slice(0, 10),
    }));
}

/**
 * Assemble the diary for a window. `rota` is passed in from the team
 * report so Square is not asked for the schedule twice.
 */
function build({ tz, fromDay, toDay, rota = [] }) {
  const manual = entries().filter(e => {
    const end = e.endDay || e.day;
    return end >= fromDay && e.day <= toDay;
  });

  const deliv = deliveries().filter(d => d.day >= fromDay && d.day <= toDay);
  const shifts = rota.filter(s => s.day && s.day >= fromDay && s.day <= toDay);

  const days = new Map();
  const ensure = day => {
    if (!days.has(day)) days.set(day, { day, weekday: T.WEEKDAYS[T.weekdayIndex(day)], rota: [], social: [], events: [], deliveries: [] });
    return days.get(day);
  };

  for (let d = fromDay; d <= toDay; d = T.addDays(d, 1)) ensure(d);

  for (const s of shifts) ensure(s.day).rota.push(s);
  for (const d of deliv) ensure(d.day).deliveries.push(d);
  for (const e of manual) {
    const bucket = e.type === "social" ? "social" : "events";
    // A multi-day event shows on every day it covers.
    const end = e.endDay && e.endDay > e.day ? e.endDay : e.day;
    for (let d = e.day; d <= end && d <= toDay; d = T.addDays(d, 1)) {
      if (d < fromDay) continue;
      ensure(d)[bucket].push({ ...e, spans: end !== e.day, isStart: d === e.day });
    }
  }

  for (const day of days.values()) {
    day.rota.sort((a, b) => (a.from || "").localeCompare(b.from || ""));
    day.social.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    day.events.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    day.hours = Math.round(day.rota.reduce((s, r) => s + (r.hours || 0), 0) * 10) / 10;
  }

  const list = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));

  return {
    ok: true,
    from: fromDay, to: toDay,
    persistent: store.isPersistent(),
    channels: CHANNELS,
    stages: STAGES,
    days: list,
    counts: {
      shifts: shifts.length,
      social: manual.filter(e => e.type === "social").length,
      events: manual.filter(e => e.type === "event").length,
      deliveries: deliv.length,
      unpublishedShifts: shifts.filter(s => !s.published).length,
      overdueDeliveries: deliv.filter(d => d.overdue).length,
    },
  };
}

module.exports = { build, addEntry, updateEntry, removeEntry, entries, deliveries, CHANNELS, STAGES };
