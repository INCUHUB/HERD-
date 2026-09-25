# HERD

The shop on one screen. Trading, stock, team and diary for The Herd Store,
read live from Square.

Built in the same shape as Takings — one Node process, no dependencies, a
`render.yaml` that configures itself — but pointed at a single business and
gone into far more depth, because a clothing shop asks harder questions of
its data than a cafe does.

## Setup

One Square **production access token** and a password. That is the whole
configuration.

### Getting the token

1. Sign in to <https://developer.squareup.com/apps> with the HERD Square login.
2. Create an application — any name.
3. Switch the toggle at the top from **Sandbox** to **Production**. This
   matters: sandbox tokens return convincing fake data.
4. On **Credentials**, reveal and copy the Production Access Token. It starts `EAAA`.

Treat it like a password. It goes in an environment variable, never in a file.

The token needs read access to Payments, Orders, Items, Inventory, Employees
and Timecards. Nothing here writes to Square, so a read-only OAuth token with
those scopes works identically.

### Deploying to Render

1. Push this folder to a **private** GitHub repository.
2. In Render, choose **New → Blueprint** and select it.
3. Render prompts for `SQUARE_ACCESS_TOKEN` and `NTFY_TOPIC`. Paste the token;
   pick any hard-to-guess string for the topic.
4. Deploy. Open **Environment** and copy the generated `DASHBOARD_PASS`.
5. Open the HTTPS URL and sign in as `owner` with that password.

The start-up log names the business, the location and the size of the
catalogue, so you can see immediately whether the token reached the right
account.

### Running locally

```bash
export SQUARE_ACCESS_TOKEN="EAAA..."
export DASHBOARD_PASS="a-long-random-passphrase"
npm start
```

Node 20 or newer. No dependencies, no build step.

### Seeing it without a token

```bash
npm run demo
```

Serves a stand-in Square on port 4000 and runs the app against it on 3000,
with no token and no password. The shop it invents has a few brands, real
size runs, two lines deliberately accelerating, one dead, and one whose best
size has just sold out — so every state on the Stock tab has something in it.
All of it is fictional; see `tools/mock-square.js`.

## Stock — the part that matters

A flat low-stock threshold is the wrong instrument for a clothing shop. Two
left means nothing on its own: two left of a jacket selling one a day is an
emergency; two left of one selling one a month is fine for eight weeks.

So nothing here is a threshold. Everything is expressed in **days of cover** —
stock on hand divided by how fast that line is actually selling — and then
measured against how long that brand takes to deliver.

```
velocity       units per day, weighted 60/40 towards the last 7 days over the last 28
days of cover  on hand ÷ velocity
reorder point  velocity × (lead time + safety days)
revenue at risk  velocity × price × the days you'd spend out of stock
```

A line flags when its cover falls inside its brand's lead time plus a safety
margin. The list is then **ranked by revenue at risk**, not alphabetically and
not by how few units are left — so the thing at the top is the thing the gap
is costing you most.

Velocity is measured over a line's own time on the floor, not a flat 28 days.
Dividing four weeks of sales by 28 understates something that only landed last
Tuesday — which is exactly the line most likely to need reordering.

### Brands come first

The tab opens on a brand table, because the buying decision is usually made
at brand level before it is made at product level. Per brand, over 28 days:

| | |
|---|---|
| **Revenue and share** | what it sold and what proportion of the shop that is |
| **Units and share** | the same in volume |
| **Rate of sale** | units per week |
| **Sell-through** | sold ÷ (sold + on hand) — the number apparel buying runs on |
| **Weeks of cover** | on hand ÷ rate of sale |
| **Stock turn** | annualised, against the money tied up in that brand |
| **ABC** | Pareto class: A is the brands making the first 80% of revenue, B the next 15%, C the tail |

**Value and volume are ranked separately, and you can sort by either.** This
matters more than it sounds. Ranking on revenue alone buries a cheap line
selling in quantity — at a roughly common margin rate those units earn as much
per pound as an expensive one, and they are usually what brings people through
the door. Where a brand's two ranks pull apart by three places or more it gets
labelled: **volume driver** (sells in units, not pounds) or **high ticket** (the
reverse). Those are the two brands you would otherwise misjudge.

A worked example from the demo data: SCRT is a C-class brand — 3.3% of revenue,
sixth by value. By volume it is fifth with 11.8% of units, at 85% sell-through
and 0.7 weeks of cover. On a revenue-sorted list it would look like a rounding
error. It is actually the fastest-turning thing in the shop and about to run out.

### The rest of the tab



