/**
 * The reorder engine.
 *
 * A flat low-stock threshold is the wrong instrument for a clothing shop.
 * Two left means nothing on its own: two left of a jacket selling one a day
 * is an emergency, two left of one selling one a month is fine for eight
 * weeks. So everything here is expressed in *days of cover* — stock on hand
 * divided by how fast that line is actually selling — and then measured
 * against how long the brand takes to deliver.
 *
 * The question the tab answers is not "what is low" but "what is selling
 * well enough that I need to reorder it before it sells out".
 *
 *   velocity      units per day, weighted towards the last week
 *   days of cover on-hand ÷ velocity
 *   reorder point velocity × (lead time + safety days)
 *   at risk       revenue lost per stockout day × days you'd be out
 *
 * Ranking is by revenue at risk, so the list is ordered by what the gap
 * costs rather than alphabetically or by how few units remain.
 */

const { square } = require("./square");
const T = require("./time");
const sales = require("./sales");
const store = require("./store");

const SAFETY_DAYS      = Number(process.env.SAFETY_DAYS || 7);
const TARGET_COVER_DAYS= Number(process.env.TARGET_COVER_DAYS || 42);
const OVERSTOCK_DAYS   = Number(process.env.OVERSTOCK_DAYS || 120);
const NEW_PRODUCT_DAYS = Number(process.env.NEW_PRODUCT_DAYS || 21);
const DEFAULT_LEAD_TIME= Number(process.env.DEFAULT_LEAD_TIME_DAYS || 21);
const RISING_RATIO     = Number(process.env.RISING_RATIO || 1.4);

/* Weight on the last 7 days vs the last 28. Retail turns quickly and a
   four-week average is slow to notice a line taking off, but a pure
   seven-day rate is noisy at low volumes — so blend them. */
const RECENCY_WEIGHT = Number(process.env.RECENCY_WEIGHT || 0.6);

const LEAD_TIMES = "lead-times";
const PURCHASE_ORDERS = "purchase-orders";

const round = (n, p = 1) => Math.round(n * 10 ** p) / 10 ** p;

/* ── Lead times ─────────────────────────────────────────────── */

function leadTimes() {
  return store.read(LEAD_TIMES, { default: DEFAULT_LEAD_TIME, brands: {} });
}
function leadTimeFor(brand, table) {
  const t = table || leadTimes();
  return Number(t.brands?.[brand] ?? t.default ?? DEFAULT_LEAD_TIME);
}
function setLeadTime(brand, days) {
  return store.update(LEAD_TIMES, { default: DEFAULT_LEAD_TIME, brands: {} }, t => {
    if (brand === "__default__") t.default = Number(days);
    else if (days === null || days === "") delete t.brands[brand];
    else t.brands[brand] = Number(days);
    return t;
  });
}

/* ── Purchase orders ────────────────────────────────────────────
   Marking a line as ordered does two things: it stops the alerts
   nagging about something already dealt with, and it puts an
   expected delivery in the diary. */

function purchaseOrders() {
  return store.read(PURCHASE_ORDERS, { orders: [] }).orders;
}

function raisePurchaseOrder({ variationIds, productId, brand, label, qty, leadDays, note }) {
  const id = "po_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const raised = new Date().toISOString();
  const expected = T.addDays(raised.slice(0, 10), Number(leadDays || DEFAULT_LEAD_TIME));
  const po = {
    id, raised, expected,
    variationIds: variationIds || [],
    productId: productId || null,
    brand: brand || "",
    label: label || "",
    qty: Number(qty || 0),
    note: note || "",
    status: "open",
  };
  store.update(PURCHASE_ORDERS, { orders: [] }, s => { s.orders.unshift(po); return s; });
  return po;
}

function updatePurchaseOrder(id, patch) {
  let found = null;
  store.update(PURCHASE_ORDERS, { orders: [] }, s => {
    const po = s.orders.find(o => o.id === id);
    if (po) { Object.assign(po, patch); found = po; }
    return s;
  });
  return found;
}

/* variationId -> open PO covering it */
function openOrderIndex() {
  const idx = new Map();
  for (const po of purchaseOrders()) {
    if (po.status !== "open") continue;
    for (const vid of po.variationIds) idx.set(vid, po);
  }
  return idx;
}

/* ── Inventory ──────────────────────────────────────────────── */

