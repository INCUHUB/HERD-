/**
 * Sales history, cached a day at a time.
 *
 * Every tab in this app is a different question asked of the same thing:
 * the orders HERD has taken. Reading them from Square on each view would
 * mean thousands of records per refresh, so orders are read once, rolled
 * into per-day summaries, and every range is then assembled by summing
 * days. A day that has finished never changes, so it is never re-read.
 *
 * Fetching is done a calendar month at a time — far fewer, larger requests
 * than day by day — and only the current month is ever refreshed.
 */

const { squarePagedPost } = require("./square");
const T = require("./time");

const DAY_REFRESH_MS = Number(process.env.DAY_REFRESH_MS || 60000);
const TAPE_LIMIT = Number(process.env.TAPE_LIMIT || 40);

const blankDay = () => ({
  gross: 0,          // before discounts
  net: 0,            // what actually went through the till
  discounts: 0,
  tax: 0,
  tips: 0,
  refunds: 0,
  orders: 0,
  units: 0,
  hourly: new Array(24).fill(0),
  hourlyOrders: new Array(24).fill(0),
  lines: new Map(),      // variationId -> { units, revenue, name }
  unmatched: new Map(),  // free-text line name -> { units, revenue } (no catalogue link)
  staff: new Map(),      // teamMemberId -> { net, orders, units }
  tenders: new Map(),    // CARD / CASH / ...
  brands: new Map(),     // VISA / MASTERCARD / ...
  entries: new Map(),    // CONTACTLESS / EMV / KEYED / SWIPED
  sources: new Map(),    // Point of Sale / Square Online / ...
  tape: [],
});

const state = {
  days: new Map(),     // "2026-08-24" -> day summary
  months: new Map(),   // "2026-08"    -> { fetchedAt, complete }
  firstSeen: null,
  building: null,
};

const monthOf = iso => iso.slice(0, 7);

function monthBounds(tz, key) {
  const [y, m] = key.split("-").map(Number);
  const startUTC = new Date(Date.UTC(y, m - 1, 1));
  const endUTC = new Date(Date.UTC(y, m, 1));
  return {
    start: new Date(startUTC.getTime() - T.offsetMs(tz, startUTC)),
    end: new Date(endUTC.getTime() - T.offsetMs(tz, endUTC)),
  };
}

