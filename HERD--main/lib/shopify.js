/**
 * Shopify client — the online shop at theherdstore.com.
 *
 * Read only, like the Square client. Square carries the till; Shopify
 * carries the website. Together they are every sale HERD takes, and this
 * module is how the online half gets into the app.
 *
 * Access comes from an app made in Shopify's Dev Dashboard, installed on
 * the HERD store with read_orders (and read_products). Since January 2026
 * Shopify no longer hands out a permanent shpat_ token for new apps: the
 * app has a client ID and secret, and trades them for a token that lasts
 * 24 hours. That exchange happens here, and is repeated before expiry.
 *
 *   SHOPIFY_STORE          hsnza9-p0.myshopify.com
 *   SHOPIFY_CLIENT_ID      from the app's Settings page in the Dev Dashboard
 *   SHOPIFY_CLIENT_SECRET  from the same page
 *
 * An older admin-created custom app's permanent token also works:
 *   SHOPIFY_ACCESS_TOKEN   shpat_...
 */

const STORE = (process.env.SHOPIFY_STORE || "").trim()
  .replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const CLIENT_ID = (process.env.SHOPIFY_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.SHOPIFY_CLIENT_SECRET || "").trim();
const STATIC_TOKEN = (process.env.SHOPIFY_ACCESS_TOKEN || "").trim();
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";
// Only for the demo, which points this at the mock in tools/mock-square.js.
const BASE = (process.env.SHOPIFY_API_BASE || `https://${STORE}`).replace(/\/$/, "");

const enabled = () => Boolean(STORE && (STATIC_TOKEN || (CLIENT_ID && CLIENT_SECRET)));

const sleep = ms => new Promise(r => setTimeout(r, ms));

let tokenCache = { value: STATIC_TOKEN || null, expires: STATIC_TOKEN ? Infinity : 0 };
let tokenPending = null;
let lastError = null;
let lastOkAt = null;

async function accessToken(force = false) {
  if (!force && tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;
  if (STATIC_TOKEN) return STATIC_TOKEN;
  if (tokenPending) return tokenPending;

  tokenPending = (async () => {
    const res = await fetch(`${BASE}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      const err = new Error(json.error_description || json.error || json.errors || `Shopify token request failed (HTTP ${res.status})`);
      err.status = res.status;
      err.code = "SHOPIFY_AUTH";
      throw err;
    }
    // Renew ten minutes early rather than find out mid-request.
    const life = Number(json.expires_in || 86399) * 1000;
    tokenCache = { value: json.access_token, expires: Date.now() + life - 600000 };
    return json.access_token;
  })();

  try { return await tokenPending; } finally { tokenPending = null; }
}

async function graphql(query, variables = {}, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(attempt > 0 && attempt === retries);
    let res, json;
    try {
      res = await fetch(`${BASE}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30000),
      });
      json = await res.json().catch(() => ({}));
    } catch (netErr) {
      if (attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
      throw Object.assign(new Error(`Could not reach Shopify: ${netErr.message}`), { code: "NETWORK" });
    }

    // An expired or revoked token: fetch a fresh one once and try again.
    if (res.status === 401 && !STATIC_TOKEN && attempt < retries) {
      tokenCache = { value: null, expires: 0 };
      continue;
    }

    const throttled = res.status === 429
      || (json.errors || []).some(e => e.extensions?.code === "THROTTLED");
    if ((throttled || res.status >= 500) && attempt < retries) {
      await sleep(1000 * (attempt + 1));
      continue;
    }

    if (!res.ok || json.errors) {
      const first = Array.isArray(json.errors) ? json.errors[0] : null;
      const msg = first?.message || (typeof json.errors === "string" ? json.errors : `HTTP ${res.status}`);
      const err = new Error(`Shopify: ${msg}`);
      err.status = res.status;
      err.code = res.status === 401 ? "SHOPIFY_AUTH" : res.status === 403 ? "SHOPIFY_SCOPE" : "SHOPIFY";
      throw err;
    }
    return json.data;
  }
}

const ORDERS_QUERY = `
query HerdOrders($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      processedAt
      cancelledAt
      test
      sourceName
      displayFinancialStatus
      displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      currentTotalDiscountsSet { shopMoney { amount } }
      currentTotalTaxSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      shippingAddress { city countryCodeV2 }
      paymentGatewayNames
      lineItems(first: 100) {
        nodes {
          title
          variantTitle
          sku
          vendor
          quantity
          currentQuantity
          discountedTotalSet { shopMoney { amount } }
          variant { sku }
        }
      }
    }
  }
}`;

/* Money in the same minor units Square uses, so the two can be summed. */
const minor = set => Math.round(Number(set?.shopMoney?.amount || 0) * 100);

/* Shopify's order shape, reduced to what the app needs. Small enough to
   keep on disk per month, which matters: without the read_all_orders
   scope Shopify only returns the last 60 days. */
function compact(o) {
  const lines = (o.lineItems?.nodes || []).map(li => {
    const qty = Number(li.currentQuantity ?? li.quantity ?? 0);
    const ordered = Number(li.quantity || 0) || 1;
    const total = minor(li.discountedTotalSet);
    return {
      title: li.title || "Item",
      variant: li.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : "",
      sku: (li.sku || li.variant?.sku || "").trim(),
      vendor: li.vendor || "",
      qty,
      // Revenue follows the quantity still on the order, so a refunded
      // line stops counting.
      revenue: Math.round(total * (qty / ordered)),
    };
  });

  return {
    id: o.id,
    name: o.name,
    at: o.processedAt || o.createdAt,
    cancelled: Boolean(o.cancelledAt),
    test: Boolean(o.test),
    source: o.sourceName || "web",
    status: o.displayFinancialStatus || "",
    fulfilment: o.displayFulfillmentStatus || "",
    net: minor(o.currentTotalPriceSet),
    discounts: minor(o.currentTotalDiscountsSet),
    tax: minor(o.currentTotalTaxSet),
    shipping: minor(o.totalShippingPriceSet),
    refunded: minor(o.totalRefundedSet),
    currency: o.currentTotalPriceSet?.shopMoney?.currencyCode || "GBP",
    city: o.shippingAddress?.city || "",
    country: o.shippingAddress?.countryCodeV2 || "",
    gateway: (o.paymentGatewayNames || [])[0] || "",
    lines,
  };
}

/* Every order created between two instants. */
async function ordersBetween(start, end, cap = 10000) {
  if (!enabled()) return [];
  const q = `created_at:>='${start.toISOString()}' created_at:<'${end.toISOString()}'`;
  const out = [];
  let after = null;
  try {
    do {
      const data = await graphql(ORDERS_QUERY, { q, after });
      const page = data.orders;
      out.push(...page.nodes.map(compact));
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after && out.length < cap);
    lastError = null;
    lastOkAt = new Date().toISOString();
    return out;
  } catch (err) {
    lastError = err.message;
    throw err;
  }
}

function status() {
  return {
    enabled: enabled(),
    store: STORE || null,
    auth: STATIC_TOKEN ? "access token" : (CLIENT_ID ? "client credentials" : null),
    lastOkAt,
    error: lastError,
  };
}

module.exports = { enabled, ordersBetween, status, graphql, STORE };
