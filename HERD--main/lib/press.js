/**
 * Press week — the call sheet, the checklist and the press pack, shared.
 *
 * One JSON document held in the same store as lead times and the diary, so
 * whoever opens /press sees the same ticks, owners, statuses and notes as
 * everyone else. There is no per-person state and no accounts: the app's
 * password is the door, and past it everybody edits the same page.
 *
 * Writes carry the revision the client last saw. If it has moved on, the
 * write is refused and the current document handed back instead of silently
 * overwriting somebody mid-sentence. Last save wins, but nobody loses work
 * without being told.
 */

const store = require("./store");

const KEY = "press-week";

const BLANK = {
  rev: 0,
  updatedAt: null,
  state: { checks: {}, owners: {}, outreach: {}, extra: [], coverage: [] },
};

/* Guards against a malformed or hostile body reaching the disk. Shape only —
   the contents are the team's own notes and are stored as written. */
function clean(state) {
  const s = state && typeof state === "object" ? state : {};
  const obj = v => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const arr = v => (Array.isArray(v) ? v.slice(0, 200) : []);
  return {
    checks: obj(s.checks),
    owners: obj(s.owners),
    outreach: obj(s.outreach),
    extra: arr(s.extra),
    coverage: arr(s.coverage),
  };
}

function read() {
  const doc = store.read(KEY, BLANK);
  return { rev: doc.rev || 0, updatedAt: doc.updatedAt || null, state: clean(doc.state) };
}

/* Returns { ok: true, rev } on success, or { ok: false, current } when the
   client was working from a revision somebody else has already replaced. */
function save(rev, state) {
  const current = read();
  if (Number(rev) !== current.rev) return { ok: false, current };

  const next = {
    rev: current.rev + 1,
    updatedAt: new Date().toISOString(),
    state: clean(state),
  };
  store.write(KEY, next);
  return { ok: true, rev: next.rev, updatedAt: next.updatedAt };
}

module.exports = { read, save };