async function inventoryCounts(token, ids, locationIds) {
  const counts = new Map();
  for (let i = 0; i < ids.length; i += 250) {
    const batch = ids.slice(i, i + 250);
    let cursor;
    do {
      const page = await square(token, "/inventory/counts/batch-retrieve", {
        method: "POST",
        body: { catalog_object_ids: batch, location_ids: locationIds, cursor },
      });
      for (const c of page.counts || []) {
        if (c.state !== "IN_STOCK") continue;
        counts.set(c.catalog_object_id, (counts.get(c.catalog_object_id) || 0) + Number(c.quantity || 0));
      }
      cursor = page.cursor;
    } while (cursor);
  }
  return counts;
}

/* ── The engine ─────────────────────────────────────────────── */

function analyseVariation(v, ctx) {
  const { counts, w7, w14, w28, w56, life, table, orders, today } = ctx;

  const onHand = counts.get(v.id) ?? 0;
  const u7  = w7.get(v.id)?.units  || 0;
  const u14 = w14.get(v.id)?.units || 0;
  const u28 = w28.get(v.id)?.units || 0;
  const u56 = w56.get(v.id)?.units || 0;
  const r28 = w28.get(v.id)?.revenue || 0;
  const span = life.get(v.id);

  // How long this line has genuinely had a chance to sell. Dividing four
  // weeks of sales by 28 days understates something that only landed last
  // Tuesday, which is exactly the line most likely to need reordering.
  const firstDay = span?.first || (v.createdAt ? v.createdAt.slice(0, 10) : null);
  const daysOnFloor = firstDay ? Math.max(1, T.daysBetween(firstDay, today) + 1) : null;
  const window7  = Math.min(7,  daysOnFloor ?? 7);
  const window28 = Math.min(28, daysOnFloor ?? 28);

  const v7  = u7  / window7;
  const v28 = u28 / window28;
  const velocity = RECENCY_WEIGHT * v7 + (1 - RECENCY_WEIGHT) * v28;

  // Trend needs a baseline to be meaningful; with no sales in the older
  // window a single sale would read as infinite acceleration.
  const trend = v28 > 0 ? v7 / v28 : (u7 > 0 ? null : 1);

  const leadTime = leadTimeFor(v.brand, table);
  const reorderPoint = velocity * (leadTime + SAFETY_DAYS);
  const daysCover = velocity > 0 ? onHand / velocity : (onHand > 0 ? null : 0);

  const po = orders.get(v.id) || null;
  const isNew = daysOnFloor !== null && daysOnFloor <= NEW_PRODUCT_DAYS;

  let status;
  if (onHand <= 0 && velocity > 0)                   status = "stockout";
  else if (onHand <= 0)                              status = "empty";
  else if (velocity <= 0 && !isNew && daysOnFloor > OVERSTOCK_DAYS) status = "dead";
  else if (velocity <= 0)                            status = "idle";
  else if (onHand <= reorderPoint)                   status = "reorder";
  else if (onHand <= reorderPoint * 1.5)             status = "watch";
  else if (daysCover !== null && daysCover >= OVERSTOCK_DAYS) status = "overstocked";
  else                                               status = "healthy";

  // Something already on order isn't a decision you still have to make.
  if (po && (status === "reorder" || status === "stockout" || status === "watch")) status = "ordered";

  // Days you'd spend out of stock if you ordered right now.
  const gap = daysCover === null ? 0 : Math.max(0, leadTime - daysCover);
  const revenueAtRisk = velocity * v.price * gap;

  const soldEver = u56 >= u28 ? u56 : u28;
  const sellThrough = (soldEver + onHand) > 0 ? soldEver / (soldEver + onHand) : 0;

  const suggested = Math.max(0, Math.ceil(velocity * (leadTime + TARGET_COVER_DAYS) - onHand));

  return {
    id: v.id, itemId: v.itemId,
    product: v.product, size: v.size, label: v.label,
    brand: v.brand, category: v.category, sku: v.sku, price: v.price,
    onHand, u7, u14, u28, r28,
    daysOnFloor, isNew,
    velocity: round(velocity, 3),
    perWeek: round(velocity * 7, 1),
    trend: trend === null ? null : round(trend, 2),
    rising: trend !== null && trend >= RISING_RATIO && u7 >= 2,
    fading: trend !== null && trend <= 0.6 && u28 >= 3,
    daysCover: daysCover === null ? null : round(daysCover, 1),
    leadTime,
    reorderPoint: round(reorderPoint, 1),
    suggested,
    revenueAtRisk: Math.round(revenueAtRisk),
    sellThrough: round(sellThrough * 100, 0),
    stockValue: onHand * v.price,
    status,
    purchaseOrder: po ? { id: po.id, expected: po.expected, qty: po.qty } : null,
  };
}