function monthsBetween(fromISO, toISO) {
  const out = [];
  let [y, m] = fromISO.split("-").slice(0, 2).map(Number);
  const [ey, em] = toISO.split("-").slice(0, 2).map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function bump(map, key, fields) {
  if (!key) return;
  const cur = map.get(key) || {};
  for (const [k, v] of Object.entries(fields)) cur[k] = (cur[k] || 0) + v;
  map.set(key, cur);
}

/* Fold one Square order into its day. */
function addOrder(day, order, tz, index) {
  const closed = order.closed_at || order.created_at;
  if (!closed) return;

  const net = order.net_amounts?.total_money?.amount ?? order.total_money?.amount ?? 0;
  const discounts = order.total_discount_money?.amount || 0;
  const tax = order.total_tax_money?.amount || 0;
  const tips = order.total_tip_money?.amount || 0;

  day.net += net;
  day.gross += net + discounts;
  day.discounts += discounts;
  day.tax += tax;
  day.tips += tips;
  day.orders += 1;

  const hour = T.hourOf(tz, closed);
  day.hourly[hour] += net;
  day.hourlyOrders[hour] += 1;

  let orderUnits = 0;
  const names = [];

  for (const li of order.line_items || []) {
    const units = Number(li.quantity || 0);
    const revenue = li.total_money?.amount || 0;
    orderUnits += units;

    const id = li.catalog_object_id;
    if (id) {
      const meta = index?.variations?.get(id);
      const cur = day.lines.get(id) || { units: 0, revenue: 0, name: meta?.label || li.name || "Item" };
      cur.units += units; cur.revenue += revenue;
      day.lines.set(id, cur);
      names.push(meta?.product || li.name || "Item");
    } else {
      // Custom amounts and deleted catalogue entries land here. Worth keeping
      // separate: they are real revenue but can never be reordered.
      const key = li.name || "Custom amount";
      bump(day.unmatched, key, { units, revenue });
      names.push(key);
    }
  }

  day.units += orderUnits;

  const staffId = order.created_by_team_member_id || (order.tenders || [])[0]?.team_member_id;
  if (staffId) bump(day.staff, staffId, { net, orders: 1, units: orderUnits });

  bump(day.sources, order.source?.name || "Point of Sale", { net, orders: 1 });

  for (const t of order.tenders || []) {
    bump(day.tenders, t.type || "OTHER", { net: t.amount_money?.amount || 0, count: 1 });
    const card = t.card_details?.card;
    if (card) bump(day.brands, card.card_brand || "OTHER", { net: t.amount_money?.amount || 0, count: 1 });
    if (t.card_details?.entry_method) {
      bump(day.entries, t.card_details.entry_method, { net: t.amount_money?.amount || 0, count: 1 });
    }
  }

  if (day.tape.length < 400) {
    const tender = (order.tenders || [])[0];
    day.tape.push({
      id: order.id,
      at: closed,
      clock: T.clock(tz, closed),
      net,
      units: orderUnits,
      items: names.slice(0, 4),
      more: Math.max(0, names.length - 4),
      tender: tender?.type || "",
      brand: tender?.card_details?.card?.card_brand || "",
      last4: tender?.card_details?.card?.last_4 || "",
      staffId: staffId || null,
    });
  }
}

async function fetchMonth(token, ctx, key) {
  const { tz, locationIds, index } = ctx;
  const { start, end } = monthBounds(tz, key);
  const now = new Date();
  const to = end > now ? now : end;

  const orders = await squarePagedPost(token, "/orders/search", {
    location_ids: locationIds,
    query: {
      filter: {
        date_time_filter: { closed_at: { start_at: start.toISOString(), end_at: to.toISOString() } },
        state_filter: { states: ["COMPLETED"] },
      },
      sort: { sort_field: "CLOSED_AT", sort_order: "ASC" },
    },
  }, "orders", 20000);

  // Rebuild every day in this month from scratch, so a re-read of the
  // current month replaces rather than doubles its figures.
  const touched = new Set();
  for (const o of orders) {
    const closed = o.closed_at || o.created_at;
    if (!closed) continue;
    const dk = T.localDay(tz, new Date(closed));
    if (!touched.has(dk)) { state.days.set(dk, blankDay()); touched.add(dk); }
    addOrder(state.days.get(dk), o, tz, index);
  }

  for (const dk of touched) {
    const day = state.days.get(dk);
    day.tape.sort((a, b) => new Date(b.at) - new Date(a.at));
    day.tape = day.tape.slice(0, TAPE_LIMIT);
    if (!state.firstSeen || dk < state.firstSeen) state.firstSeen = dk;
  }

  const complete = end <= now;
  state.months.set(key, { fetchedAt: Date.now(), complete });
  return orders.length;
}

/* Make sure every month spanning [from, to] has been read, refreshing only
   the current one. Concurrent callers share the same in-flight promise. */
async function ensureCoverage(token, ctx, fromISO, toISO) {
  const wanted = monthsBetween(fromISO, toISO);
  const stale = wanted.filter(key => {
    const m = state.months.get(key);
    if (!m) return true;
    if (m.complete) return false;
    return Date.now() - m.fetchedAt > DAY_REFRESH_MS;
  });
  if (!stale.length) return;

  if (state.building) { await state.building; return ensureCoverage(token, ctx, fromISO, toISO); }

  state.building = (async () => {
    for (const key of stale) {
      try { await fetchMonth(token, ctx, key); }
      catch (err) { console.warn(`[herd] could not read ${key}: ${err.message}`); }
    }
  })();
  try { await state.building; } finally { state.building = null; }
}

/* Sum the cached days between two instants. Partial first/last days are
   handled by filtering the tape and hourly buckets on the caller's side
   for single-day ranges; for multi-day ranges whole days is correct. */
function aggregate(tz, from, to) {
  const fromKey = T.localDay(tz, from);
  const toKey = T.localDay(tz, to);

  const total = {
    gross: 0, net: 0, discounts: 0, tax: 0, tips: 0, refunds: 0,
    orders: 0, units: 0,
    hourly: new Array(24).fill(0),
    hourlyOrders: new Array(24).fill(0),
    lines: new Map(), unmatched: new Map(), staff: new Map(),
    tenders: new Map(), brands: new Map(), entries: new Map(), sources: new Map(),
    series: [], tape: [],
  };

  for (let key = fromKey; key <= toKey; key = T.addDays(key, 1)) {
    const day = state.days.get(key);
    total.series.push({ day: key, net: day?.net || 0, orders: day?.orders || 0, units: day?.units || 0 });
    if (!day) continue;

    total.gross += day.gross; total.net += day.net;
    total.discounts += day.discounts; total.tax += day.tax;
    total.tips += day.tips; total.refunds += day.refunds;
    total.orders += day.orders; total.units += day.units;

    for (let h = 0; h < 24; h++) {
      total.hourly[h] += day.hourly[h];
      total.hourlyOrders[h] += day.hourlyOrders[h];
    }

    for (const [id, v] of day.lines) {
      const cur = total.lines.get(id) || { units: 0, revenue: 0, name: v.name };
      cur.units += v.units; cur.revenue += v.revenue;
      total.lines.set(id, cur);
    }
    for (const [k, v] of day.unmatched) bump(total.unmatched, k, v);
    for (const [k, v] of day.staff) bump(total.staff, k, v);
    for (const [k, v] of day.tenders) bump(total.tenders, k, v);
    for (const [k, v] of day.brands) bump(total.brands, k, v);
    for (const [k, v] of day.entries) bump(total.entries, k, v);
    for (const [k, v] of day.sources) bump(total.sources, k, v);

    total.tape.push(...day.tape);
  }

  total.tape.sort((a, b) => new Date(b.at) - new Date(a.at));
  total.tape = total.tape.slice(0, TAPE_LIMIT);
  return total;
}

/* Units sold per variation between two dates — the input to velocity. */
function unitsByVariation(tz, from, to) {
  const out = new Map();
  const fromKey = T.localDay(tz, from);
  const toKey = T.localDay(tz, to);
  for (let key = fromKey; key <= toKey; key = T.addDays(key, 1)) {
    const day = state.days.get(key);
    if (!day) continue;
    for (const [id, v] of day.lines) {
      const cur = out.get(id) || { units: 0, revenue: 0 };
      cur.units += v.units; cur.revenue += v.revenue;
      out.set(id, cur);
    }
  }
  return out;
}

/* First and last day each variation sold, across everything cached. Tells
   a genuinely new product apart from a dead one — both show zero recent
   sales, and they need opposite decisions. */
function lifespanByVariation() {
  const out = new Map();
  const keys = [...state.days.keys()].sort();
  for (const key of keys) {
    const day = state.days.get(key);
    for (const id of day.lines.keys()) {
      const cur = out.get(id) || { first: key, last: key, days: 0 };
      if (key < cur.first) cur.first = key;
      if (key > cur.last) cur.last = key;
      cur.days += 1;
      out.set(id, cur);
    }
  }
  return out;
}

const firstTradingDay = () => state.firstSeen;
const dayCount = () => state.days.size;
const daySummary = key => state.days.get(key) || null;

module.exports = {
  ensureCoverage, aggregate, unitsByVariation, lifespanByVariation,
  firstTradingDay, dayCount, daySummary, monthsBetween,
};
