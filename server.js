/**
 * HERD — the shop, on one screen.
 *
 * Trading, stock, team and diary for The Herd Store, read live from Square.
 * One environment variable holds the access token, one holds a password.
 * Nothing here writes to Square.
 *
 *   SQUARE_ACCESS_TOKEN   production access token for the HERD account
 *   DASHBOARD_PASS        password for the app
 *
 * Node 20+. No dependencies.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { square, permissionProblem, authProblem } = require("./lib/square");
const T = require("./lib/time");
const { catalogIndex, brandsFrom } = require("./lib/catalog");
const sales = require("./lib/sales");
const stock = require("./lib/stock");
const team = require("./lib/team");
const diary = require("./lib/diary");
const notify = require("./lib/notify");
const store = require("./lib/store");

const BUILD = "2026-08-25-herd-1";
const PORT = process.env.PORT || 3000;
const CACHE_MS = Number(process.env.CACHE_MS || 30000);
const STOCK_CACHE_MS = Number(process.env.STOCK_CACHE_MS || 300000);
const META_TTL = Number(process.env.META_TTL_MS || 600000);
const POLL_MS = Number(process.env.POLL_MS || 60000);

/* ── Configuration ──────────────────────────────────────────── */

const TOKEN = (process.env.SQUARE_ACCESS_TOKEN || process.env.SQUARE_TOKEN || "").trim();
const AUTH_USER = process.env.DASHBOARD_USER || "";
const AUTH_PASS = process.env.DASHBOARD_PASS || "";
const ALLOW_OPEN = process.env.ALLOW_OPEN === "1";
const LOCATION_NAME = process.env.SQUARE_LOCATION_NAME || "";
const OPENED_ON = process.env.OPENED_ON || "";      // YYYY-MM-DD, for "since opening"

function fail(msg) {
  console.error("\n[herd] " + msg + "\n");
  process.exit(1);
}

if (!TOKEN) {
  fail(
    "No Square access token.\n" +
    "  Set SQUARE_ACCESS_TOKEN to the HERD account's production token.\n" +
    "  developer.squareup.com/apps → your app → switch Sandbox to Production → Credentials."
  );
}
if (!AUTH_PASS && !ALLOW_OPEN) {
  fail(
    "Refusing to start without a password.\n" +
    "  This exposes live takings, staff pay and stock for the shop.\n" +
    "  Set DASHBOARD_PASS, or ALLOW_OPEN=1 for localhost only."
  );
}
if (ALLOW_OPEN) console.warn("[herd] Running without a password — localhost only.");

/* ── Access gate ─────────────────────────────────────────────
   iOS home-screen apps don't reliably keep Basic auth between
   launches, so one successful sign-in sets a signed cookie. */

const COOKIE = "herd_session";
const COOKIE_DAYS = Number(process.env.SESSION_DAYS || 30);

const sign = value =>
  crypto.createHmac("sha256", AUTH_PASS || "open").update(String(value)).digest("hex").slice(0, 32);

function makeSession() {
  const exp = Date.now() + COOKIE_DAYS * 864e5;
  return `${exp}.${sign(exp)}`;
}
function validSession(raw) {
  if (!raw) return false;
  const [exp, sig] = String(raw).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sign(exp) === sig;
}
function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const PUBLIC_PATHS = new Set(["/manifest.json", "/sw.js", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]);

function authorised(req, res) {
  if (ALLOW_OPEN) return true;

  const p = req.url.split("?")[0];
  // Browsers fetch the manifest anonymously; gating it breaks home-screen install.
  if (PUBLIC_PATHS.has(p) || p.startsWith("/assets/") || p.startsWith("/icons/")) return true;
  // Square signs its own deliveries; Basic auth would only get in the way.
  if (p === "/webhooks/square") return true;

  if (validSession(readCookie(req, COOKIE))) return true;

  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const [user, pass] = Buffer.from(header.slice(6), "base64").toString().split(":");
    const userOk = !AUTH_USER || safeEqual(user || "", AUTH_USER);
    if (userOk && AUTH_PASS && safeEqual(pass || "", AUTH_PASS)) {
      res.setHeader("Set-Cookie",
        `${COOKIE}=${makeSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}` +
        (process.env.NODE_ENV === "production" ? "; Secure" : ""));
      return true;
    }
  }

  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="HERD", charset="UTF-8"',
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("Sign in to continue.");
  return false;
}