/* Product-level view. A product is reorderable as a whole even when only
   two of its five sizes are short, and a size run with the middle missing
   is effectively dead on the rail whatever the total count says. */
function rollUp(product, rows) {
  const mine = rows.filter(r => r.itemId === product.id);
  if (!mine.length) return null;

  const onHand = mine.reduce((s, r) => s + r.onHand, 0);
  const velocity = mine.reduce((s, r) => s + r.velocity, 0);
  const u7 = mine.reduce((s, r) => s + r.u7, 0);
  const u28 = mine.reduce((s, r) => s + r.u28, 0);
  const r28 = mine.reduce((s, r) => s + r.r28, 0);
  const atRisk = mine.reduce((s, r) => s + r.revenueAtRisk, 0);
  const stockValue = mine.reduce((s, r) => s + r.stockValue, 0);
  const suggested = mine.reduce((s, r) => s + r.suggested, 0);

  const sizesOut = mine.filter(r => r.onHand <= 0);
  const sizesIn = mine.filter(r => r.onHand > 0);

  // The size that sells most is the one whose absence costs most. If it's
  // gone while others remain, the rail looks stocked and sells nothing.
  const best = [...mine].sort((a, b) => b.u28 - a.u28)[0];
  const brokenRun = mine.length > 1 && sizesIn.length > 0 && best && best.onHand <= 0 && best.u28 > 0;

  const daysCover = velocity > 0 ? round(onHand / velocity, 1) : null;
  const leadTime = mine[0].leadTime;
  const reorderPoint = velocity * (leadTime + SAFETY_DAYS);

  // Status is judged on the product as a whole, not by taking the worst of
  // its sizes. A jacket with four weeks of cover is not "out of stock"
  // because one size has gone — that is a broken run, which needs the same
  // reorder but is a different fact, and saying "out" would be false.
  const anyOrdered = mine.some(r => r.purchaseOrder);
  const allNew = mine.every(r => r.isNew);

  let status;
  if (onHand <= 0 && velocity > 0)          status = "stockout";
  else if (onHand <= 0)                     status = "empty";
  else if (brokenRun)                       status = "reorder";
  else if (velocity <= 0 && allNew)         status = "idle";
  else if (velocity <= 0)                   status = "dead";
  else if (onHand <= reorderPoint)          status = "reorder";
  else if (onHand <= reorderPoint * 1.5)    status = "watch";
  else if (daysCover >= OVERSTOCK_DAYS)     status = "overstocked";
  else                                      status = "healthy";

  if (anyOrdered && ["reorder", "stockout", "watch"].includes(status)) status = "ordered";

  // Product-level trend, from the product's own totals rather than
  // whichever size happened to be first in the list.
  const trend = u28 > 0 ? round((u7 / 7) / (u28 / 28), 2) : null;

  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    leadTime,
    onHand, velocity: round(velocity, 3), perWeek: round(velocity * 7, 1),
    u7, u28, r28, daysCover,
    reorderPoint: round(reorderPoint, 1),
    revenueAtRisk: atRisk, stockValue, suggested,
    sizeCount: mine.length,
    sizesOut: sizesOut.map(r => r.size || "—"),
    sizesIn: sizesIn.map(r => ({ size: r.size || "—", onHand: r.onHand, status: r.status })),
    brokenRun,
    bestSize: best ? (best.size || "—") : null,
    trend,
    rising: trend !== null && trend >= RISING_RATIO && u7 >= 2,
    fading: trend !== null && trend <= 0.6 && u28 >= 3,
    isNew: allNew,
    onOrder: anyOrdered,
    status,
    sizes: mine,
  };
}

/* ── Brand performance ──────────────────────────────────────────
   The measures a buyer actually uses, borrowed from the standard
   retail merchandising set rather than invented here:

     rate of sale    units per week — the trading floor's own unit
     sell-through %  sold ÷ (sold + on hand) — the number apparel
                     buying runs on; ~70–80% over a season is healthy
     weeks of cover  on hand ÷ rate of sale
     stock turn      annualised rate of sale against average stock
     ABC class       Pareto: A = the brands making the first 80% of
                     revenue, B the next 15%, C the tail

   Value and volume are reported side by side and ranked separately
   on purpose. Ranking on revenue alone buries a cheap line selling
   in quantity; at a roughly common margin rate those units are worth
   the same per pound as an expensive one, and they are usually what
   brings people through the door. Where a brand's two ranks diverge
   sharply, that is the fact worth seeing. */

