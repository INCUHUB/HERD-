/**
 * Notifications.
 *
 * Two ways in, one way out.
 *
 *   Webhook   Square posts to /webhooks/square the moment a payment lands.
 *             Signed, verified, and near-instant. This is the good path.
 *   Poller    If no webhook is configured, orders are polled instead.
 *             Slower and chattier, but needs nothing set up in Square.
 *
 * Out is a channel of your choosing — ntfy, Pushover, Telegram, or any
 * URL you can point at. All of them are optional; with none configured
 * the alerts still appear in the app's own feed and in the logs.
 */

const crypto = require("crypto");
const store = require("./store");
const T = require("./time");

const NTFY_TOPIC  = process.env.NTFY_TOPIC || "";
const NTFY_SERVER = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || "";
const PUSHOVER_USER  = process.env.PUSHOVER_USER || "";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID || "";
const WEBHOOK_URL    = process.env.NOTIFY_WEBHOOK_URL || "";

const ALERT_SALES     = process.env.ALERT_SALES !== "0";
const ALERT_REORDER   = process.env.ALERT_REORDER !== "0";
const ALERT_DAILY     = process.env.ALERT_DAILY !== "0";
const ALERT_MILESTONE = process.env.ALERT_MILESTONE !== "0";

/* Below this, a sale isn't worth a buzz. Set to 0 to hear about all of them. */
const SALE_FLOOR = Number(process.env.ALERT_SALE_FLOOR || 0);
const DAILY_TARGET = Number(process.env.DAILY_TARGET || 0);   // minor units
const CLOSE_HOUR = Number(process.env.CLOSE_SUMMARY_HOUR || 18);

const FEED_LIMIT = 100;
const feed = [];              // in-memory, shown in the app
const listeners = new Set();  // SSE clients

function channels() {
  const on = [];
  if (NTFY_TOPIC) on.push("ntfy");
  if (PUSHOVER_TOKEN && PUSHOVER_USER) on.push("pushover");
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT) on.push("telegram");
  if (WEBHOOK_URL) on.push("webhook");
  return on;
}

const money = (amount, currency = "GBP") =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: amount % 100 ? 2 : 0 })
    .format((amount || 0) / 100);

async function post(url, options) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
    if (!res.ok) console.warn(`[herd] notify ${new URL(url).host} -> HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    console.warn(`[herd] notify failed: ${err.message}`);
    return false;
  }
}

/**
 * Send one notification everywhere that's configured.
 * priority: "low" | "normal" | "high"
 */
async function send({ title, body, priority = "normal", tags = [], url }) {
  const record = { at: new Date().toISOString(), title, body, priority, tags };
  feed.unshift(record);
  feed.length = Math.min(feed.length, FEED_LIMIT);
  for (const fn of listeners) { try { fn(record); } catch {} }

  const on = channels();
  if (!on.length) {
    console.log(`[herd] ${title} — ${body}`);
    return record;
  }

  const jobs = [];

  if (NTFY_TOPIC) {
    jobs.push(post(`${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: "POST",
      headers: {
        Title: title,
        Priority: priority === "high" ? "high" : priority === "low" ? "low" : "default",
        Tags: tags.join(","),
        ...(url ? { Click: url } : {}),
      },
      body,
    }));
  }

  if (PUSHOVER_TOKEN && PUSHOVER_USER) {
    jobs.push(post("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: PUSHOVER_TOKEN, user: PUSHOVER_USER,
        title, message: body,
        priority: priority === "high" ? "1" : priority === "low" ? "-1" : "0",
        ...(url ? { url } : {}),
      }).toString(),
    }));
  }

  if (TELEGRAM_TOKEN && TELEGRAM_CHAT) {
    jobs.push(post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT,
        text: `*${title}*\n${body}`,
        parse_mode: "Markdown",
        disable_notification: priority === "low",
      }),
    }));
  }

  if (WEBHOOK_URL) {
    jobs.push(post(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    }));
  }

  await Promise.allSettled(jobs);
  return record;
}

/* ── Square webhook ─────────────────────────────────────────────
   Square signs each delivery with an HMAC over the notification URL
   concatenated with the raw body. Verifying it is the difference
   between a notification endpoint and an open relay for anyone who
   guesses the path.                                              */

const SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "";
const NOTIFICATION_URL = process.env.SQUARE_WEBHOOK_URL || "";