/* ── Context ────────────────────────────────────────────────
   Merchant, location and catalogue change rarely and cost several
   calls, so they are read once and refreshed on a timer. */

let ctxCache = { at: 0, value: null, error: null };

async function context({ force = false } = {}) {
  if (!force && ctxCache.value && Date.now() - ctxCache.at < META_TTL) return ctxCache.value;
  if (!force && ctxCache.error && Date.now() - ctxCache.at < 15000) throw ctxCache.error;

  try {
    const [merchantRes, locationRes] = await Promise.all([
      square(TOKEN, "/merchants", {}),
      square(TOKEN, "/locations", {}),
    ]);

    const merchants = merchantRes.merchant || merchantRes.merchants || [];
    const merchant = Array.isArray(merchants) ? merchants[0] : merchants;

    let locations = (locationRes.locations || []).filter(l => l.status !== "INACTIVE");
    if (LOCATION_NAME) {
      const wanted = locations.filter(l =>
        l.name?.toLowerCase().includes(LOCATION_NAME.toLowerCase()));
      if (wanted.length) locations = wanted;
    }
    if (!locations.length) throw new Error("This Square account has no active locations.");

    const tz = locations[0].timezone || "Europe/London";
    const currency = locations[0].currency || "GBP";

    let index = { variations: new Map(), products: new Map(), categories: new Map() };
    let catalogueProblem = null;
    try {
      index = await catalogIndex(TOKEN);
    } catch (err) {
      catalogueProblem = permissionProblem(err)
        ? "This token can't read the catalogue — product and stock detail needs Items read access."
        : `Catalogue unavailable: ${err.message}`;
    }

    const value = {
      token: TOKEN,
      merchant,
      businessName: merchant?.business_name || locations[0].name || "HERD",
      locations,
      locationIds: locations.map(l => l.id),
      tz, currency, index, catalogueProblem,
      brands: brandsFrom(index.products),
      openedOn: OPENED_ON || null,
    };

    ctxCache = { at: Date.now(), value, error: null };
    return value;
  } catch (err) {
    ctxCache = { at: Date.now(), value: ctxCache.value, error: err };
    if (ctxCache.value) return ctxCache.value;   // keep serving the last good one
    throw err;
  }
}

/* ── Trading report ─────────────────────────────────────────── */

const pct = (now, before) => {
  if (!before) return now ? null : 0;
  return Math.round(((now - before) / before) * 1000) / 10;
};

function topLines(totals, index, limit = 20) {
  const rows = [];
  for (const [id, v] of totals.lines) {
    const meta = index.variations.get(id);
    rows.push({
      id,
      name: meta?.label || v.name,
      product: meta?.product || v.name,
      brand: meta?.brand || "",
      category: meta?.category || "Uncategorised",
      units: v.units,
      revenue: v.revenue,
      avg: v.units ? Math.round(v.revenue / v.units) : 0,
    });
  }
  for (const [name, v] of totals.unmatched) {
    rows.push({ id: null, name, product: name, brand: "", category: "Custom", units: v.units, revenue: v.revenue, avg: v.units ? Math.round(v.revenue / v.units) : 0 });
  }
  rows.sort((a, b) => b.revenue - a.revenue);
  const total = rows.reduce((s, r) => s + r.revenue, 0) || 1;
  return rows.slice(0, limit).map(r => ({ ...r, share: Math.round((r.revenue / total) * 1000) / 10 }));
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = r[key] || "Uncategorised";
    const cur = out.get(k) || { name: k, units: 0, revenue: 0 };
    cur.units += r.units; cur.revenue += r.revenue;
    out.set(k, cur);
  }
  return [...out.values()].sort((a, b) => b.revenue - a.revenue);
}

function movers(now, before, index) {
  const keys = new Set([...now.lines.keys(), ...before.lines.keys()]);
  const rows = [];
  for (const id of keys) {
    const a = now.lines.get(id)?.revenue || 0;
    const b = before.lines.get(id)?.revenue || 0;
    if (a + b < 2000) continue;                 // ignore noise under £20 combined
    const meta = index.variations.get(id);
    rows.push({
      id,
      name: meta?.label || now.lines.get(id)?.name || before.lines.get(id)?.name || "Item",
      brand: meta?.brand || "",
      now: a, before: b, delta: a - b, change: pct(a, b),
    });
  }
  rows.sort((a, b) => b.delta - a.delta);
  return { risers: rows.slice(0, 8), fallers: rows.slice(-8).reverse().filter(r => r.delta < 0) };
}

