/**
 * Square client — thin, dependency-free.
 *
 * Every call here is a read. Nothing in this application writes to Square;
 * the reorder decisions it produces are for a human to act on in Square's
 * own purchase-order screens or with the supplier directly.
 */

const SQUARE_API = process.env.SQUARE_API || "https://connect.squareup.com/v2";
const SQUARE_VERSION = process.env.SQUARE_VERSION || "";

/* Square rejects bursts hard, and a cold Stock tab can fire a few hundred
   calls. One in-process gate keeps concurrency civil without a dependency. */
const MAX_INFLIGHT = Number(process.env.SQUARE_CONCURRENCY || 6);
let inflight = 0;
const waiting = [];

function acquire() {
  if (inflight < MAX_INFLIGHT) { inflight++; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else inflight--;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function square(token, endpoint, { method = "GET", params, body, retries = 2 } = {}) {
  const url = new URL(SQUARE_API + endpoint);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (SQUARE_VERSION) headers["Square-Version"] = SQUARE_VERSION;
  if (body) headers["Content-Type"] = "application/json";

  await acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      let res, json;
      try {
        res = await fetch(url, {
          method, headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(Number(process.env.SQUARE_TIMEOUT_MS || 30000)),
        });
        json = await res.json().catch(() => ({}));
      } catch (netErr) {
        if (attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
        const err = new Error(`Could not reach Square: ${netErr.message}`);
        err.code = "NETWORK";
        throw err;
      }

      if (res.ok) return json;

      // 429 and 5xx are worth another go; a 401 or 403 never is.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }

      const e = (json && json.errors && json.errors[0]) || {};
      const err = new Error(e.detail || `HTTP ${res.status}`);
      err.code = e.code || "";
      err.status = res.status;
      err.endpoint = endpoint;
      throw err;
    }
  } finally {
    release();
  }
}

async function squarePaged(token, endpoint, params, field, cap = 5000) {
  const out = [];
  let cursor;
  do {
    const page = await square(token, endpoint, { params: { ...params, cursor, limit: 100 } });
    out.push(...(page[field] || []));
    cursor = page.cursor;
  } while (cursor && out.length < cap);
  return out;
}

async function squarePagedPost(token, endpoint, body, field, cap = 5000) {
  const out = [];
  let cursor;
  do {
    const page = await square(token, endpoint, { method: "POST", body: { ...body, cursor, limit: 500 } });
    out.push(...(page[field] || []));
    cursor = page.cursor;
  } while (cursor && out.length < cap);
  return out;
}

/* Whether a failure is a missing permission rather than a broken token.
   Worth distinguishing: one means "reauthorise with this scope", the
   other means "this token is dead". */
function permissionProblem(err) {
  return err && (err.code === "FORBIDDEN" || err.code === "INSUFFICIENT_SCOPES" || err.status === 403);
}
function authProblem(err) {
  return err && (err.code === "UNAUTHORIZED" || err.code === "ACCESS_TOKEN_EXPIRED"
    || err.code === "ACCESS_TOKEN_REVOKED" || err.status === 401);
}

module.exports = { square, squarePaged, squarePagedPost, permissionProblem, authProblem, SQUARE_API };
