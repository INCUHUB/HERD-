/**
 * Staffing.
 *
 * Three separate things in Square that only mean something together:
 * who is on the team, the hours they actually clocked (timecards), and
 * the hours they were meant to work (scheduled shifts). Sales are joined
 * on by the team member who put the order through, which gives the one
 * figure that matters in a small shop — takings per hour worked, against
 * what that hour cost.
 */

const { square, squarePagedPost, squarePaged, permissionProblem } = require("./square");
const T = require("./time");

const HOUR_MS = 3600000;

async function teamMembers(token, locationIds) {
  const out = [];
  let cursor;
  do {
    const page = await square(token, "/team-members/search", {
      method: "POST",
      body: {
        cursor, limit: 100,
        query: { filter: { location_ids: locationIds } },
      },
    });
    out.push(...(page.team_members || []));
    cursor = page.cursor;
  } while (cursor && out.length < 500);
  return out;
}

async function timecards(token, locationIds, start, end) {
  return squarePagedPost(token, "/labor/timecards/search", {
    query: {
      filter: {
        location_ids: locationIds,
        start: { start_at: start.toISOString(), end_at: end.toISOString() },
      },
      sort: { field: "START_AT", order: "DESC" },
    },
  }, "timecards", 2000);
}

async function scheduledShifts(token, locationIds, start, end) {
  return squarePagedPost(token, "/labor/scheduled-shifts/search", {
    query: {
      filter: {
        location_ids: locationIds,
        start: { start_at: start.toISOString(), end_at: end.toISOString() },
      },
    },
  }, "scheduled_shifts", 2000);
}

const hoursOf = tc => {
  if (!tc.start_at || !tc.end_at) return 0;
  return Math.max(0, (new Date(tc.end_at) - new Date(tc.start_at)) / HOUR_MS);
};

/* Spread one shift across the hours of the day it covers, so "were we
   staffed when we were busy" can be asked of the same buckets as sales. */
function spreadAcrossHours(tz, startISO, endISO, into) {
  if (!startISO || !endISO) return;
  let cursor = new Date(startISO);
  const end = new Date(endISO);
  let guard = 0;
  while (cursor < end && guard++ < 48) {
    const hour = T.hourOf(tz, cursor.toISOString());
    const nextHour = new Date(cursor);
    nextHour.setUTCMinutes(0, 0, 0);
    nextHour.setUTCHours(nextHour.getUTCHours() + 1);
    const slice = (Math.min(end, nextHour) - cursor) / HOUR_MS;
    into[hour] = (into[hour] || 0) + slice;
    cursor = new Date(Math.min(end, nextHour));
  }
}

