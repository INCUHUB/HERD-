/**
 * A stand-in for Square, so the app can be run and inspected without a
 * token — and so the reorder engine can be tested against a catalogue
 * whose behaviour is known in advance.
 *
 * The data is invented. It is shaped like a small menswear shop: a few
 * brands, size runs, a couple of lines deliberately accelerating, one
 * deliberately dead, and one whose best size has just sold out.
 *
 *   node tools/mock-square.js          # serve on :4000
 *   npm run demo                       # serve + start the app against it
 */

const http = require("http");

const PORT = Number(process.env.MOCK_PORT || 4000);
const LOCATION = "LHERD0000001";
const MERCHANT = "MHERD0000001";

const iso = d => d.toISOString();
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const at = (n, hour, min = 0) => { const d = daysAgo(n); d.setHours(hour, min, 0, 0); return d; };

/* Deterministic pseudo-random, so two runs produce the same shop. */
let seed = 20260825;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = arr => arr[Math.floor(rnd() * arr.length)];

/* ── Catalogue ─────────────────────────────────────────────── */

const CATEGORIES = [
  { id: "CAT_KAPITAL", name: "Kapital" },
  { id: "CAT_MERRELL", name: "Merrell" },
  { id: "CAT_7115",    name: "7115 by Szeki" },
  { id: "CAT_ENDS",    name: "Ends and Means" },
  { id: "CAT_NIKSEN",  name: "Estudio Niksen" },
  { id: "CAT_SCRT",    name: "SCRT" },
  { id: "CAT_SERVICE", name: "Service Works" },
  { id: "CAT_HOME",    name: "Home & Objects" },
];

const APPAREL = ["S", "M", "L", "XL"];
const FOOTWEAR = ["7", "8", "9", "10", "11"];
const ONE = [""];

/* rate = units per day at full tilt; the generator uses it to lay down
   plausible sales, and the engine should rediscover it as velocity. */
const PRODUCTS = [
  ["Century Denim Chore Jacket",  "CAT_KAPITAL", 32500, APPAREL,  0.35, "steady"],
  ["Boro Patchwork Scarf",        "CAT_KAPITAL", 14500, ONE,      0.20, "steady"],
  ["Ripstop Cargo Trouser",       "CAT_KAPITAL", 21000, APPAREL,  0.55, "rising"],
  ["Moab Speed Low GTX",          "CAT_MERRELL", 13500, FOOTWEAR, 0.75, "rising"],
  ["Wrapt Mid",                   "CAT_MERRELL", 15500, FOOTWEAR, 0.30, "steady"],
  ["Hiking Sock Two Pack",        "CAT_MERRELL",  2200, ONE,      0.90, "steady"],
  ["Cotton Twill Work Shirt",     "CAT_7115",    12500, APPAREL,  0.45, "steady"],
  ["Merino Rib Knit",             "CAT_7115",    16500, APPAREL,  0.25, "rising"],
  ["Wide Leg Linen Trouser",      "CAT_7115",    14000, APPAREL,  0.10, "fading"],
  ["Garment Dyed Tee",            "CAT_ENDS",     5500, APPAREL,  1.20, "steady"],
  ["Fisherman Cardigan",          "CAT_ENDS",    18500, APPAREL,  0.18, "steady"],
  ["Ceramic Mug",                 "CAT_NIKSEN",   3400, ONE,      0.40, "steady"],
  ["Woven Table Runner",          "CAT_NIKSEN",   6800, ONE,      0.05, "dead"],
  ["Logo Beanie",                 "CAT_SCRT",     3200, ONE,      0.85, "rising"],
  ["Corduroy Cap",                "CAT_SCRT",     3800, ONE,      0.35, "steady"],
  ["Classic Coverall",            "CAT_SERVICE", 17500, APPAREL,  0.50, "steady"],
  ["Canvas Waist Apron",          "CAT_SERVICE",  6500, ONE,      0.12, "fading"],
  ["Stoneware Candle",            "CAT_HOME",     4200, ONE,      0.30, "steady"],
  ["Linen Tea Towel",             "CAT_HOME",     1800, ONE,      0.06, "dead"],
];

const catalogue = [];
const variations = [];

for (const [name, cat, price, sizes, rate, mode] of PRODUCTS) {
  const itemId = "ITEM_" + name.replace(/[^A-Za-z0-9]/g, "").slice(0, 18).toUpperCase();
  const vs = sizes.map((size, i) => {
    const id = `VAR_${itemId.slice(5)}_${i}`;
    const rec = { id, itemId, name, size, price, cat, rate: rate / sizes.length, mode };
    variations.push(rec);
    return {
      type: "ITEM_VARIATION", id, is_deleted: false,
      created_at: iso(daysAgo(mode === "rising" && i === 0 ? 16 : 70)),
      item_variation_data: {
        item_id: itemId, name: size || "Regular",
        sku: id.toLowerCase(), pricing_type: "FIXED_PRICING",
        price_money: { amount: price, currency: "GBP" },
        track_inventory: true, sellable: true, stockable: true,
      },
    };
  });

  catalogue.push({
    type: "ITEM", id: itemId, is_deleted: false,
    created_at: iso(daysAgo(70)), updated_at: iso(daysAgo(3)),
    item_data: {
      name, product_type: "REGULAR", is_archived: false,
      reporting_category: { id: cat },
      categories: [{ id: cat }],
      variations: vs,
    },
  });
}

