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
const shopify = require("./shopify");
const store = require("./store");
const T = require("./time");

/* Where a sale happened. Square is the till in the shop; Shopify is the
   website. Every figure in the app is the sum of both, and every day keeps
   the split so the two can be told apart anywhere they need to be. */
const INSTORE = "instore";
const ONLINE = "online";

/* Square orders that are really web orders. Once the Shopify to Square
   connector (DPL) is pushing online orders into Square, each web sale
   exists twice. When the Shopify feed is live it is the one counted and
   the Square copy is skipped; without it, the Square copy is kept and
   labelled online. "Square Online" is Square's own web shop: always
   online, never a copy. */
const MIRROR_SOURCE = new RegExp(process.env.SQUARE_SHOPIFY_SOURCES || "shopify|dpl", "i");
const WEB_SOURCE = new RegExp(process.env.SQUARE_WEB_SOURCES || "shopify|dpl|square online|online store|ecom", "i");

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
  channels: new Map(),   // instore / online -> { net, gross, discounts, shipping, orders, units }
  webLines: new Map(),   // online sales by product -> { units, revenue, name, brand, linked }
  webPlaces: new Map(),  // where online orders ship to -> { net, orders }
  tape: [],
});

const state = {
  days: new Map(),     // "2026-08-24" -> day summary
  months: new Map(),   // "2026-08"    -> { fetchedAt, complete }
  firstSeen: null,
  building: null,
  webError: null,
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

function bumpChannel(day, channel, f) {
  bump(day.channels, channel, {
    net: f.net || 0, gross: f.gross || 0, discounts: f.discounts || 0,
    shipping: f.shipping || 0, orders: 1, units: f.units || 0,
  });
}

/* Fold one Square order into its day. */
function addOrder(day, order, tz, index) {
  const closed = order.closed_at || order.created_at;
  if (!closed) return;

  const sourceName = order.source?.name || "Point of Sale";
  const channel = WEB_SOURCE.test(sourceName) ? ONLINE : INSTORE;

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

  // The hour chart is about the shop floor (staffing, busy hours), so it
  // only carries sales made in the shop.
  if (channel === INSTORE) {
    const hour = T.hourOf(tz, closed);
    day.hourly[hour] += net;
    day.hourlyOrders[hour] += 1;
  }

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
  bumpChannel(day, channel, { net, gross: net + discounts, discounts, units: orderUnits });

  const staffId = order.created_by_team_member_id || (order.tenders || [])[0]?.team_member_id;
  if (staffId) bump(day.staff, staffId, { net, orders: 1, units: orderUnits });

  bump(day.sources, sourceName, { net, orders: 1 });

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
      channel,
    });
  }
}

/* ── Shopify ─────────────────────────────────────────────────── */

const norm = s => String(s || "").toLowerCase().normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/* Link a web line to the Square variation it is, so an online sale counts
   toward that product's stock velocity exactly like a sale in the shop.
   SKU first (the reliable route, and the one the sync connector uses);
   failing that, product name plus size. */
let linkCache = { index: null, bySku: null, byName: null };
function linker(index) {
  if (linkCache.index === index) return linkCache;
  const bySku = new Map(), byName = new Map(), byProduct = new Map();
  for (const v of index?.variations?.values() || []) {
    if (v.sku) bySku.set(v.sku.trim().toLowerCase(), v.id);
    byName.set(norm(v.product) + "|" + norm(v.size), v.id);
    const list = byProduct.get(norm(v.product)) || [];
    list.push(v.id);
    byProduct.set(norm(v.product), list);
  }
  // A product with a single variation can be matched on its name alone.
  for (const [k, ids] of byProduct) if (ids.length === 1) byName.set(k + "|", ids[0]);
  linkCache = { index, bySku, byName };
  return linkCache;
}