**Reorder list.** What to order now, with a suggested quantity, the size run
laid out so you can see which sizes are gone, the trend arrow, and what the
gap costs. Marking a line **Ordered** stops the alerts for it and drops an
expected delivery into the diary on its lead-time date.

**Accelerating.** Lines selling faster this week than over the last four,
which still have cover. These are the ones worth catching *before* they become
the reorder list — the direct answer to "what's selling well that I should
reorder before it sells out".

**What's actually selling.** Four weeks by revenue. This is the input the
reorder list is derived from, shown plainly so the ranking can be checked
against something you recognise.

**Broken size runs.** The best-selling size is gone while the others remain.
The rail looks stocked and sells nothing. Reported separately because the
total count hides it completely — a product with four of five sizes in stock
looks healthy right up until you notice the missing one was 60% of its sales.

**Consider marking down.** Capital sitting still: over 120 days of cover, or
not selling at all. Ranked by money tied up.

**On order.** What you've marked as ordered, when it was raised, when it's
expected. Mark it **Arrived** and it leaves the list.

### Product level and size level

A product is judged as a whole, not by taking the worst of its sizes. A jacket
with four weeks of cover is not "out of stock" because one size has gone —
that is a broken run, which needs the same reorder but is a different fact.
Saying "out" there would simply be false.

The **Losing per day** figure is the reverse: it counts empty *sizes*, because
a shop rarely runs out of a whole product, it runs out size by size, and each
empty peg stops selling on its own.

### Lead times

Set per brand, from the **Lead times** button. This is what decides when a line
flags — a fast-selling piece from a slow brand needs reordering far earlier
than the same seller from a brand that ships in a week. The default is 21 days
(`DEFAULT_LEAD_TIME_DAYS`).

### Inventory tracking

Square only reports counts for variations with tracking switched on. Where
nothing is tracked, the tab says so and tells you where to turn it on rather
than showing an empty table. Turn it on under **Items → Inventory** in Square,
or bulk-enable from the Items list.

## Marketing

Square knows what sold. It knows nothing about what put people in front of the
window, so this tab is fed from elsewhere and kept deliberately separate from
the trading figures.

**Organic** — monthly Instagram figures: views, share from non-followers,
followers gained, what was posted, the best post of the month and when
followers are actually active. Ships seeded with July and August 2026 as
reported.

**Paid** — campaign reports. Spend, follower growth, cost per follow against
target, reach, impressions, frequency, and a per-ad-set table with link clicks,
cost per click, CTR and CPM. Findings and recommended actions are carried
verbatim from the agency report rather than paraphrased, and every record names
its source so any figure can be traced back to the document it came from.

Paid and organic are reported side by side rather than added together — they
answer different questions. The one honest combined figure is what a follower
cost when you paid for one.

### Adding a month

```bash
curl -u owner:PASS -X POST https://your-app.onrender.com/api/marketing/month \
  -H 'Content-Type: application/json' \
  -d '{"month":"2026-09","channel":"organic","views":52000,
       "followersGained":410,"followersEnd":2175,"reels":2,"posts":4,"stories":14,
       "source":"Instagram monthly recap, September 2026"}'
```

`POST /api/marketing/campaign` takes the same shape for a paid report; amounts
are in minor units (pence). Anything posted replaces the seeded figure for that
month or campaign.

### Live follower count

Set `META_ACCESS_TOKEN` and `IG_USER_ID` and the follower number comes from the
Meta Graph API instead of the last figure entered; the tile then says *live*
rather than *as entered*. Any failure falls back to stored figures and shows
why — a marketing tab is not worth breaking the app over.

**This path is written but unverified.** It could not be exercised from the
build environment, which has no route to Meta and no token. Treat the first run
as a test.

Getting the two values is fiddlier than it should be, so there is a helper:

```bash
node tools/meta-token.js --app-id <id> --app-secret <secret> --token <short-lived token>
```

It exchanges the short-lived token from the Graph API Explorer for a **Page
access token — which does not expire on a timer** — finds the Instagram account
behind the Page, verifies it can read the follower count, and prints the two
variables to paste into Render. The Instagram account has to be a Business or
Creator account linked to a Facebook Page; the token needs `instagram_basic`,
`pages_show_list` and `pages_read_engagement`.

## Trading

Ranges: today, yesterday, 7 days, 28 days, 13 weeks, month to date, and
everything since opening.

**Comparisons are weekday-matched.** A Saturday is measured against the
previous Saturday, not against Friday — retail trade varies far more by day of
the week than week to week. The multi-day windows are whole numbers of weeks
(7, 28, 91) precisely so the preceding window holds the same weekday mix; 30
days would not. The previous window also stops at the same point through its
final day, so a part-completed today is never set against a full one.