for (const c of CATEGORIES) {
  catalogue.push({
    type: "CATEGORY", id: c.id, is_deleted: false,
    category_data: { name: c.name, category_type: "REGULAR_CATEGORY", is_top_level: true },
  });
}

/* ── Stock on hand ─────────────────────────────────────────── */

const stock = new Map();
for (const v of variations) {
  let qty;
  if (v.mode === "dead") qty = 8 + Math.floor(rnd() * 6);
  else if (v.mode === "rising") qty = Math.floor(rnd() * 3);         // about to run out
  else if (v.mode === "fading") qty = 6 + Math.floor(rnd() * 5);
  else qty = 2 + Math.floor(rnd() * 9);
  stock.set(v.id, qty);
}
// One deliberately broken run: the best size of the chore jacket is gone.
for (const v of variations) {
  if (v.name === "Century Denim Chore Jacket" && v.size === "M") stock.set(v.id, 0);
  if (v.name === "Moab Speed Low GTX" && (v.size === "9" || v.size === "10")) stock.set(v.id, 0);
}

/* ── Team ──────────────────────────────────────────────────── */

const TEAM = [
  { id: "TM_JAMES", given_name: "James",  family_name: "Dempsey",  job: "Owner",       rate: 0,    owner: true },
  { id: "TM_ROSA",  given_name: "Rosa",   family_name: "Whitlock", job: "Store Manager", rate: 1450 },
  { id: "TM_ELLIE", given_name: "Ellie",  family_name: "Nkemdirim",job: "Sales Assistant", rate: 1210 },
  { id: "TM_SAM",   given_name: "Sam",    family_name: "Iqbal",    job: "Sales Assistant", rate: 1210 },
];

/* ── Orders ────────────────────────────────────────────────── */

const orders = [];
const OPEN = 9, CLOSE = 18;

for (let back = 55; back >= 0; back--) {
  const weekday = daysAgo(back).getDay();
  if (weekday === 1) continue;                       // closed Mondays
  const busy = weekday === 6 ? 1.8 : weekday === 0 ? 1.2 : 1;

  for (const v of variations) {
    let rate = v.rate * busy;
    if (v.mode === "rising") rate *= back <= 7 ? 2.6 : back <= 21 ? 1.2 : 0.5;
    if (v.mode === "fading") rate *= back <= 14 ? 0.25 : 1.3;
    if (v.mode === "dead")   rate *= back <= 30 ? 0 : 0.5;

    const units = rnd() < rate ? 1 : 0;
    if (!units) continue;

    const hour = OPEN + Math.floor(rnd() * (CLOSE - OPEN));
    const when = at(back, hour, Math.floor(rnd() * 60));
    const staff = pick(TEAM.slice(1));
    const brand = pick(["VISA", "MASTERCARD", "AMEX"]);

    // Roughly a third of baskets pick up a second item.
    const extras = rnd() < 0.32 ? [pick(variations)] : [];
    const lines = [v, ...extras].map((x, i) => ({
      uid: `li_${orders.length}_${i}`,
      catalog_object_id: x.id,
      quantity: "1",
      name: x.name,
      variation_name: x.size || "Regular",
      base_price_money: { amount: x.price, currency: "GBP" },
      gross_sales_money: { amount: x.price, currency: "GBP" },
      total_discount_money: { amount: 0, currency: "GBP" },
      total_tax_money: { amount: 0, currency: "GBP" },
      total_money: { amount: x.price, currency: "GBP" },
      item_type: "ITEM",
    }));

    const total = lines.reduce((s, l) => s + l.total_money.amount, 0);

    orders.push({
      id: `ord_${orders.length}`,
      location_id: LOCATION,
      line_items: lines,
      created_at: iso(when), updated_at: iso(when), closed_at: iso(when),
      state: "COMPLETED",
      total_money: { amount: total, currency: "GBP" },
      total_discount_money: { amount: 0, currency: "GBP" },
      total_tax_money: { amount: 0, currency: "GBP" },
      total_tip_money: { amount: 0, currency: "GBP" },
      net_amounts: { total_money: { amount: total, currency: "GBP" } },
      tenders: [{
        id: `tn_${orders.length}`, type: "CARD",
        amount_money: { amount: total, currency: "GBP" },
        card_details: { status: "CAPTURED", entry_method: rnd() < 0.8 ? "CONTACTLESS" : "EMV", card: { card_brand: brand, last_4: String(1000 + Math.floor(rnd() * 8999)) } },
      }],
      source: { name: rnd() < 0.12 ? "Square Online" : "Point of Sale" },
      created_by_team_member_id: staff.id,
    });
  }
}
orders.sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at));

