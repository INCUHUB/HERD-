/**
 * Marketing — organic reach and paid spend in one place.
 *
 * Square knows what sold. It knows nothing about what put people in front
 * of the window, so this tab is fed from two other places:
 *
 *   organic  monthly Instagram figures, entered here or pulled live from
 *            the Meta Graph API when a token is configured
 *   paid     campaign reports (Lunr / Meta Ads), entered here
 *
 * Everything is stored as plain JSON so a month can be added in ten
 * seconds without a deploy, and so the figures are auditable against the
 * reports they came from — each record carries its own source.
 */

const store = require("./store");
const SEED = require("./marketing-seed");

const KEY = "marketing";

const IG_TOKEN = process.env.META_ACCESS_TOKEN || "";
const IG_USER_ID = process.env.IG_USER_ID || "";
const LIVE_TTL = Number(process.env.IG_CACHE_MS || 900000);

const round = (n, p = 1) => Math.round(n * 10 ** p) / 10 ** p;
const pct = (now, before) => (!before ? null : round(((now - before) / before) * 100, 0));

/* ── Live Instagram ─────────────────────────────────────────────
   Optional. With META_ACCESS_TOKEN and IG_USER_ID set, the follower
   count comes from the Graph API instead of the last figure typed in.
   Any failure falls back to stored numbers and says why — a marketing
   tab is not worth breaking the app over. */

let liveCache = { at: 0, value: null, error: null };

async function liveProfile() {
  if (!IG_TOKEN || !IG_USER_ID) return { configured: false };
  if (liveCache.value && Date.now() - liveCache.at < LIVE_TTL) return liveCache.value;

  try {
    const url = new URL(`https://graph.facebook.com/v21.0/${IG_USER_ID}`);
    url.searchParams.set("fields", "username,followers_count,media_count");
    url.searchParams.set("access_token", IG_TOKEN);

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);

    const value = {
      configured: true, live: true,
      handle: json.username || null,
      followers: json.followers_count ?? null,
      posts: json.media_count ?? null,
      fetchedAt: new Date().toISOString(),
    };
    liveCache = { at: Date.now(), value, error: null };
    return value;
  } catch (err) {
    liveCache = { at: Date.now(), value: null, error: err.message };
    return { configured: true, live: false, error: err.message };
  }
}

/* ── Stored figures ─────────────────────────────────────────── */

const blank = () => ({ profile: {}, months: [], campaigns: [] });

/* Seeded with the figures from the July recap and the Lunr Meta report, so
   the tab is useful on first boot and on a deployment with no disk. Anything
   entered afterwards replaces the seed for that month or campaign. */
const read = () => store.read(KEY, SEED);

function addMonth(entry) {
  if (!/^\d{4}-\d{2}$/.test(entry.month || "")) {
    const err = new Error("A month must look like 2026-07");
    err.status = 400;
    throw err;
  }
  store.update(KEY, blank(), s => {
    s.months = s.months.filter(m => m.month !== entry.month);
    s.months.push({ ...entry, updatedAt: new Date().toISOString() });
    s.months.sort((a, b) => a.month.localeCompare(b.month));
    return s;
  });
  return entry;
}

function addCampaign(entry) {
  const id = entry.id || "cmp_" + Date.now().toString(36);
  store.update(KEY, blank(), s => {
    s.campaigns = s.campaigns.filter(c => c.id !== id);
    s.campaigns.push({ ...entry, id, updatedAt: new Date().toISOString() });
    s.campaigns.sort((a, b) => (b.from || "").localeCompare(a.from || ""));
    return s;
  });
  return { ...entry, id };
}

function removeCampaign(id) {
  let removed = false;
  store.update(KEY, blank(), s => {
    const before = s.campaigns.length;
    s.campaigns = s.campaigns.filter(c => c.id !== id);
    removed = s.campaigns.length < before;
    return s;
  });
  return removed;
}

/* ── Report ─────────────────────────────────────────────────── */

const monthLabel = key => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
};

async function build() {
  const data = read();
  const live = await liveProfile();

  const months = [...(data.months || [])].sort((a, b) => a.month.localeCompare(b.month));
  const latest = months[months.length - 1] || null;
  const previous = months[months.length - 2] || null;

  // Live wins where it's available; otherwise the last figure entered.
  const followers = live.live && live.followers != null
    ? live.followers
    : (data.profile?.followers ?? latest?.followersEnd ?? null);

  const campaigns = [...(data.campaigns || [])];
  const paidSpend = campaigns.reduce((s, c) => s + (c.spend || 0), 0);
  const paidFollows = campaigns.reduce((s, c) => s + (c.followerGrowth || 0), 0);

  // Blended cost per follow across every campaign recorded.
  const costPerFollow = paidFollows > 0 ? round(paidSpend / paidFollows, 2) : null;

  const series = months.map(m => ({
    month: m.month,
    label: monthLabel(m.month),
    views: m.views || 0,
    followersGained: m.followersGained || 0,
    followersEnd: m.followersEnd || null,
    posts: (m.posts || 0) + (m.reels || 0),
    stories: m.stories || 0,
  }));

  return {
    ok: true,
    persistent: store.isPersistent(),
    instagram: {
      handle: live.handle || data.profile?.handle || null,
      followers,
      source: live.live ? "live" : "entered",
      liveConfigured: Boolean(live.configured),
      liveError: live.error || null,
      fetchedAt: live.fetchedAt || null,
      asOf: data.profile?.followersAsOf || null,
    },
    latest: latest ? {
      ...latest,
      label: monthLabel(latest.month),
      change: previous ? {
        views: pct(latest.views, previous.views),
        followersGained: pct(latest.followersGained, previous.followersGained),
      } : null,
    } : null,
    series,
    campaigns,
    paid: {
      spend: paidSpend,
      followers: paidFollows,
      costPerFollow,
      campaigns: campaigns.length,
    },
    // Paid and organic answer different questions, so they are reported
    // side by side rather than added together. The one honest combined
    // figure is what a follower cost when you paid for one.
    combined: {
      followersNow: followers,
      paidShare: followers && paidFollows ? round((paidFollows / followers) * 100, 0) : null,
    },
  };
}

module.exports = { build, addMonth, addCampaign, removeCampaign, read, monthLabel };