Each range states its own comparison on screen rather than a vague "previous
period".

You get net takings against the comparison, sales, units, average sale and
items per sale; trade by hour on single days and by day across spans, with the
peak marked; average by weekday on ranges long enough for it to mean anything;
top sellers with unit, revenue, average price and share; risers and fallers
against the previous period, so a fading line shows before it disappears;
revenue by brand; card type and entry method; and the latest sales as they
happen.

## Team

Hours worked from timecards, what those hours cost, and what they took —
against the rota ahead.

The figure worth having is **takings per hour actually worked**, and beside it
labour as a percentage of takings. Per person you get hours, cost, takings,
takings per hour, average sale and items per sale.

**Cover against trade** puts hours staffed and takings side by side, hour by
hour, as two charts sharing one x-axis — never two scales on one plot. A
staffed hour with no takings is the cheapest thing on a rota to fix.

Sales are credited to whoever rang them through, which is the only attribution
Square offers. That is who was on the till, not necessarily who sold the coat,
and the tab says so rather than letting the number imply more than it means.

## Diary

One calendar carrying four things:

- **Rota** — live from Square's schedule. Dashed means unpublished.
- **Social** — posts planned, drafted, scheduled or published, by channel.
- **Events** — in-store events, brand drops, late openings.
- **Deliveries** — created automatically whenever a reorder is marked as
  ordered on the Stock tab, dated by that brand's lead time. Overdue ones turn
  red and raise a count on the tab.

Rota and deliveries are derived — Square owns one, the purchase orders own the
other. Only social and events are edited here.

## Notifications

Two ways in, one way out.

**Instant** — Square posts to `/webhooks/square` the moment a payment lands.
Set it up in Square under **Developer → Webhooks**: point a subscription at
`https://your-app.onrender.com/webhooks/square`, subscribe to `payment.created`,
then set `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_URL` to match.
Deliveries are HMAC-verified; an unsigned request is refused.

**Polling** — without a webhook the app checks once a minute instead. Nothing
to configure, up to a minute behind.

Out goes to whichever of these you set:

| Channel | What you need |
|---|---|
| **ntfy** (simplest) | Install the ntfy app, subscribe to a topic nobody would guess, set `NTFY_TOPIC` to the same string. No account. |
| **Pushover** | `PUSHOVER_TOKEN` and `PUSHOVER_USER`. £5 one-off per platform, nicer app. |
| **Telegram** | `TELEGRAM_BOT_TOKEN` from BotFather and `TELEGRAM_CHAT_ID`. Free, and you can add staff to the chat. |
| **Anything else** | `NOTIFY_WEBHOOK_URL` gets a JSON POST. |

With none configured, alerts still appear in the app's own live feed on the
Alerts tab, which is also where the **Send test** button lives.

Four kinds of alert, each switchable:

- **Every sale** — value, items and the running day total. `ALERT_SALE_FLOOR`
  suppresses small ones if a busy Saturday gets noisy.
- **Reorder** — when a line crosses its reorder point, at most once per
  product per day. This is the one that actually saves money.
- **Daily close** — takings, units, best seller, what needs reordering, and
  the comparison against the same weekday last week.
- **Target** — when the day passes `DAILY_TARGET`.

## Speed

Square is asked for each day once. Completed days never change, so they are
cached and every range is then assembled by summing days rather than re-reading
the API. Fetching is done a calendar month at a time — far fewer, larger
requests than day by day — and only the current month is ever re-read. Eight
weeks are warmed in the background at boot, so the first Stock view is already
there rather than a cold wait.

Merchant, location and catalogue are cached for ten minutes. Concurrent calls
to Square are capped so a cold Stock tab can't burst into a rate limit.

## Storage

Lead times, purchase orders and the diary are the only things Square doesn't
hold, so they live in JSON files under `DATA_DIR`. `render.yaml` attaches a
1 GB disk at `/var/data` for them.

Without a disk Render wipes the filesystem on every deploy. The app still runs,
but those three things reset — and it says so on screen rather than losing a
week of purchase orders quietly.

## Installing it on a phone

It's a progressive web app, so "Add to Home Screen" gives a proper app rather
than a bookmark: HERD wordmark on black, no browser chrome, its own entry in
the app switcher.

- **iPhone** — open in Safari (only Safari can install on iOS), Share → Add to
  Home Screen.
- **Mac / Windows** — Chrome or Edge, install icon in the address bar.
- **Android** — Chrome offers Install directly.

Signing in once sets a session cookie lasting 30 days (`SESSION_DAYS`), because
iOS standalone apps don't reliably keep Basic auth between launches and you'd
otherwise be typing a password every time you tapped the icon.