/* ── Timecards and rota ────────────────────────────────────── */

const timecards = [];
for (let back = 30; back >= 0; back--) {
  const weekday = daysAgo(back).getDay();
  if (weekday === 1) continue;
  const on = weekday === 6 ? TEAM.slice(1) : TEAM.slice(1, 3);
  for (const person of on) {
    timecards.push({
      id: `tc_${back}_${person.id}`, location_id: LOCATION, timezone: "Europe/London",
      start_at: iso(at(back, 9, 30)), end_at: iso(at(back, 18, 15)),
      wage: { title: person.job, hourly_rate: { amount: person.rate, currency: "GBP" } },
      status: "CLOSED", team_member_id: person.id,
    });
  }
}

const rota = [];
for (let ahead = 0; ahead <= 14; ahead++) {
  const d = daysAgo(-ahead);
  if (d.getDay() === 1) continue;
  const on = d.getDay() === 6 ? TEAM.slice(1) : TEAM.slice(1, 3);
  for (const person of on) {
    const start = new Date(d); start.setHours(9, 30, 0, 0);
    const end = new Date(d); end.setHours(18, 15, 0, 0);
    const details = {
      team_member_id: person.id, location_id: LOCATION, job_id: "job_" + person.id,
      start_at: iso(start), end_at: iso(end), is_deleted: false, timezone: "Europe/London",
    };
    rota.push({
      id: `ss_${ahead}_${person.id}`,
      draft_shift_details: details,
      published_shift_details: ahead <= 7 ? details : undefined,
    });
  }
}

/* ── Server ────────────────────────────────────────────────── */

const page = (items, cursor, field) => {
  const body = { [field]: items };
  if (cursor) body.cursor = cursor;
  return body;
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://mock");
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const send = obj => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const p = url.pathname.replace(/^\/v2/, "");

    if (p === "/merchants") {
      return send({ merchant: [{ id: MERCHANT, business_name: "HERD", country: "GB", currency: "GBP", main_location_id: LOCATION, status: "ACTIVE" }] });
    }

    if (p === "/locations") {
      return send({ locations: [{
        id: LOCATION, name: "HERD", status: "ACTIVE", timezone: "Europe/London", currency: "GBP",
        address: { address_line_1: "11 Lower Hillgate", locality: "Stockport", postal_code: "SK1 1JQ", country: "GB" },
        merchant_id: MERCHANT, type: "PHYSICAL",
      }] });
    }

    if (p === "/catalog/list") {
      const types = (url.searchParams.get("types") || "").split(",");
      return send({ objects: catalogue.filter(o => types.includes(o.type)) });
    }

    if (p === "/orders/search") {
      const f = body.query?.filter?.date_time_filter?.closed_at || {};
      const from = f.start_at ? new Date(f.start_at) : new Date(0);
      const to = f.end_at ? new Date(f.end_at) : new Date();
      const hits = orders.filter(o => {
        const t = new Date(o.closed_at);
        return t >= from && t <= to;
      });
      const offset = Number(body.cursor || 0);
      const limit = Number(body.limit || 500);
      const slice = hits.slice(offset, offset + limit);
      const next = offset + limit < hits.length ? String(offset + limit) : null;
      return send(page(slice, next, "orders"));
    }

    if (p === "/inventory/counts/batch-retrieve") {
      const ids = body.catalog_object_ids || [...stock.keys()];
      return send({ counts: ids.filter(id => stock.has(id)).map(id => ({
        catalog_object_id: id, catalog_object_type: "ITEM_VARIATION",
        state: "IN_STOCK", location_id: LOCATION,
        quantity: String(stock.get(id)), calculated_at: iso(new Date()),
      })) });
    }

    if (p === "/team-members/search") {
      return send({ team_members: TEAM.map(t => ({
        id: t.id, status: "ACTIVE", is_owner: Boolean(t.owner),
        given_name: t.given_name, family_name: t.family_name,
        assigned_locations: { assignment_type: "EXPLICIT_LOCATIONS", location_ids: [LOCATION] },
        merchant_id: MERCHANT,
        wage_setting: { job_assignments: [{ job_title: t.job, pay_type: "HOURLY", hourly_rate: { amount: t.rate, currency: "GBP" }, job_id: "job_" + t.id }] },
      })) });
    }

    if (p === "/labor/timecards/search") {
      const w = body.query?.filter?.start || {};
      const from = w.start_at ? new Date(w.start_at) : new Date(0);
      const to = w.end_at ? new Date(w.end_at) : new Date();
      return send({ timecards: timecards.filter(t => {
        const s = new Date(t.start_at);
        return s >= from && s <= to;
      }) });
    }
    if (p === "/labor/scheduled-shifts/search") return send({ scheduled_shifts: rota });

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errors: [{ code: "NOT_FOUND", detail: `mock has no ${p}` }] }));
  });
});

server.listen(PORT, () => {
  console.log(`[mock-square] on :${PORT} — ${PRODUCTS.length} products, ${variations.length} variations, ${orders.length} orders over 8 weeks`);
});

module.exports = { PORT };