const asRows = m => [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => (b.net || 0) - (a.net || 0));

async function tradingReport(rangeKey) {
  const ctx = await context();
  const spec = T.rangeSpec(ctx.tz, rangeKey, ctx.openedOn || sales.firstTradingDay());

  const from = T.localDay(ctx.tz, spec.start);
  const to = T.localDay(ctx.tz, spec.end);
  await sales.ensureCoverage(TOKEN, ctx, from, to);

  const totals = sales.aggregate(ctx.tz, spec.start, spec.end);

  let previous = null;
  if (spec.prevStart) {
    await sales.ensureCoverage(TOKEN, ctx, T.localDay(ctx.tz, spec.prevStart), T.localDay(ctx.tz, spec.prevEnd));
    previous = sales.aggregate(ctx.tz, spec.prevStart, spec.prevEnd);
  }

  const lines = topLines(totals, ctx.index, 25);
  const atv = totals.orders ? Math.round(totals.net / totals.orders) : 0;
  const upt = totals.orders ? Math.round((totals.units / totals.orders) * 100) / 100 : 0;

  const prevAtv = previous?.orders ? Math.round(previous.net / previous.orders) : 0;
  const prevUpt = previous?.orders ? Math.round((previous.units / previous.orders) * 100) / 100 : 0;

  // Which weekday carries the week — worth knowing before setting a rota.
  const weekday = new Map();
  for (const point of totals.series) {
    const name = T.WEEKDAYS[T.weekdayIndex(point.day)];
    const cur = weekday.get(name) || { name, net: 0, days: 0, orders: 0 };
    cur.net += point.net; cur.orders += point.orders;
    if (point.net > 0 || point.orders > 0) cur.days += 1;
    weekday.set(name, cur);
  }
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    .map(name => {
      const w = weekday.get(name) || { name, net: 0, days: 0, orders: 0 };
      return { ...w, average: w.days ? Math.round(w.net / w.days) : 0 };
    });

  const peakHour = totals.hourly.reduce((best, v, h) => (v > totals.hourly[best] ? h : best), 0);
  const peakDay = totals.series.reduce((best, p) => (p.net > (best?.net || 0) ? p : best), null);

  return {
    ok: true,
    build: BUILD,
    business: ctx.businessName,
    currency: ctx.currency,
    timezone: ctx.tz,
    range: { key: rangeKey, label: spec.label, buckets: spec.buckets, comparison: spec.comparison, from, to },
    catalogueProblem: ctx.catalogueProblem,
    headline: {
      net: totals.net, gross: totals.gross, discounts: totals.discounts,
      orders: totals.orders, units: totals.units, tips: totals.tips,
      atv, upt,
      change: {
        net: previous ? pct(totals.net, previous.net) : null,
        orders: previous ? pct(totals.orders, previous.orders) : null,
        units: previous ? pct(totals.units, previous.units) : null,
        atv: previous ? pct(atv, prevAtv) : null,
        upt: previous ? pct(upt, prevUpt) : null,
      },
      previous: previous ? { net: previous.net, orders: previous.orders, units: previous.units, atv: prevAtv, upt: prevUpt } : null,
    },
    series: totals.series,
    hourly: totals.hourly.map((net, hour) => ({ hour, net, orders: totals.hourlyOrders[hour] })),
    weekdays,
    peak: { hour: peakHour, day: peakDay?.day || null, dayNet: peakDay?.net || 0 },
    lines,
    brands: groupBy(lines, "brand").slice(0, 12),
    categories: groupBy(lines, "category").slice(0, 12),
    movers: previous ? movers(totals, previous, ctx.index) : { risers: [], fallers: [] },
    tenders: asRows(totals.tenders),
    cards: asRows(totals.brands),
    entries: asRows(totals.entries),
    sources: asRows(totals.sources),
    tape: totals.tape,
    firstTradingDay: sales.firstTradingDay(),
    daysCached: sales.dayCount(),
  };
}

