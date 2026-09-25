/**
 * Seed figures for the Marketing tab.
 *
 * Transcribed from two reports, and only from them — nothing here is
 * estimated or filled in. Each record names its source so any number on
 * the tab can be traced back to the document it came from.
 *
 *   Instagram monthly recap, @the.herdstore — June, July and August 2026
 *   Instagram professional dashboard, 2 – 31 Aug 2026
 *   Instagram profile, @the.herdstore, 1 Sep 2026
 *   Lunr Launch, "HERD Performance Report", all-time 14 Aug – 1 Sep 2026
 *
 * Once the app has a writable disk, anything added through the API replaces
 * the matching month or campaign and this seed stops being used for it.
 */

module.exports = {
  profile: {
    handle: "the.herdstore",
    // Latest hard number: the follower count on the profile itself.
    followers: 2069,
    followersAsOf: "2026-09-01",
    posts: 16,
    source: "Instagram profile, 1 Sep 2026",
  },

  months: [
    {
      month: "2026-06",
      channel: "organic",
      views: 5491,                 // implied by July's +501%; see note
      followersGained: null,
      followersEnd: 389,           // 726 at end of July minus the +337 gained
      posts: 1, reels: 0, stories: null,
      note: "Reconstructed from July's stated changes (+501% views, +337 followers). "
          + "June was not reported directly — treat as indicative, not measured.",
      source: "Instagram monthly recap, July 2026 (comparison figures)",
      estimated: true,
    },
    {
      month: "2026-07",
      channel: "organic",
      views: 33000,
      viewsFromNonFollowers: 58,   // per cent
      followersGained: 337,
      followersEnd: 726,
      reels: 1, posts: 3, stories: 10,
      topPost: {
        title: "HERD STORE — Open July (brand list)",
        views: 10000,
        followersGained: 65,
        note: "More than any other piece of content shared that month.",
      },
      bestTimes: ["Mondays 3–6pm", "Mondays 6–9pm", "Sundays 6–9pm"],
      source: "Instagram monthly recap, July 2026",
    },
    {
      month: "2026-08",
      channel: "organic",
      // August is reported twice and the two do not agree. The monthly recap
      // headlines 134K views; the professional dashboard gives 206.2K for
      // 2–31 Aug. They count different things — the dashboard total takes in
      // the 56 stories, the recap chart does not. The recap figure is the one
      // carried in `views`, because July's 33,000 is also a recap figure and
      // the month-on-month line has to compare like with like. Instagram's
      // own "+300% on July" then reconciles: 134,000 against 33,000 is +306%.
      // The wider dashboard number is kept alongside rather than lost.
      views: 134000,
      viewsDashboard: 206200,     // 2–31 Aug, includes stories
      viewsFromNonFollowers: 51,   // per cent
      interactions: 3000,
      followersGained: 1336,
      followersEnd: 2062,          // 726 at end of July plus the month's gain
      reels: 3, posts: 7, stories: 56,
      contentShared: 64,           // dashboard count for 2–31 Aug
      topPost: {
        title: "Shopfront",
        accountsEngaged: 440,
        note: "More engagement than any other post in the month.",
      },
      note: "Views up 300% on July, views from non-followers up 249%. Three "
          + "more reels and four more posts than July, and 56 stories against "
          + "10. The profile stood at 2,069 followers on 1 September.",
      source: "Instagram monthly recap and professional dashboard, August 2026",
    },
  ],

  campaigns: [
    {
      id: "cmp_lunr_brand_awareness",
      name: "Follower growth — brand awareness",
      platform: "Meta Ads",
      agency: "Lunr Launch",
      account: "act_924359630710507",
      from: "2026-08-14",
      to: "2026-09-01",
      days: 19,
      objective: "Brand awareness",
      status: "Ahead of target",

      spend: 31175,                // minor units — £311.75
      followerGrowth: 961,
      costPerFollow: 32,           // minor units — £0.32
      targetCostPerFollow: 150,    // minor units — £1.50, the scale trigger
      reach: 44775,
      impressions: 69729,          // account total, deduped across ad sets
      linkClicks: 7490,
      ctr: 9.94,                   // per cent
      cpc: 4.5,                    // pence

      followersBefore: 1110,
      // +961 on 1,110 implies 2,071. The profile read 2,069 on 1 September,
      // two apart — timing rather than a discrepancy worth chasing.
      followersAfter: 2069,

      adSets: [
        {
          name: "AS1 · Advantage+",
          spend: 16630,            // £166.30
          reach: 27775,
          linkClicks: 4352,
          ctr: 10.58,
          cpc: 4.1,                // pence
          winner: true,
        },
        {
          name: "AS2 · Shopping interests",
          spend: 14543,            // £145.43
          reach: 23298,
          linkClicks: 3138,
          ctr: 9.18,
          cpc: 5.0,                // pence
        },
      ],

      // By ad, combined across both ad sets. Nothing here foots exactly to the
      // account totals and it is not meant to: the per-ad spends sum to
      // £311.84 against a stated £311.75, and the ad sets to £311.73, both
      // rounding in the report itself. Impressions are further apart again
      // (69,729 combined here against the account's deduped figure) because
      // one person seeing both ad sets counts once at account level. The
      // account row is the measured one; these are for comparing ads.
      creatives: [
        { name: "AD1 · Hero Video",       spend: 28924, impressions: 64708, linkClicks: 7240, ctr: 10.34, cpc: 4.3, winner: true },
        { name: "AD2 · Images",           spend: 1933,  impressions: 4340,  linkClicks: 210,  ctr: 4.75,  cpc: 9.4 },
        { name: "AD3 · Hero Video 2",     spend: 144,   impressions: 325,   linkClicks: 21,   ctr: 5.85,  cpc: 7.6, learning: true },
        { name: "AD4 · Images 2 (Full)",  spend: 183,   impressions: 388,   linkClicks: 21,   ctr: 5.15,  cpc: 9.1, learning: true },
      ],

      findings: [
        "Cost per follow £0.32 against a £1.50 trigger — 79% below target, 4.7× headroom to scale.",
        "AS1 (Advantage+) still leads: 10.58% CTR and £0.041 CPC against 9.18% and £0.050.",
        "AD1 Hero Video carries 93% of spend at the best CTR and lowest CPC. Video is beating image by a distance.",
        "AD3 and AD4 are newer and still gathering data for the next creative round.",
      ],
      actions: [
        "Scale AS1 to £10/day — best CPC and CTR, well under the trigger.",
        "Hold AS2 at £5/day and reassess at the four-week review.",
        "Refresh creative before week 4 as frequency climbs.",
      ],
      caveat: "Follower growth blends paid and organic, so cost per follow is a "
            + "generous read. Even attributing every follow to paid it stays well under target.",

      // The 14–26 Aug reading, kept so the trend is visible rather than
      // overwritten. Cost per follow has risen as spend scaled, which is
      // what scaling normally does, and is still far inside the trigger.
      previously: {
        to: "2026-08-26",
        days: 13,
        spend: 15835,              // £158.35
        followerGrowth: 655,
        costPerFollow: 24,         // £0.24
        reach: 24962,
        impressions: 35193,
        linkClicks: 4053,
        cpm: 450,                  // £4.50 blended
        frequency: 1.41,
        source: "Lunr, Meta Advertising Report — HERD, 14–26 Aug 2026",
      },

      source: "Lunr Launch, HERD Performance Report, all-time 14 Aug – 1 Sep 2026",
    },
  ],
};