function verifySquareSignature(rawBody, header) {
  if (!SIGNATURE_KEY || !NOTIFICATION_URL) return false;
  const expected = crypto
    .createHmac("sha256", SIGNATURE_KEY)
    .update(NOTIFICATION_URL + rawBody)
    .digest("base64");
  const a = Buffer.from(String(header || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const webhookReady = () => Boolean(SIGNATURE_KEY && NOTIFICATION_URL);

/* ── Alert composition ──────────────────────────────────────── */

const seen = new Set();          // payment ids already announced
const SEEN_CAP = 5000;

function alreadySeen(key) {
  if (seen.has(key)) return true;
  seen.add(key);
  if (seen.size > SEEN_CAP) for (const k of [...seen].slice(0, 1000)) seen.delete(k);
  return false;
}

/* Record sales as already announced without sending anything — used on
   boot so a restart never re-announces the morning's orders. */
function markSeen(ids) {
  for (const id of ids) alreadySeen(`sale:${id}`);
}

async function announceSale({ amount, currency, items, tender, staff, dayTotal, dayOrders, channel, id: saleId }) {
  if (!ALERT_SALES) return null;
  if (alreadySeen(`sale:${saleId}`)) return null;
  if (amount < SALE_FLOOR) return null;

  const line = items && items.length
    ? items.slice(0, 3).join(", ") + (items.length > 3 ? ` +${items.length - 3} more` : "")
    : "Sale";

  const running = dayTotal != null
    ? `\n${money(dayTotal, currency)} today across ${dayOrders} sale${dayOrders === 1 ? "" : "s"}`
    : "";

  const online = channel === "online";
  return send({
    title: `${money(amount, currency)} · HERD ${online ? "online" : "in store"}`,
    body: `${online ? "Website order · " : ""}${line}${tender ? `\n${tender}` : ""}${staff ? ` · ${staff}` : ""}${running}`,
    priority: "normal",
    tags: [online ? "globe_with_meridians" : "shopping_bags"],
  });
}

/* One alert per product per day, so a line hovering on the threshold
   doesn't buzz on every refresh. */
function reorderKey(product) {
  return `reorder:${product.id}:${new Date().toISOString().slice(0, 10)}`;
}

async function announceReorders(products, currency) {
  if (!ALERT_REORDER || !products.length) return null;

  const fresh = products.filter(p => !alreadySeen(reorderKey(p)));
  if (!fresh.length) return null;

  const top = fresh.slice(0, 5);
  const body = top.map(p => {
    const cover = p.daysCover === null ? "no cover" : `${p.daysCover}d cover`;
    const out = p.status === "stockout" ? "OUT — " : "";
    return `• ${out}${p.name} (${p.brand}) — ${cover}, ${p.perWeek}/wk`;
  }).join("\n") + (fresh.length > top.length ? `\n…and ${fresh.length - top.length} more` : "");

  return send({
    title: fresh.some(p => p.status === "stockout")
      ? `${fresh.length} line${fresh.length === 1 ? "" : "s"} need reordering — some already out`
      : `${fresh.length} line${fresh.length === 1 ? "" : "s"} hit reorder point`,
    body,
    priority: "high",
    tags: ["package"],
  });
}

async function announceMilestone({ dayTotal, currency, target }) {
  if (!ALERT_MILESTONE || !target) return null;
  const key = `target:${new Date().toISOString().slice(0, 10)}`;
  if (dayTotal < target || alreadySeen(key)) return null;
  return send({
    title: `Daily target hit — ${money(dayTotal, currency)}`,
    body: `Past ${money(target, currency)} for the day.`,
    priority: "normal",
    tags: ["tada"],
  });
}

async function announceDailySummary(summary) {
  if (!ALERT_DAILY) return null;
  const key = `daily:${summary.day}`;
  if (alreadySeen(key)) return null;

  const { currency } = summary;
  const lines = [
    `${money(summary.net, currency)} · ${summary.orders} sales · ${summary.units} units`,
    summary.webLive || summary.online?.orders
      ? `In store ${money(summary.instore?.net || 0, currency)} (${summary.instore?.orders || 0}) · Online ${money(summary.online?.net || 0, currency)} (${summary.online?.orders || 0})`
      : null,
    summary.atv ? `Average sale ${money(summary.atv, currency)}` : null,
    summary.best ? `Best seller: ${summary.best}` : null,
    summary.reorderCount ? `${summary.reorderCount} line${summary.reorderCount === 1 ? "" : "s"} need reordering` : "Nothing needs reordering",
    summary.vs != null ? `${summary.vs >= 0 ? "+" : ""}${summary.vs}% vs the same weekday last week` : null,
  ].filter(Boolean);

  return send({
    title: `HERD — ${summary.dayLabel}`,
    body: lines.join("\n"),
    priority: "low",
    tags: ["bar_chart"],
  });
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const recent = (n = 30) => feed.slice(0, n);

function status() {
  return {
    channels: channels(),
    webhook: webhookReady(),
    webhookUrl: NOTIFICATION_URL || null,
    alerts: {
      sales: ALERT_SALES, reorder: ALERT_REORDER,
      daily: ALERT_DAILY, milestone: ALERT_MILESTONE,
    },
    saleFloor: SALE_FLOOR,
    dailyTarget: DAILY_TARGET,
    closeHour: CLOSE_HOUR,
  };
}

module.exports = {
  send, announceSale, markSeen, announceReorders, announceMilestone, announceDailySummary,
  verifySquareSignature, webhookReady, subscribe, recent, status, channels,
  money, DAILY_TARGET, CLOSE_HOUR,
};