/* ── Caches ─────────────────────────────────────────────────── */

const cache = new Map();

async function cached(key, ttl, build) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  if (hit?.building) return hit.building;

  const building = build()
    .then(value => { cache.set(key, { at: Date.now(), value }); return value; })
    .catch(err => { cache.delete(key); throw err; });

  cache.set(key, { ...(hit || {}), building });
  return building;
}

async function stockReport() {
  return cached("stock", STOCK_CACHE_MS, async () => {
    const ctx = await context();
    if (ctx.catalogueProblem) return { ok: true, tracking: false, note: ctx.catalogueProblem, currency: ctx.currency };
    // The engine reads velocity from cached days, so make sure eight weeks
    // are in memory before it asks.
    const to = T.localDay(ctx.tz, new Date());
    await sales.ensureCoverage(TOKEN, ctx, T.localDay(ctx.tz, T.midnight(ctx.tz, 56)), to);
    const report = await stock.build(ctx);
    checkReorderAlerts(report, ctx).catch(() => {});
    return report;
  });
}

async function teamReport(rangeKey) {
  return cached(`team:${rangeKey}`, CACHE_MS, async () => {
    const ctx = await context();
    const spec = T.rangeSpec(ctx.tz, rangeKey, ctx.openedOn);
    await sales.ensureCoverage(TOKEN, ctx, T.localDay(ctx.tz, spec.start), T.localDay(ctx.tz, spec.end));
    const totals = sales.aggregate(ctx.tz, spec.start, spec.end);
    const report = await team.build(ctx, spec, totals);
    return { ...report, range: { key: rangeKey, label: spec.label }, business: ctx.businessName };
  });
}

async function diaryReport(fromDay, toDay) {
  const ctx = await context();
  const t = await teamReport("week").catch(() => ({ upcoming: [] }));
  return diary.build({ tz: ctx.tz, fromDay, toDay, rota: t.upcoming || [] });
}

/* ── Alerts ─────────────────────────────────────────────────── */

async function checkReorderAlerts(report, ctx) {
  if (!report?.tracking) return;
  const urgent = [...(report.stockouts || []), ...(report.reorder || [])]
    .filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i)
    .slice(0, 20);
  await notify.announceReorders(urgent, ctx.currency);
}

/* Poller — the fallback when no Square webhook is configured. Also runs
   alongside one as a safety net for deliveries Square never retries. */

let lastSeenAt = null;

async function pollSales() {
  try {
    const ctx = await context();
    const now = new Date();
    const today = T.localDay(ctx.tz, now);
    await sales.ensureCoverage(TOKEN, ctx, today, today);

    const day = sales.daySummary(today);
    if (!day) return;

    const fresh = day.tape.filter(t => !lastSeenAt || new Date(t.at) > new Date(lastSeenAt));
    if (fresh.length) lastSeenAt = fresh[0].at;
    else if (!lastSeenAt && day.tape[0]) lastSeenAt = day.tape[0].at;

    for (const sale of fresh.slice(0, 5).reverse()) {
      await notify.announceSale({
        id: sale.id,
        amount: sale.net,
        currency: ctx.currency,
        items: sale.items,
        tender: [sale.brand, sale.tender].filter(Boolean).join(" "),
        staff: null,
        dayTotal: day.net,
        dayOrders: day.orders,
      });
    }

    await notify.announceMilestone({ dayTotal: day.net, currency: ctx.currency, target: notify.DAILY_TARGET });
  } catch (err) {
    if (authProblem(err)) console.warn("[herd] poller stopped: token rejected by Square");
    else console.warn(`[herd] poller: ${err.message}`);
  }
}

async function dailySummary() {
  try {
    const ctx = await context();
    const now = new Date();
    const p = T.parts(ctx.tz, now);
    if (p.hour !== notify.CLOSE_HOUR) return;

    const today = T.localDay(ctx.tz, now);
    await sales.ensureCoverage(TOKEN, ctx, today, today);
    const day = sales.daySummary(today);
    if (!day || !day.orders) return;

    const report = await tradingReport("today").catch(() => null);
    const st = await stockReport().catch(() => null);
    const best = report?.lines?.[0]?.name || null;

    await notify.announceDailySummary({
      day: today,
      dayLabel: `${p.weekday} ${p.day}/${String(p.month).padStart(2, "0")}`,
      net: day.net, orders: day.orders, units: day.units,
      atv: day.orders ? Math.round(day.net / day.orders) : 0,
      currency: ctx.currency,
      best,
      reorderCount: st?.summary?.reorder || 0,
      vs: report?.headline?.change?.net ?? null,
    });
  } catch (err) {
    console.warn(`[herd] daily summary: ${err.message}`);
  }
}