function brandSummary(products, windowDays = 28) {
  const weeks = windowDays / 7;
  const byBrand = new Map();

  for (const p of products) {
    const b = byBrand.get(p.brand) || {
      brand: p.brand, revenue: 0, units: 0, onHand: 0, stockValue: 0,
      products: 0, reorder: 0, stockouts: 0, sizesOut: 0, atRisk: 0,
      leadTime: p.leadTime, rising: 0, fading: 0,
    };
    b.revenue += p.r28;
    b.units += p.u28;
    b.onHand += p.onHand;
    b.stockValue += p.stockValue;
    b.products += 1;
    b.atRisk += p.revenueAtRisk;
    b.sizesOut += p.sizesOut.length;
    if (p.status === "reorder") b.reorder += 1;
    if (p.status === "stockout") b.stockouts += 1;
    if (p.rising) b.rising += 1;
    if (p.fading) b.fading += 1;
    byBrand.set(p.brand, b);
  }

  const list = [...byBrand.values()].map(b => {
    const rateOfSale = b.units / weeks;
    const sellThrough = (b.units + b.onHand) > 0 ? b.units / (b.units + b.onHand) : 0;
    return {
      ...b,
      avgPrice: b.units > 0 ? Math.round(b.revenue / b.units) : 0,
      rateOfSale: round(rateOfSale, 1),
      weeksCover: rateOfSale > 0 ? round(b.onHand / rateOfSale, 1) : null,
      sellThrough: round(sellThrough * 100, 0),
      // Annualised: how many times the money in this brand turns over a year.
      stockTurn: b.stockValue > 0 ? round((b.revenue / windowDays * 365) / b.stockValue, 1) : null,
    };
  });

  const totalRevenue = list.reduce((s, b) => s + b.revenue, 0) || 1;
  const totalUnits = list.reduce((s, b) => s + b.units, 0) || 1;

  const byValue = [...list].sort((a, b) => b.revenue - a.revenue);
  const byVolume = [...list].sort((a, b) => b.units - a.units);
  const valueRank = new Map(byValue.map((b, i) => [b.brand, i + 1]));
  const volumeRank = new Map(byVolume.map((b, i) => [b.brand, i + 1]));

  // ABC on the value ranking — the running share of revenue.
  let running = 0;
  const abc = new Map();
  for (const b of byValue) {
    running += b.revenue / totalRevenue;
    abc.set(b.brand, running <= 0.8 ? "A" : running <= 0.95 ? "B" : "C");
  }

  for (const b of list) {
    b.revenueShare = round((b.revenue / totalRevenue) * 100, 1);
    b.unitShare = round((b.units / totalUnits) * 100, 1);
    b.valueRank = valueRank.get(b.brand);
    b.volumeRank = volumeRank.get(b.brand);
    b.rankGap = b.valueRank - b.volumeRank;   // + = sells in volume, not value
    b.abc = abc.get(b.brand);
    // Named only where the divergence is big enough to act on.
    b.character =
      b.rankGap >= 3 ? "volume driver"
      : b.rankGap <= -3 ? "high ticket"
      : null;
  }

  return {
    windowDays,
    byValue: [...list].sort((a, b) => b.revenue - a.revenue),
    byVolume: [...list].sort((a, b) => b.units - a.units),
    totals: {
      revenue: totalRevenue, units: totalUnits,
      brands: list.length,
      stockValue: list.reduce((s, b) => s + b.stockValue, 0),
      sellThrough: round(
        (totalUnits / (totalUnits + list.reduce((s, b) => s + b.onHand, 0) || 1)) * 100, 0),
      // How concentrated the shop is: share of revenue from the top three.
      top3Share: round(
        (byValue.slice(0, 3).reduce((s, b) => s + b.revenue, 0) / totalRevenue) * 100, 0),
    },
  };
}