## Look and feel

Bone `#E9E2D2` and near-black, the HERD wordmark as supplied artwork rather
than a font substitute, Bodoni Moda for figures and Inter for everything else.

The five chart colours are drawn from the brand gradients and then **validated**
rather than chosen by eye — checked for lightness banding, chroma, contrast
against both surfaces, and separation under protanopia, deuteranopia and
tritanopia. Dark mode is a separate validated set, not an automatic flip.

Status colours (out of stock, reorder, watch, healthy) are reserved and never
reused as a series colour, and always carry a text label rather than relying on
colour alone.

## Options

| Variable | Default | Purpose |
|---|---|---|
| `SQUARE_ACCESS_TOKEN` | — | Required. Production token for the HERD account |
| `DASHBOARD_PASS` | — | Required. Password for the app and its API |
| `DASHBOARD_USER` | any | Optional username |
| `ALLOW_OPEN` | unset | `1` disables the password. Localhost only |
| `PORT` | `3000` | Render sets this |
| `DATA_DIR` | `./data` | Lead times, purchase orders, diary |
| `SQUARE_LOCATION_NAME` | unset | Narrow to one site if the account has several |
| `OPENED_ON` | unset | `YYYY-MM-DD`, the start of the "All" range |
| **Reorder engine** | | |
| `DEFAULT_LEAD_TIME_DAYS` | `21` | Used for brands with no lead time set |
| `SAFETY_DAYS` | `7` | Buffer added to lead time before a line flags |
| `TARGET_COVER_DAYS` | `42` | Cover a suggested order aims to restore |
| `OVERSTOCK_DAYS` | `120` | Cover above which a line reads as overstocked |
| `NEW_PRODUCT_DAYS` | `21` | Below this, a line is too new to judge |
| `RECENCY_WEIGHT` | `0.6` | Weight on the last 7 days vs the last 28 |
| `RISING_RATIO` | `1.4` | 7-day rate over 28-day rate that counts as accelerating |
| **Notifications** | | |
| `NTFY_TOPIC` / `NTFY_SERVER` | — / ntfy.sh | Push via ntfy |
| `PUSHOVER_TOKEN` / `PUSHOVER_USER` | — | Push via Pushover |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Push via Telegram |
| `NOTIFY_WEBHOOK_URL` | — | JSON POST anywhere |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | — | Enables instant alerts |
| `SQUARE_WEBHOOK_URL` | — | Must match the URL registered in Square exactly |
| `ALERT_SALES` / `ALERT_REORDER` / `ALERT_DAILY` / `ALERT_MILESTONE` | `1` | Switch each kind off with `0` |
| `ALERT_SALE_FLOOR` | `0` | Minor units. `5000` alerts only above £50 |
| `DAILY_TARGET` | `0` | Minor units. `50000` pings at £500 |
| `CLOSE_SUMMARY_HOUR` | `18` | Local hour for the daily summary |
| **Performance** | | |
| `CACHE_MS` | `30000` | Trading and team cache |
| `STOCK_CACHE_MS` | `300000` | Stock cache; it changes slowly and costs more calls |
| `POLL_MS` | `60000` | Sale polling when no webhook is set |
| `META_TTL_MS` | `600000` | Merchant, location and catalogue cache |
| `SQUARE_CONCURRENCY` | `6` | Simultaneous calls to Square |
| `SESSION_DAYS` | `30` | How long a sign-in lasts |
| `BRAND_SOURCE` | `category` | `category`, or `prefix` to read the brand from the item name |
| `META_ACCESS_TOKEN` | — | Optional. Live Instagram follower count |
| `IG_USER_ID` | — | Optional. The Instagram business account id |
| `IG_CACHE_MS` | `900000` | How long a live follower count is cached |
| `SQUARE_VERSION` | unset | Pin a Square API version |

## Troubleshooting

**502 Bad Gateway, and the deploy log says `Timed Out`.** Render polls
`/api/health` from outside with no credentials. That path is public and returns
liveness only — `{"ok":true,"build":...,"uptime":...}` — with the full detail
reserved for signed-in callers. If you change `healthCheckPath` in
`render.yaml` to something behind the password, Render reads the `401` as
unhealthy, the deploy never goes live, and the URL serves 502 even though the
app is running fine and writing to the log.

Quick check, no password needed:

```bash
curl -s https://your-app.onrender.com/api/health
```

A JSON body means the app is up and the problem is elsewhere. No response at
all means it isn't listening.

**The username and password are rejected.** The start-up log prints what the
app is actually expecting:

```
[herd] sign in as "owner" — password is 24 characters
```

If that length doesn't match what you're typing, `DASHBOARD_PASS` isn't what
you think it is — re-copy it from Render → Environment. If it says `any
username`, `DASHBOARD_USER` is unset and any username will do.

Both values are trimmed, so a trailing space picked up while copying is
harmless, and the password may contain colons.

**The log says `notifications: none configured (in-app feed only)`.** No push
channel is set. Add `NTFY_TOPIC` in Render → Environment and redeploy. Alerts
still reach the Alerts tab in the meantime; they just aren't leaving the server.

**The same sales alert arrives twice.** Render runs the old and new instances
side by side for a few seconds during a deploy, and both poll. The sale
watermark is written to disk so a restart doesn't re-announce history, but a
brief overlap can still double up. It settles once the old instance retires.

**Everything is `£0` on a tab that should have data.** Check the range — HERD
has a short trading history, so "13 weeks" and "All" reach back before it
opened. Set `OPENED_ON` so the "All" range starts on the right day.

## Notes and limits

- Only `COMPLETED` orders count toward totals.
- Amounts come from Square in minor units and are converted once, at display.
- The store's own timezone drives day boundaries and hourly buckets, so
  BST/GMT changes are handled.
- Refunds are not yet netted off — the Refunds API is a separate read and the
  figures presented are gross of them. Worth adding before this is used for
  anything accounting-facing.
- If a token lacks a permission, the affected panel says which one is missing
  and the rest of the app carries on.
- Nothing here writes to Square. Reorder decisions are for you to place with
  the supplier.

## Layout

```
server.js            HTTP, auth, routing, report assembly, polling
lib/square.js        Square client, paging, concurrency, retry
lib/time.js          Local time, weekday-matched ranges
lib/catalog.js       Products, size runs, brands
lib/sales.js         Order history, cached a day at a time
lib/stock.js         The reorder engine
lib/team.js          Timecards, rota, sales per hour
lib/diary.js         Rota + social + events + deliveries
lib/notify.js        Webhook verification and push channels
lib/store.js         Atomic JSON store for lead times, POs, diary
public/              The interface — no framework, no build step
tools/mock-square.js A stand-in Square, for the demo
```


## Online sales (Shopify)

Build `2026-09-25-herd-8-online` adds theherdstore.com. Every sale in the app is now labelled **In store** (Square) or **Online** (Shopify), and every total is the sum of both.

**Where it shows**

- **Trading hero**: the split bar under the headline, with in-store and online takings, count, share and change on the comparison period.
- **Day by day**: stacked bars, in store underneath and online on top. The hour chart on Today and Yesterday is in store only, because it is used for staffing.
- **In store and online**: side by side takings, share, sales, units, average sale, items per sale, delivery charged and change.
- **Selling online**: the best-selling products on the website and where the orders ship to.
- **Latest sales**: each row is tagged SHOP or ONLINE.
- **Alerts**: a sale alert reads "£85 · HERD online" or "£85 · HERD in store". The 6pm summary gives the split.
- **Team**: labour ratio and sales per hour use in-store takings only.
- **Stock**: online units count toward rate of sale, as long as the web line can be matched to a Square variation. It is matched on SKU first, then on product name plus size. Lines that can't be matched show as "online, not linked to Square" until the Shopify variant gets the Square SKU.

**Setting it up**

1. Shopify admin → Settings → Apps → Develop apps → this opens the **Dev Dashboard**. Create an app called `HERD Dashboard`. It must be in the same Shopify organisation as the store.
2. Access scopes: `read_orders` and `read_products`. Add `read_all_orders` too if it is offered. Without it Shopify only returns the last 60 days, although the app also saves each finished month to the disk.
3. Release the version, then install the app on `hsnza9-p0.myshopify.com`.
4. Copy the Client ID and Client secret into Render as `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`. `SHOPIFY_STORE` is already set in render.yaml. Save and redeploy.
5. Check `/api/health` while signed in. `shopify.enabled` should be true with no `error`.

An older admin-created custom app's `shpat_` token also works: set it as `SHOPIFY_ACCESS_TOKEN` instead of the ID and secret.

**When the DPL Shopify to Square connector goes live**, online orders will also appear in Square. When the Shopify feed is on, those Square copies are skipped, so nothing is counted twice. They are detected by the Square order's source name matching `shopify|dpl`. Override that with `SQUARE_SHOPIFY_SOURCES` if DPL uses a different name. If the Shopify feed is off, those orders are kept and labelled online.

`npm run demo` now includes a mock web shop, so the whole thing can be seen without any tokens.