function linkLine(li, index) {
  const { bySku, byName } = linker(index);
  if (li.sku && bySku.has(li.sku.toLowerCase())) return bySku.get(li.sku.toLowerCase());
  const t = norm(li.title), v = norm(li.variant);
  return byName.get(t + "|" + v) || (v ? null : byName.get(t + "|")) || null;
}

/* Shopify leaves vendor as the shop's own name unless it is filled in,
   which says nothing about the brand. */
const STORE_VENDORS = /^(my store|herd|the herd store|herd store)$/i;

function addShopifyOrder(day, o, tz, index) {
  const units = o.lines.reduce((s, l) => s + l.qty, 0);
  // Shopify POS would be a sale in the shop; everything else is the website.
  const channel = /^pos$/i.test(o.source) ? INSTORE : ONLINE;

  day.net += o.net;
  day.gross += o.net + o.discounts;
  day.discounts += o.discounts;
  day.tax += o.tax;
  day.refunds += o.refunded;
  day.orders += 1;
  day.units += units;
  bumpChannel(day, channel, { net: o.net, gross: o.net + o.discounts, discounts: o.discounts, shipping: o.shipping, units });
  bump(day.sources, channel === ONLINE ? "Website (Shopify)" : "Shopify POS", { net: o.net, orders: 1 });
  bump(day.tenders, "ONLINE", { net: o.net, count: 1 });

  const names = [];
  for (const li of o.lines) {
    if (!li.qty) continue;
    const id = linkLine(li, index);
    const meta = id ? index?.variations?.get(id) : null;
    const label = meta?.label || [li.title, li.variant].filter(Boolean).join(" · ");
    const brand = meta?.brand || (STORE_VENDORS.test(li.vendor) ? "" : li.vendor);

    if (id) {
      const cur = day.lines.get(id) || { units: 0, revenue: 0, name: label };
      cur.units += li.qty; cur.revenue += li.revenue;
      day.lines.set(id, cur);
    } else {
      bump(day.unmatched, `${label} (online)`, { units: li.qty, revenue: li.revenue });
    }

    const key = id || "web:" + label;
    const w = day.webLines.get(key) || { units: 0, revenue: 0, name: label, brand, linked: Boolean(id) };
    w.units += li.qty; w.revenue += li.revenue;
    day.webLines.set(key, w);
    names.push(meta?.product || li.title);
  }

  if (channel === ONLINE) {
    const place = o.city ? (o.country && o.country !== "GB" ? `${o.city}, ${o.country}` : o.city) : (o.country || "Unknown");
    bump(day.webPlaces, place, { net: o.net, orders: 1 });
  }

  if (day.tape.length < 400) {
    day.tape.push({
      id: o.id,
      ref: o.name,
      at: o.at,
      clock: T.clock(tz, o.at),
      net: o.net,
      units,
      items: names.slice(0, 4),
      more: Math.max(0, names.length - 4),
      tender: "ONLINE",
      brand: "",
      last4: "",
      staffId: null,
      channel,
      place: o.city || "",
      fulfilment: o.fulfilment,
    });
  }
}

/* Online orders for one month. A finished month is kept on disk, because
   Shopify stops returning orders older than 60 days unless the app has the
   read_all_orders scope, and the in-memory cache is lost on every deploy. */
async function shopifyMonth(key, start, end, complete) {
  const saved = store.read(`shopify-${key}`, null);
  if (saved && saved.complete) return saved.orders;

  const orders = await shopify.ordersBetween(start, end);
  if (complete) {
    try { store.write(`shopify-${key}`, { complete: true, savedAt: new Date().toISOString(), orders }); } catch {}
  }
  return orders;
}

const counted = o => !o.cancelled && !o.test && (o.net > 0 || o.lines.some(l => l.qty > 0));

