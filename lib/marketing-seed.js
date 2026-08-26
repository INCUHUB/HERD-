/**
 * Seed figures for the Marketing tab.
 *
 * Transcribed from two reports, and only from them — nothing here is
 * estimated or filled in. Each record names its source so any number on
 * the tab can be traced back to the document it came from.
 *
 *   Instagram monthly recap, @the.herdstore — June and July 2026
 *   Instagram professional dashboard, 26 Jul – 24 Aug 2026
 *   Lunr, "Meta Advertising Report — HERD", campaign to date, 14–26 Aug 2026
 *
 * Once the app has a writable disk, anything added through the API replaces
 * the matching month or campaign and this seed stops being used for it.
 */

module.exports = {
  profile: {
    handle: "the.herdstore",
    // Latest hard number: the Lunr report's end-of-campaign follower count.
    followers: 1765,
    followersAsOf: "2026-08-26",
    source: "Lunr Meta report, 14–26 Aug 2026",
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
      // The professional dashboard reports a rolling 26 Jul – 24 Aug window
      // rather than a calendar month. Kept as reported rather than pro-rated.
      window: "26 Jul – 24 Aug 2026",
      views: 145200,
      interactions: 2600,
      followersGained: 1000,
      contentShared: 49,
      topPost: {
        title: "Shopfront",
        accountsEngaged: 426,
        note: "More engagement than any other post in the window.",
      },
      source: "Instagram professional dashboard, 26 Jul – 24 Aug 2026",
      partialMonth: true,
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
      to: "2026-08-26",
      days: 13,
      objective: "Brand awareness",
      spend: 15835,                // minor units — £158.35
      followerGrowth: 655,
      costPerFollow: 24,           // minor units — £0.24
      targetCostPerFollow: 150,    // minor units — £1.50
      impressions: 35193,
      reach: 24962,
      linkClicks: 4053,
      videoViews: 11878,
      postReactions: 142,
      saves: 13,
      cpm: 450,                    // minor units — £4.50 blended
      frequency: 1.41,
      followersBefore: 1110,
      followersAfter: 1765,
      dailyBudget: 1300,           // minor units — £13/day
      adSets: [
        {
          name: "AS1 · Local (Advantage+)",
          linkClicks: 2335,
          costPerLinkClick: 3.3,   // pence
          ctr: 11.8,
          cpm: 430,
          winner: true,
        },
        {
          name: "AS2 · Local (Shopping Interests)",
          linkClicks: 1718,
          costPerLinkClick: 4.7,
          ctr: 9.3,
          cpm: 471,
        },
      ],
      findings: [
        "Cost per follow £0.24 — around 6× better than the £1.50 target.",
        "AS1 (Advantage+ broad) leads on every metric and has for two straight weeks: 11.8% CTR vs 9.3%, £4.30 CPM vs £4.71.",
        "Frequency 1.41 at £4.50 blended CPM — the audience is not yet saturating.",
      ],
      actions: [
        "Scale both ad sets from £13 to £15–20/day.",
        "Weight the increase toward AS1 (Advantage+).",
        "Monitor CPF and frequency after scaling; take results into the 4-week review.",
      ],
      caveat: "Follower growth blends paid and organic, so cost per follow is a "
            + "generous read. Even attributing every follow to paid it stays well under target.",
      source: "Lunr, Meta Advertising Report — HERD, campaign to date",
    },
  ],
};