async function build(ctx, spec, totals) {
  const { token, locationIds, tz, currency } = ctx;

  let members = [], cards = [], rota = [];
  const problems = [];

  try {
    members = await teamMembers(token, locationIds);
  } catch (err) {
    problems.push(permissionProblem(err)
      ? "This token can't read the team — staffing needs Employees read access."
      : `Team list unavailable: ${err.message}`);
  }

  try {
    cards = await timecards(token, locationIds, spec.start, spec.end);
  } catch (err) {
    problems.push(permissionProblem(err)
      ? "This token can't read timecards — hours and labour cost need Timecards read access."
      : `Timecards unavailable: ${err.message}`);
  }

  try {
    // Two weeks ahead is the useful horizon for a rota; further out is
    // usually unpublished anyway.
    rota = await scheduledShifts(token, locationIds, T.midnight(tz, 1), T.midnight(tz, -15));
  } catch (err) {
    problems.push(permissionProblem(err)
      ? "This token can't read the schedule — the rota needs Timecards read access."
      : `Rota unavailable: ${err.message}`);
  }

  const byId = new Map();
  for (const m of members) {
    byId.set(m.id, {
      id: m.id,
      name: [m.given_name, m.family_name].filter(Boolean).join(" ") || "Unnamed",
      initials: [m.given_name, m.family_name].filter(Boolean).map(s => s[0]).join("").toUpperCase() || "?",
      status: m.status,
      isOwner: Boolean(m.is_owner),
      job: m.wage_setting?.job_assignments?.[0]?.job_title || "",
      hourlyRate: m.wage_setting?.job_assignments?.[0]?.hourly_rate?.amount || 0,
      hours: 0, cost: 0, shifts: 0,
      net: 0, orders: 0, units: 0,
    });
  }

  const coverage = new Array(24).fill(0);
  let totalHours = 0, totalCost = 0;

  // Square is asked for the window, but a shift that merely overlaps it can
  // still come back. Trimming here keeps "hours this week" honest rather
  // than quietly counting last month's shifts against this week's takings.
  const from = spec.start.getTime(), to = spec.end.getTime();
  cards = cards.filter(tc => {
    const t = new Date(tc.start_at).getTime();
    return Number.isFinite(t) && t >= from && t <= to;
  });

  for (const tc of cards) {
    const hours = hoursOf(tc);
    if (!hours) continue;
    totalHours += hours;

    const rate = tc.wage?.hourly_rate?.amount || byId.get(tc.team_member_id)?.hourlyRate || 0;
    const cost = hours * rate;
    totalCost += cost;

    const person = byId.get(tc.team_member_id);
    if (person) {
      person.hours += hours;
      person.cost += cost;
      person.shifts += 1;
      if (!person.job && tc.wage?.title) person.job = tc.wage.title;
    }
    spreadAcrossHours(tz, tc.start_at, tc.end_at, coverage);
  }

  // Join sales on. A sale is credited to whoever rang it through, which is
  // the only attribution Square offers — fine for a shop this size, but it
  // measures who was on the till, not who sold the coat.
  for (const [staffId, v] of totals.staff || new Map()) {
    const person = byId.get(staffId);
    if (!person) continue;
    person.net += v.net || 0;
    person.orders += v.orders || 0;
    person.units += v.units || 0;
  }

  const people = [...byId.values()]
    .map(p => ({
      ...p,
      hours: Math.round(p.hours * 10) / 10,
      cost: Math.round(p.cost),
      perHour: p.hours > 0 ? Math.round(p.net / p.hours) : null,
      atv: p.orders > 0 ? Math.round(p.net / p.orders) : null,
      upt: p.orders > 0 ? Math.round((p.units / p.orders) * 10) / 10 : null,
      labourRatio: p.net > 0 ? Math.round((p.cost / p.net) * 1000) / 10 : null,
    }))
    .filter(p => p.hours > 0 || p.net > 0 || p.status === "ACTIVE")
    .sort((a, b) => b.net - a.net || b.hours - a.hours);

  // Where the hours went versus where the money came from. A staffed hour
  // with no takings is the cheapest thing to fix on a rota.
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const staffed = Math.round((coverage[h] || 0) * 10) / 10;
    const net = totals.hourly?.[h] || 0;
    if (!staffed && !net) continue;
    hourly.push({ hour: h, staffed, net, perStaffHour: staffed > 0 ? Math.round(net / staffed) : null });
  }

  const upcoming = rota
    .map(s => {
      const d = s.published_shift_details || s.draft_shift_details || {};
      if (d.is_deleted) return null;
      const person = byId.get(d.team_member_id);
      return {
        id: s.id,
        day: d.start_at ? T.localDay(tz, new Date(d.start_at)) : null,
        start: d.start_at, end: d.end_at,
        from: d.start_at ? T.clock(tz, d.start_at) : "",
        to: d.end_at ? T.clock(tz, d.end_at) : "",
        hours: d.start_at && d.end_at ? Math.round(((new Date(d.end_at) - new Date(d.start_at)) / HOUR_MS) * 10) / 10 : 0,
        teamMemberId: d.team_member_id || null,
        name: person?.name || (d.team_member_id ? "Unassigned" : "Open shift"),
        initials: person?.initials || "—",
        job: person?.job || "",
        published: Boolean(s.published_shift_details),
        notes: d.notes || "",
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  const scheduledHours = upcoming.reduce((s, u) => s + u.hours, 0);
  const scheduledCost = upcoming.reduce((s, u) => s + u.hours * (byId.get(u.teamMemberId)?.hourlyRate || 0), 0);

  return {
    ok: true, currency, problems,
    summary: {
      active: people.filter(p => p.status === "ACTIVE").length,
      hours: Math.round(totalHours * 10) / 10,
      cost: Math.round(totalCost),
      labourRatio: totals.net > 0 ? Math.round((totalCost / totals.net) * 1000) / 10 : null,
      salesPerHour: totalHours > 0 ? Math.round(totals.net / totalHours) : null,
      shifts: cards.length,
      scheduledHours: Math.round(scheduledHours * 10) / 10,
      scheduledCost: Math.round(scheduledCost),
    },
    people, hourly, upcoming,
  };
}

module.exports = { build, teamMembers, scheduledShifts };