async function fetchMonth(token, ctx, key) {
  const { tz, locationIds, index } = ctx;
  const { start, end } = monthBounds(tz, key);
  const now = new Date();
  const to = end > now ? now : end;
  const complete = end <= now;

  const web = shopify.enabled();
  const [sq, sh] = await Promise.allSettled([
    squarePagedPost(token, "/orders/search", {
      location_ids: locationIds,
      query: {
        filter: {
          date_time_filter: { closed_at: { start_at: start.toISOString(), end_at: to.toISOString() } },
          state_filter: { states: ["COMPLETED"] },
        },
        sort: { sort_field: "CLOSED_AT", sort_order: "ASC" },
      },
    }, "orders", 20000),
    web ? shopifyMonth(key, start, to, complete) : Promise.resolve([]),
  ]);

  // Square is the till: without it there is no month to show.
  if (sq.status === "rejected") throw sq.reason;
  const orders = sq.value;
  const webOrders = sh.status === "fulfilled" ? sh.value.filter(counted) : [];
  if (sh.status === "rejected") {
    state.webError = sh.reason?.message || "Shopify unavailable";
    console.warn(`[herd] shopify ${key}: ${state.webError}`);
  } else if (web) {
    state.webError = null;
  }

  // Rebuild every day in this month from scratch, so a re-read of the
  // current month replaces rather than doubles its figures.
  const touched = new Set();
  const dayFor = iso => {
    const dk = T.localDay(tz, new Date(iso));
    if (!touched.has(dk)) { state.days.set(dk, blankDay()); touched.add(dk); }
    return state.days.get(dk);
  };

  for (const o of orders) {
    const closed = o.closed_at || o.created_at;
    if (!closed) continue;
    // With the Shopify feed live, a web order copied into Square is counted
    // once, from Shopify.
    if (web && MIRROR_SOURCE.test(o.source?.name || "")) continue;
    addOrder(dayFor(closed), o, tz, index);
  }
  for (const o of webOrders) {
    if (!o.at) continue;
    addShopifyOrder(dayFor(o.at), o, tz, index);
  }

  for (const dk of touched) {
    const day = state.days.get(dk);
    day.tape.sort((a, b) => new Date(b.at) - new Date(a.at));
    day.tape = day.tape.slice(0, TAPE_LIMIT);
    if (!state.firstSeen || dk < state.firstSeen) state.firstSeen = dk;
  }

  // A month whose online half failed is not finished, so it is read again.
  const webOk = !web || sh.status === "fulfilled";
  state.months.set(key, { fetchedAt: Date.now(), complete: complete && webOk });
  return orders.length + webOrders.length;
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
    channels: new Map(), webLines: new Map(), webPlaces: new Map(),
    series: [], tape: [],
  };

  for (let key = fromKey; key <= toKey; key = T.addDays(key, 1)) {
    const day = state.days.get(key);
    const ins = day?.channels.get(INSTORE) || {};
    const onl = day?.channels.get(ONLINE) || {};
    total.series.push({
      day: key, net: day?.net || 0, orders: day?.orders || 0, units: day?.units || 0,
      instore: ins.net || 0, online: onl.net || 0,
      instoreOrders: ins.orders || 0, onlineOrders: onl.orders || 0,
    });
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
    for (const [k, v] of day.channels) bump(total.channels, k, v);
    for (const [k, v] of day.webPlaces) bump(total.webPlaces, k, v);
    for (const [k, v] of day.webLines) {
      const cur = total.webLines.get(k) || { units: 0, revenue: 0, name: v.name, brand: v.brand, linked: v.linked };
      cur.units += v.units; cur.revenue += v.revenue;
      total.webLines.set(k, cur);
    }

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
const webStatus = () => ({ ...shopify.status(), error: state.webError || shopify.status().error || null });
const dayCount = () => state.days.size;
const daySummary = key => state.days.get(key) || null;

module.exports = {
  ensureCoverage, aggregate, unitsByVariation, lifespanByVariation,
  firstTradingDay, dayCount, daySummary, monthsBetween, webStatus,
  INSTORE, ONLINE,
};