async function build(ctx) {
  const { token, locationIds, tz, index, currency } = ctx;
  const now = new Date();
  const today = T.localDay(tz, now);

  const all = [...index.variations.values()];
  const tracked = all.filter(v => v.tracked);

  if (!tracked.length) {
    return {
      ok: true, tracking: false, currency,
      catalogueSize: all.length,
      note: all.length
        ? `Inventory tracking isn't switched on for any of the ${all.length} variations on this account. `
          + `Turn it on in Square under Items → Inventory, or bulk-enable it from the Items list. `
          + `Everything on this tab needs it.`
        : "There are no catalogue items on this account yet.",
    };
  }

  const counts = await inventoryCounts(token, tracked.map(v => v.id), locationIds);

  const w7  = sales.unitsByVariation(tz, T.midnight(tz, 6), now);
  const w14 = sales.unitsByVariation(tz, T.midnight(tz, 13), now);
  const w28 = sales.unitsByVariation(tz, T.midnight(tz, 27), now);
  const w56 = sales.unitsByVariation(tz, T.midnight(tz, 55), now);
  const life = sales.lifespanByVariation();
  const table = leadTimes();
  const orders = openOrderIndex();

  const vctx = { counts, w7, w14, w28, w56, life, table, orders, today };
  const rows = tracked.map(v => analyseVariation(v, vctx));

  const products = [];
  for (const p of index.products.values()) {
    const r = rollUp(p, rows);
    if (r) products.push(r);
  }

  const byStatus = s => products.filter(p => p.status === s);

  // Ranked by what the gap costs, not by how few are left.
  const reorder = [...byStatus("reorder"), ...byStatus("stockout")]
    .sort((a, b) => b.revenueAtRisk - a.revenueAtRisk || b.velocity - a.velocity);

  const stockouts = byStatus("stockout").sort((a, b) => b.velocity - a.velocity);
  const watch = byStatus("watch").sort((a, b) => (a.daysCover ?? 1e9) - (b.daysCover ?? 1e9));
  const ordered = byStatus("ordered").sort((a, b) => (a.daysCover ?? 1e9) - (b.daysCover ?? 1e9));

  // Accelerating lines with cover still ahead of them — the ones worth
  // catching before they become the reorder list.
  const rising = products
    .filter(p => p.rising && p.status !== "stockout")
    .sort((a, b) => b.u7 - a.u7);

  // Only lines that are genuinely sitting still. Anything that still needs
  // reordering is not a markdown candidate, whatever its trend is doing.
  const markdown = products
    .filter(p => ["overstocked", "dead", "idle"].includes(p.status) && p.onHand > 0 && !p.isNew)
    .sort((a, b) => b.stockValue - a.stockValue);

  const broken = products.filter(p => p.brokenRun)
    .sort((a, b) => b.revenueAtRisk - a.revenueAtRisk);

  const newIn = products.filter(p => p.isNew).sort((a, b) => b.u7 - a.u7);

  const stockValue = rows.reduce((s, r) => s + r.stockValue, 0);

  // Lost sales are a size-level fact. A jacket is rarely out entirely —
  // it goes size by size, and each empty peg stops selling on its own.
  // Counting only products that are wholly out would report zero while
  // the best size of half the rail is missing.
  const emptyPegs = rows.filter(r => r.status === "stockout");
  const lostPerDay = emptyPegs.reduce((s, r) => s + r.velocity * r.price, 0);

  // Top sellers by units over four weeks — the "what's actually moving"
  // list the reorder view is derived from.
  const movers = [...products]
    .filter(p => p.u28 > 0)
    .sort((a, b) => b.r28 - a.r28)
    .slice(0, 25);

  const brands = brandSummary(products, 28);

  return {
    ok: true, tracking: true, currency,
    generatedAt: new Date().toISOString(),
    brands,
    settings: {
      safetyDays: SAFETY_DAYS,
      targetCoverDays: TARGET_COVER_DAYS,
      overstockDays: OVERSTOCK_DAYS,
      newProductDays: NEW_PRODUCT_DAYS,
      recencyWeight: RECENCY_WEIGHT,
      risingRatio: RISING_RATIO,
      leadTimes: table,
    },
    persistent: store.isPersistent(),
    summary: {
      products: products.length,
      variations: rows.length,
      untracked: all.length - rows.length,
      reorder: reorder.length,
      stockouts: stockouts.length,
      sizesOut: emptyPegs.length,
      watch: watch.length,
      ordered: ordered.length,
      broken: broken.length,
      stockValue,
      atRisk: reorder.reduce((s, p) => s + p.revenueAtRisk, 0),
      lostPerDay: Math.round(lostPerDay),
      unitsOnHand: rows.reduce((s, r) => s + r.onHand, 0),
      revenue28: brands.totals.revenue,
      units28: brands.totals.units,
      sellThrough: brands.totals.sellThrough,
      top3Share: brands.totals.top3Share,
      brandCount: brands.totals.brands,
    },
    reorder, stockouts, watch, ordered, rising, markdown, broken, newIn, movers,
    purchaseOrders: purchaseOrders().slice(0, 60),
  };
}

module.exports = {
  build, leadTimes, setLeadTime, leadTimeFor,
  purchaseOrders, raisePurchaseOrder, updatePurchaseOrder,
};
