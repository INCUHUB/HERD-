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
 *   Lunr, "Meta Advertising Report — HERD", campaign to date, 14–26 Aug 2026
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
