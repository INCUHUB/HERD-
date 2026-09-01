#!/usr/bin/env node
/**
 * Turn a short-lived Meta token into the two values the Marketing tab needs.
 *
 * Meta hands you a token that dies in an hour or two. This walks the two
 * exchanges that turn it into a Page access token — which does not expire —
 * then finds the Instagram account behind the Page and checks it can actually
 * read the follower count before telling you it worked.
 *
 *   node tools/meta-token.js \
 *     --app-id 1234567890 \
 *     --app-secret abc123... \
 *     --token EAAG...            # from the Graph API Explorer
 *
 * Prints the two environment variables to paste into Render. Nothing is
 * written to disk and nothing is sent anywhere except Meta.
 */

const VERSION = process.env.GRAPH_VERSION || "v21.0";
const BASE = `https://graph.facebook.com/${VERSION}`;

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}

const appId = args["app-id"] || process.env.META_APP_ID;
const appSecret = args["app-secret"] || process.env.META_APP_SECRET;
const shortToken = args.token || process.env.META_SHORT_TOKEN;

if (!appId || !appSecret || !shortToken) {
  console.error(`
Usage: node tools/meta-token.js --app-id <id> --app-secret <secret> --token <short-lived token>

  app-id / app-secret   Meta app → Settings → Basic
  token                 Graph API Explorer, with instagram_basic,
                        pages_show_list and pages_read_engagement granted
`);
  process.exit(1);
}

async function get(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(json?.error?.message || `HTTP ${res.status}`);
  }
  return json;
}

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

(async () => {
  try {
    step(1, "Exchanging the short-lived token for a long-lived one…");
    const longLived = await get("/oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    });
    console.log(`    got a user token, expires in about ${Math.round((longLived.expires_in || 5184000) / 86400)} days`);

    step(2, "Finding your Pages…");
    const pages = await get("/me/accounts", {
      access_token: longLived.access_token,
      fields: "id,name,access_token",
    });
    if (!pages.data?.length) {
      throw new Error("No Pages on this account. The Instagram account must be a "
        + "Business or Creator account linked to a Facebook Page.");
    }
    pages.data.forEach((p, i) => console.log(`    ${i + 1}. ${p.name} (${p.id})`));

    step(3, "Looking for the Instagram account behind each Page…");
    let found = null;
    for (const page of pages.data) {
      try {
        const linked = await get(`/${page.id}`, {
          access_token: page.access_token,
          fields: "instagram_business_account{id,username,followers_count}",
        });
        const ig = linked.instagram_business_account;
        if (ig) {
          console.log(`    ${page.name} → @${ig.username} (${ig.followers_count} followers)`);
          // Prefer the HERD account if several Pages come back.
          if (!found || /herd/i.test(ig.username)) found = { page, ig };
        } else {
          console.log(`    ${page.name} → no Instagram account linked`);
        }
      } catch (err) {
        console.log(`    ${page.name} → could not check: ${err.message}`);
      }
    }

    if (!found) {
      throw new Error("No Page has an Instagram Business account linked. Link them in "
        + "Instagram → Settings → Account type and tools, then run this again.");
    }

    step(4, "Verifying the Page token can read the follower count…");
    const check = await get(`/${found.ig.id}`, {
      access_token: found.page.access_token,
      fields: "username,followers_count,media_count",
    });
    console.log(`    @${check.username}: ${check.followers_count} followers, ${check.media_count} posts`);

    console.log(`
────────────────────────────────────────────────────────────
Paste these into Render → Environment, then redeploy:

META_ACCESS_TOKEN=${found.page.access_token}
IG_USER_ID=${found.ig.id}

This is a Page access token: it does not expire on a timer. It stops
working if you change your Facebook password, remove the app, or lose
admin on the Page. Treat it like a password — it is not read-only for
everything the app can reach.
────────────────────────────────────────────────────────────`);
  } catch (err) {
    console.error(`\n  Failed: ${err.message}\n`);
    process.exit(1);
  }
})();
