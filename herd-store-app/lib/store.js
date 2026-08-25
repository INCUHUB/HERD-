/**
 * Small JSON store for the things Square doesn't hold: brand lead times,
 * purchase orders you've raised, the diary, and which alerts have already
 * been sent.
 *
 * Writes are atomic (write to a temp file, then rename) so a restart
 * mid-write can't leave a half-written file behind.
 *
 * On Render, a service's filesystem is wiped on every deploy unless a disk
 * is attached. render.yaml attaches one at /var/data and points DATA_DIR at
 * it. Without a disk this still works — you just lose lead times, POs and
 * the diary on each deploy, and the app says so on the Stock tab.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");

let persistent = true;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const probe = path.join(DATA_DIR, ".writable");
  fs.writeFileSync(probe, "1");
  fs.unlinkSync(probe);
} catch (err) {
  persistent = false;
  console.warn(`[herd] ${DATA_DIR} is not writable — lead times, purchase orders and the diary will not survive a restart.`);
}

const memory = new Map();

function file(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function read(name, fallback) {
  if (!persistent) return memory.has(name) ? memory.get(name) : structuredClone(fallback);
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function write(name, value) {
  if (!persistent) { memory.set(name, value); return value; }
  const target = file(name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
  return value;
}

function update(name, fallback, mutate) {
  const current = read(name, fallback);
  const next = mutate(current) ?? current;
  return write(name, next);
}

/* Whether this deployment will remember anything across a restart. The
   UI shows a quiet warning when it won't, rather than silently losing
   a week of purchase orders. */
const isPersistent = () => persistent;
const location = () => DATA_DIR;

module.exports = { read, write, update, isPersistent, location };