/* ── HTTP ───────────────────────────────────────────────────── */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

const PUBLIC_DIR = path.join(__dirname, "public");

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(data);
  });
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > limit) { reject(new Error("Body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function describeError(err) {
  if (authProblem(err)) {
    return { status: 502, body: { ok: false, error: "square_auth", message: "Square rejected the access token. It may have been revoked or regenerated — set a fresh SQUARE_ACCESS_TOKEN." } };
  }
  if (permissionProblem(err)) {
    return { status: 502, body: { ok: false, error: "square_scope", message: `This token is missing a permission: ${err.message}` } };
  }
  if (err.code === "NETWORK") {
    return { status: 504, body: { ok: false, error: "network", message: err.message } };
  }
  return { status: err.status && err.status < 500 ? err.status : 500, body: { ok: false, error: "server", message: err.message } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  try {
    /* Square's webhook, verified by signature rather than by password. */
    if (p === "/webhooks/square" && req.method === "POST") {
      const raw = await readBody(req);
      if (!notify.verifySquareSignature(raw, req.headers["x-square-hmacsha256-signature"])) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");

      // Answer Square first, then do the work — a slow notification must
      // never make Square think the delivery failed.
      setImmediate(async () => {
        try {
          const event = JSON.parse(raw);
          const type = event.type || "";
          if (!/payment|order/.test(type)) return;
          cache.delete("stock");
          await pollSales();
        } catch (err) {
          console.warn(`[herd] webhook: ${err.message}`);
        }
      });
      return;
    }

    if (!authorised(req, res)) return;

    if (p === "/api/health") {
      const ctx = await context().catch(() => null);
      return sendJSON(res, 200, {
        ok: true, build: BUILD,
        business: ctx?.businessName || null,
        locations: ctx?.locations?.map(l => ({ id: l.id, name: l.name })) || [],
        timezone: ctx?.tz || null,
        catalogue: ctx ? ctx.index.products.size : 0,
        brands: ctx?.brands?.length || 0,
        daysCached: sales.dayCount(),
        firstTradingDay: sales.firstTradingDay(),
        storage: { persistent: store.isPersistent(), path: store.location() },
        notifications: notify.status(),
        uptime: Math.round(process.uptime()),
      });
    }

    if (p === "/api/overview") {
      const range = url.searchParams.get("range") || "today";
      const report = await cached(`trading:${range}`, CACHE_MS, () => tradingReport(range));
      return sendJSON(res, 200, report);
    }

    if (p === "/api/stock" && req.method === "GET") {
      if (url.searchParams.get("refresh") === "1") cache.delete("stock");
      return sendJSON(res, 200, await stockReport());
    }

    if (p === "/api/stock/lead-time" && req.method === "POST") {
      const { brand, days } = JSON.parse(await readBody(req) || "{}");
      if (!brand) return sendJSON(res, 400, { ok: false, message: "brand is required" });
      const table = stock.setLeadTime(brand, days);
      cache.delete("stock");
      return sendJSON(res, 200, { ok: true, leadTimes: table });
    }

    if (p === "/api/stock/purchase-order" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const po = stock.raisePurchaseOrder(body);
      cache.delete("stock");
      return sendJSON(res, 200, { ok: true, purchaseOrder: po });
    }

    if (p.startsWith("/api/stock/purchase-order/") && (req.method === "PATCH" || req.method === "DELETE")) {
      const poId = decodeURIComponent(p.split("/").pop());
      const patch = req.method === "DELETE"
        ? { status: "cancelled" }
        : JSON.parse(await readBody(req) || "{}");
      const po = stock.updatePurchaseOrder(poId, patch);
      cache.delete("stock");
      return sendJSON(res, po ? 200 : 404, po ? { ok: true, purchaseOrder: po } : { ok: false, message: "Not found" });
    }

    if (p === "/api/team") {
      const range = url.searchParams.get("range") || "week";
      return sendJSON(res, 200, await teamReport(range));
    }

    if (p === "/api/diary" && req.method === "GET") {
      const ctx = await context();
      const today = T.localDay(ctx.tz, new Date());
      const from = url.searchParams.get("from") || T.weekStart(today);
      const to = url.searchParams.get("to") || T.addDays(from, 27);
      return sendJSON(res, 200, await diaryReport(from, to));
    }

    if (p === "/api/diary" && req.method === "POST") {
      const entry = diary.addEntry(JSON.parse(await readBody(req) || "{}"));
      return sendJSON(res, 200, { ok: true, entry });
    }

    if (p.startsWith("/api/diary/") && (req.method === "PATCH" || req.method === "DELETE")) {
      const entryId = decodeURIComponent(p.split("/").pop());
      if (req.method === "DELETE") {
        return sendJSON(res, 200, { ok: diary.removeEntry(entryId) });
      }
      const entry = diary.updateEntry(entryId, JSON.parse(await readBody(req) || "{}"));
      return sendJSON(res, entry ? 200 : 404, entry ? { ok: true, entry } : { ok: false, message: "Not found" });
    }

    if (p === "/api/alerts") {
      return sendJSON(res, 200, { ok: true, status: notify.status(), feed: notify.recent(40) });
    }

    if (p === "/api/alerts/test" && req.method === "POST") {
      const sent = await notify.send({
        title: "HERD test alert",
        body: "If this reached your phone, notifications are wired up correctly.",
        priority: "normal", tags: ["white_check_mark"],
      });
      return sendJSON(res, 200, { ok: true, sent, channels: notify.channels() });
    }

    if (p === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ build: BUILD })}\n\n`);
      const beat = setInterval(() => res.write(": keep-alive\n\n"), 25000);
      const off = notify.subscribe(record => {
        res.write(`event: alert\ndata: ${JSON.stringify(record)}\n\n`);
      });
      req.on("close", () => { clearInterval(beat); off(); });
      return;
    }

    if (p.startsWith("/api/")) return sendJSON(res, 404, { ok: false, message: "No such endpoint" });

    return serveStatic(req, res, p);
  } catch (err) {
    const { status, body } = describeError(err);
    if (p.startsWith("/api/")) return sendJSON(res, status, body);
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(body.message);
  }
});

/* ── Boot ───────────────────────────────────────────────────── */

server.listen(PORT, async () => {
  console.log(`[herd] ${BUILD} listening on :${PORT}`);
  console.log(`[herd] storage ${store.isPersistent() ? "persistent at " + store.location() : "IN MEMORY — attach a disk to keep lead times, purchase orders and the diary"}`);

  const on = notify.channels();
  console.log(`[herd] notifications: ${on.length ? on.join(", ") : "none configured (in-app feed only)"}`
    + (notify.webhookReady() ? ", Square webhook verified" : ", polling every " + Math.round(POLL_MS / 1000) + "s"));

  try {
    const ctx = await context({ force: true });
    console.log(`[herd] ${ctx.businessName} — ${ctx.locations.map(l => l.name).join(", ")} (${ctx.tz}, ${ctx.currency})`);
    console.log(`[herd] catalogue: ${ctx.index.products.size} products, ${ctx.index.variations.size} variations, ${ctx.brands.length} brands`);
    if (ctx.catalogueProblem) console.warn(`[herd] ${ctx.catalogueProblem}`);

    // Warm eight weeks in the background so the first Stock view is instant.
    const to = T.localDay(ctx.tz, new Date());
    sales.ensureCoverage(TOKEN, ctx, T.localDay(ctx.tz, T.midnight(ctx.tz, 56)), to)
      .then(() => console.log(`[herd] warmed ${sales.dayCount()} days of trading history`))
      .catch(err => console.warn(`[herd] warm-up: ${err.message}`));
  } catch (err) {
    console.error(`[herd] could not reach Square: ${err.message}`);
    if (authProblem(err)) console.error("[herd] the access token was rejected — check SQUARE_ACCESS_TOKEN is a production token for the HERD account.");
  }

  setInterval(pollSales, POLL_MS);
  setInterval(dailySummary, 300000);
});

process.on("unhandledRejection", err => console.warn(`[herd] unhandled: ${err?.message || err}`));
