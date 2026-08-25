/* HERD — front end.
   No framework, no build step. Views render to string and mount; charts are
   hand-drawn SVG so they inherit the brand tokens rather than a library's. */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  view: localStorage.getItem("herd.view") || "trading",
  range: localStorage.getItem("herd.range") || "today",
  currency: "GBP",
  data: {},
  diaryFrom: null,
};

const RANGES = [
  ["today", "Today"], ["yesterday", "Yesterday"], ["week", "7 days"],
  ["four", "28 days"], ["thirteen", "13 weeks"], ["mtd", "Month"], ["since", "All"],
];

/* ── Formatting ────────────────────────────────────────────── */

const money = (minor, opts = {}) => {
  const v = (minor || 0) / 100;
  return new Intl.NumberFormat("en-GB", {
    style: "currency", currency: state.currency,
    minimumFractionDigits: opts.pence === false ? 0 : (Math.abs(v) >= 1000 || Number.isInteger(v) ? 0 : 2),
    maximumFractionDigits: opts.pence === false ? 0 : 2,
  }).format(v);
};
const compact = minor => {
  const v = (minor || 0) / 100;
  const sign = v < 0 ? "\u2212" : "";
  const a = Math.abs(v);
  if (a >= 1000) return sign + "£" + (a / 1000).toFixed(a >= 10000 ? 0 : 1) + "k";
  return sign + "£" + Math.round(a);
};
const num = n => new Intl.NumberFormat("en-GB").format(n || 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const deltaHTML = (v, suffix = "") => {
  if (v === null || v === undefined) return `<span class="delta flat">—</span>`;
  const cls = v > 0.5 ? "up" : v < -0.5 ? "down" : "flat";
  const arrow = v > 0.5 ? "↑" : v < -0.5 ? "↓" : "→";
  return `<span class="delta ${cls}">${arrow} ${Math.abs(v)}%${suffix}</span>`;
};

const dayLabel = iso => {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
};
const shortDay = iso => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const timeOf = iso => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

const STATUS_LABEL = {
  stockout: "Out of stock", reorder: "Reorder", watch: "Watch", ordered: "On order",
  healthy: "Healthy", overstocked: "Overstocked", dead: "Not moving", idle: "No sales", empty: "Empty",
};
const STATUS_CLASS = {
  stockout: "critical", reorder: "serious", watch: "warning", ordered: "good",
  healthy: "good", overstocked: "warning", dead: "warning", idle: "", empty: "",
};

/* ── Data ──────────────────────────────────────────────────── */

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }));
  if (!res.ok || body.ok === false) {
    const err = new Error(body.message || `HTTP ${res.status}`);
    err.kind = body.error;
    throw err;
  }
  return body;
}

function setLive(kind, text) {
  $("#live-dot").className = "dot" + (kind === "ok" ? "" : " " + kind);
  $("#live-text").textContent = text;
  $("#live").classList.toggle("beat", kind === "ok");
}

function globalBanner(html) {
  $("#global-banner").innerHTML = html || "";
}

/* ── Charts ────────────────────────────────────────────────── */

const tip = $("#tip");
function showTip(host, x, y, html) {
  tip.innerHTML = html;
  const box = host.getBoundingClientRect();
  tip.style.left = (box.left + window.scrollX + x) + "px";
  tip.style.top = (box.top + window.scrollY + y) + "px";
  tip.classList.add("on");
}
const hideTip = () => tip.classList.remove("on");

/**
 * Vertical bar series with a hover layer.
 * One measure, one axis — never two scales on one chart.
 */
function barChart(host, { points, value, label, tipHTML, colour = "var(--c1)", height = 168, highlight }) {
  if (!host) return;                       // the card this belongs to was not rendered
  if (!points.length) { host.innerHTML = `<p class="empty">Nothing here yet.</p>`; return; }

  const W = 800, H = height, padB = 22, padT = 12;
  const max = Math.max(...points.map(value), 1);
  const n = points.length;
  const slot = W / n;
  const bw = Math.max(2, Math.min(slot - 2, slot * 0.72));
  const plot = H - padB - padT;

  // Two soft gridlines are enough to read level without fencing the data in.
  const grid = [0.5, 1].map(f => {
    const y = padT + plot - plot * f;
    return `<line class="grid-line" x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
  }).join("");

  const bars = points.map((p, i) => {
    const v = value(p);
    const h = Math.max(v > 0 ? 2 : 0, (v / max) * plot);
    const x = i * slot + (slot - bw) / 2;
    const y = padT + plot - h;
    const on = highlight && highlight(p, i);
    return `<rect class="bar${on ? " on" : ""}" data-i="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}"
      width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(4, bw / 2).toFixed(1)}"
      fill="${on ? "var(--accent)" : colour}"></rect>`;
  }).join("");

  // Label every nth so they never collide.
  const step = Math.ceil(n / (n > 24 ? 8 : 12));
  const labels = points.map((p, i) => {
    if (i % step !== 0 && i !== n - 1) return "";
    const x = i * slot + slot / 2;
    return `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(label(p, i))}</text>`;
  }).join("");

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(host.dataset.title || "chart")}">
      ${grid}${bars}
      <g class="axis" style="font-size:11px">${labels}</g>
    </svg>`;

  const svg = host.querySelector("svg");
  svg.addEventListener("pointermove", e => {
    const box = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - box.left) / box.width) * n)));
    const p = points[i];
    $$(".bar", svg).forEach((b, j) => b.classList.toggle("on", j === i));
    showTip(host, ((i + 0.5) / n) * host.clientWidth, -6, tipHTML(p, i));
  });
  svg.addEventListener("pointerleave", () => {
    $$(".bar", svg).forEach(b => b.classList.remove("on"));
    hideTip();
  });
}

/** Horizontal ranked bars — the right form for "which of these is biggest". */
function rankedBars(rows, { value, label, sub, colour = "var(--c2)", format = compact, limit = 8 }) {
  const top = rows.slice(0, limit);
  if (!top.length) return `<p class="empty">Nothing here yet.</p>`;
  const max = Math.max(...top.map(value), 1);
  return `<div style="display:flex;flex-direction:column;gap:9px">` + top.map(r => `
    <div>
      <div style="display:flex;justify-content:space-between;gap:10px;font-size:12.5px;margin-bottom:3px">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label(r))}${sub ? ` <span style="color:var(--text-3)">${esc(sub(r))}</span>` : ""}</span>
        <b class="tab-num">${format(value(r))}</b>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, (value(r) / max) * 100).toFixed(1)}%;background:${colour}"></div></div>
    </div>`).join("") + `</div>`;
}

/* ── Trading ───────────────────────────────────────────────── */

function renderTrading(d) {
  state.currency = d.currency || "GBP";
  $("#sitename").textContent = d.business === "HERD" ? "11 Lower Hillgate" : (d.business || "");

  const h = d.headline;
  const byHour = d.range.buckets === "hour";
  const points = byHour ? d.hourly.filter(p => p.hour >= 6 && p.hour <= 22) : d.series;

  const hero = `
    <div class="hero">
      <div class="kicker">${esc(d.range.label)} · net takings</div>
      <div class="hero-figure">${money(h.net)}</div>
      <div class="hero-sub">${deltaHTML(h.change.net)} ${esc(d.range.comparison)}${h.previous ? ` · ${money(h.previous.net)} then` : ""}</div>
      <div class="hero-row" style="margin-top:18px">
        <span class="hero-mini">Sales<b>${num(h.orders)}</b>${deltaHTML(h.change.orders)}</span>
        <span class="hero-mini">Units<b>${num(h.units)}</b>${deltaHTML(h.change.units)}</span>
        <span class="hero-mini">Average sale<b>${money(h.atv)}</b>${deltaHTML(h.change.atv)}</span>
        <span class="hero-mini">Items per sale<b>${(h.upt || 0).toFixed(2)}</b>${deltaHTML(h.change.upt)}</span>
        ${h.discounts ? `<span class="hero-mini">Discounts<b>${money(h.discounts)}</b></span>` : ""}
      </div>
    </div>`;

  const trade = `
    <div class="card">
      <div class="card-head">
        <div><h3>${byHour ? "Through the day" : "Day by day"}</h3>
          <p class="note">${byHour
            ? `Busiest hour ${String(d.peak.hour).padStart(2, "0")}:00`
            : d.peak.day ? `Best day ${dayLabel(d.peak.day)} at ${money(d.peak.dayNet)}` : "&nbsp;"}</p></div>
      </div>
      <div class="chart" id="chart-trade" data-title="Takings ${byHour ? "by hour" : "by day"}"></div>
    </div>`;

  const showWeekday = d.series.length >= 7;
  const weekday = !showWeekday ? "" : `
    <div class="card">
      <div class="card-head"><div><h3>Average by weekday</h3>
        <p class="note">Which days carry the week</p></div></div>
      <div class="chart" id="chart-weekday" data-title="Average takings by weekday"></div>
    </div>`;

  const sellers = `
    <div class="card">
      <div class="card-head"><div><h3>Top sellers</h3><p class="note">By revenue over ${esc(d.range.label.toLowerCase())}</p></div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Product</th><th class="r">Units</th><th class="r">Revenue</th><th class="r">Avg</th><th class="r">Share</th></tr></thead>
          <tbody>${d.lines.slice(0, 14).map(l => `
            <tr>
              <td><div class="name-cell"><span>${esc(l.name)}</span>
                <span class="sub">${esc(l.brand || l.category)}</span></div></td>
              <td class="r">${num(l.units)}</td>
              <td class="r"><b>${money(l.revenue)}</b></td>
              <td class="r">${money(l.avg)}</td>
              <td class="r">${l.share}%</td>
            </tr>`).join("") || `<tr><td colspan="5" class="empty">No sales in this period.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;

  const risers = d.movers.risers.filter(m => m.delta > 0);
  const fallers = d.movers.fallers.filter(m => m.delta < 0);
  const movers = (risers.length || fallers.length) ? `
    <div class="card">
      <div class="card-head"><div><h3>Risers and fallers</h3><p class="note">${esc(d.range.comparison)}</p></div></div>
      <div class="grid k2" style="gap:20px">
        <div>
          <div class="kicker" style="margin-bottom:8px">Rising</div>
          ${risers.length ? risers.map(m => `
            <div style="display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:4px 0">
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name)}</span>
              <span class="delta up">+${compact(m.delta)}</span>
            </div>`).join("") : `<p class="empty">Nothing up.</p>`}
        </div>
        <div>
          <div class="kicker" style="margin-bottom:8px">Fading</div>
          ${fallers.length ? fallers.map(m => `
            <div style="display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:4px 0">
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name)}</span>
              <span class="delta down">${compact(m.delta)}</span>
            </div>`).join("") : `<p class="empty">Nothing down.</p>`}
        </div>
      </div>
    </div>` : "";

  // Brands are read from Square's categories by default, so the two lists
  // are often the same one twice. Show the second only when it differs.
  const sameLists = d.brands.map(b => b.name).join("|") === d.categories.map(c => c.name).join("|");
  const mix = `
    <div class="card">
      <div class="card-head"><div><h3>Where the money came from</h3><p class="note">By brand</p></div></div>
      ${rankedBars(d.brands, { value: r => r.revenue, label: r => r.name, sub: r => `${r.units}u`, colour: "var(--c2)" })}
      ${sameLists ? "" : `
        <div class="card-head" style="margin-top:20px"><div><h3 style="font-size:13px">By category</h3></div></div>
        ${rankedBars(d.categories, { value: r => r.revenue, label: r => r.name, colour: "var(--c3)", limit: 6 })}`}
    </div>`;

  const payment = `
    <div class="card">
      <div class="card-head"><div><h3>How they paid</h3></div></div>
      ${rankedBars(d.cards, { value: r => r.net, label: r => r.name, sub: r => `${r.count}`, colour: "var(--c4)", limit: 5 })}
      <div class="legend"><span>${d.entries.map(e => `${esc(e.name.toLowerCase())} ${e.count}`).join(" · ")}</span></div>
    </div>`;

  const tape = `
    <div class="card">
      <div class="card-head"><div><h3>Latest sales</h3><p class="note">Newest first</p></div></div>
      <div class="tape">${d.tape.length ? d.tape.slice(0, 16).map(t => `
        <div class="tape-row">
          <span>${t.clock}</span>
          <span class="tape-items" title="${esc(t.items.join(", "))}">${esc(t.items.join(", ") || "—")}${t.more ? ` +${t.more}` : ""}</span>
          <b>${money(t.net)}</b>
        </div>`).join("") : `<p class="empty">No sales yet today.</p>`}</div>
    </div>`;

  $("#view-trading").innerHTML = `
    ${d.catalogueProblem ? `<div class="banner warn"><span>⚠</span><span><b>Product detail limited</b>${esc(d.catalogueProblem)}</span></div>` : ""}
    <div class="${showWeekday ? "grid split" : "grid"}" style="margin-bottom:14px">${hero}${weekday}</div>
    <div class="grid" style="margin-bottom:14px">${trade}</div>
    <div class="grid split" style="margin-bottom:14px">${sellers}${mix}</div>
    <div class="grid split">${movers || tape}${movers ? tape : payment}</div>
    ${movers ? `<div class="grid" style="margin-top:14px">${payment}</div>` : ""}`;

  barChart($("#chart-trade"), {
    points,
    value: p => p.net,
    label: p => byHour ? String(p.hour).padStart(2, "0") : shortDay(p.day),
    highlight: p => byHour ? p.hour === d.peak.hour : p.day === d.peak.day,
    tipHTML: p => byHour
      ? `<b>${money(p.net)}</b><div class="t-sub">${String(p.hour).padStart(2, "0")}:00 · ${p.orders} sale${p.orders === 1 ? "" : "s"}</div>`
      : `<b>${money(p.net)}</b><div class="t-sub">${dayLabel(p.day)} · ${p.orders} sale${p.orders === 1 ? "" : "s"} · ${p.units}u</div>`,
    colour: "var(--c1)",
  });

  if (showWeekday) barChart($("#chart-weekday"), {
    points: d.weekdays,
    value: p => p.average,
    label: p => p.name,
    height: 148,
    colour: "var(--c4)",
    tipHTML: p => `<b>${money(p.average)}</b><div class="t-sub">${p.name} average over ${p.days} day${p.days === 1 ? "" : "s"}</div>`,
  });
}

/* ── Stock ─────────────────────────────────────────────────── */

function sizeRun(product) {
  const cls = s => s.onHand <= 0 ? "out" : (s.status === "reorder" || s.status === "watch") ? "low" : "ok";
  const title = s => `${esc(s.label)} — ${s.onHand} on hand, ${s.u28} sold in 28 days`;

  // A one-size product has no run to show; the count on its own is the fact.
  if (product.sizes.length === 1 && !product.sizes[0].size) {
    const only = product.sizes[0];
    return `<div class="sizes"><span class="size ${cls(only)}" title="${title(only)}">${only.onHand} in stock</span></div>`;
  }
  return `<div class="sizes">${product.sizes.map(s =>
    `<span class="size ${cls(s)}" title="${title(s)}">${esc(s.size || "—")}<span class="n">${s.onHand}</span></span>`
  ).join("")}</div>`;
}

function reorderRow(p) {
  const cover = p.daysCover === null ? "—" : `${p.daysCover}d`;
  const urgency = p.daysCover === null ? 0 : Math.max(0, Math.min(1, 1 - p.daysCover / (p.leadTime || 21)));
  return `
    <tr>
      <td>
        <div class="name-cell">
          <span>${esc(p.name)}</span>
          <span class="sub">${esc(p.brand)}${p.brokenRun ? ` · <b style="color:var(--serious)">${esc(p.bestSize)} gone</b>` : ""}</span>
        </div>
      </td>
      <td>${sizeRun(p)}</td>
      <td class="r">${p.perWeek}<span style="color:var(--text-3)">/wk</span>
        ${p.rising ? `<div class="trend rising">↑ accelerating</div>` : p.fading ? `<div class="trend fading">↓ slowing</div>` : ""}</td>
      <td class="r bar-cell">
        <div class="tab-num" style="font-size:12.5px;margin-bottom:3px">${cover}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(urgency * 100).toFixed(0)}%;background:${p.status === "stockout" ? "var(--critical)" : "var(--serious)"}"></div></div>
      </td>
      <td class="r">${p.leadTime}d</td>
      <td class="r"><b>${p.suggested || "—"}</b></td>
      <td class="r">${p.revenueAtRisk ? money(p.revenueAtRisk, { pence: false }) : "—"}</td>
      <td class="r"><span class="pill ${STATUS_CLASS[p.status]}">${STATUS_LABEL[p.status]}</span></td>
      <td class="r"><button class="btn tiny" data-order="${esc(p.id)}">Ordered</button></td>
    </tr>`;
}

function renderStock(d) {
  const host = $("#view-stock");

  if (!d.tracking) {
    host.innerHTML = `<div class="card"><h3>Stock isn't being tracked yet</h3>
      <p class="note" style="margin-top:8px;max-width:60ch;font-size:13.5px;line-height:1.6">${esc(d.note || "")}</p></div>`;
    $("#stock-badge").hidden = true;
    return;
  }

  const s = d.summary;
  $("#stock-badge").hidden = !(s.reorder + s.stockouts);
  $("#stock-badge").textContent = s.reorder + s.stockouts;

  const tiles = `
    <div class="grid k4" style="margin-bottom:14px">
      <div class="card tight"><div class="stat">
        <span class="kicker">Need reordering</span>
        <span class="value" style="color:${s.reorder ? "var(--serious)" : "inherit"}">${s.reorder}</span>
        <span class="meta">${s.stockouts ? `${s.stockouts} wholly out · ` : ""}${s.sizesOut} empty size${s.sizesOut === 1 ? "" : "s"}</span></div></div>
      <div class="card tight"><div class="stat">
        <span class="kicker">Revenue at risk</span>
        <span class="value">${compact(s.atRisk)}</span>
        <span class="meta">while you wait for delivery</span></div></div>
      <div class="card tight"><div class="stat">
        <span class="kicker">Losing per day</span>
        <span class="value" style="color:${s.lostPerDay ? "var(--critical)" : "inherit"}">${compact(s.lostPerDay)}</span>
        <span class="meta">from sizes already sold out</span></div></div>
      <div class="card tight"><div class="stat">
        <span class="kicker">Stock on hand</span>
        <span class="value">${compact(s.stockValue)}</span>
        <span class="meta">${num(s.unitsOnHand)} units · ${s.products} products</span></div></div>
    </div>`;

  const reorderTable = `
    <div class="card" style="margin-bottom:14px">
      <div class="card-head">
        <div><h3>Reorder list</h3>
          <p class="note">Ranked by what the gap costs, not by how few are left. Cover is stock ÷ how fast it's actually selling; a line flags when cover falls inside the brand's lead time plus ${d.settings.safetyDays} days' safety.</p></div>
        <button class="btn tiny" id="lead-times">Lead times</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Product</th><th>Size run</th><th class="r">Selling</th><th class="r">Cover</th>
            <th class="r">Lead</th><th class="r">Order</th><th class="r">At risk</th><th class="r">Status</th><th></th>
          </tr></thead>
          <tbody>${d.reorder.length ? d.reorder.map(reorderRow).join("")
            : `<tr><td colspan="9" class="empty">Nothing needs reordering. Every line selling has cover beyond its lead time.</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;

  const rising = `
    <div class="card">
      <div class="card-head"><div><h3>Accelerating</h3>
        <p class="note">Selling faster this week than the last four. Still covered — but these become the reorder list.</p></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Product</th><th class="r">7d</th><th class="r">Trend</th><th class="r">Cover</th><th class="r">Order</th><th></th></tr></thead>
        <tbody>${d.rising.length ? d.rising.slice(0, 10).map(p => `
          <tr>
            <td><div class="name-cell"><span>${esc(p.name)}</span><span class="sub">${esc(p.brand)}</span></div></td>
            <td class="r">${p.u7}</td>
            <td class="r"><span class="trend rising">↑ ${(p.trend || 1).toFixed(1)}×</span></td>
            <td class="r">${p.daysCover ?? "—"}d</td>
            <td class="r">${p.suggested || "—"}</td>
            <td class="r"><button class="btn tiny" data-order="${esc(p.id)}">Ordered</button></td>
          </tr>`).join("") : `<tr><td colspan="6" class="empty">Nothing is accelerating this week.</td></tr>`}
        </tbody></table></div>
    </div>`;

  const broken = `
    <div class="card">
      <div class="card-head"><div><h3>Broken size runs</h3>
        <p class="note">The best-selling size is gone while others remain. The rail looks stocked and sells nothing.</p></div></div>
      ${d.broken.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Product</th><th>Remaining</th><th class="r">Missing</th></tr></thead>
        <tbody>${d.broken.slice(0, 10).map(p => `
          <tr>
            <td><div class="name-cell"><span>${esc(p.name)}</span><span class="sub">${esc(p.brand)}</span></div></td>
            <td>${sizeRun(p)}</td>
            <td class="r"><span class="pill critical">${esc(p.sizesOut.join(" · "))}</span></td>
          </tr>`).join("")}</tbody></table></div>`
        : `<p class="empty">No broken runs — every product's best size is in stock.</p>`}
    </div>`;

  const movers = `
    <div class="card">
      <div class="card-head"><div><h3>What's actually selling</h3><p class="note">Last 28 days by revenue — the input the reorder list is derived from</p></div></div>
      ${rankedBars(d.movers, { value: r => r.r28, label: r => r.name, sub: r => `${r.u28}u`, colour: "var(--c1)", limit: 10 })}
    </div>`;

  const markdown = `
    <div class="card">
      <div class="card-head"><div><h3>Consider marking down</h3>
        <p class="note">Capital sitting still — over ${d.settings.overstockDays} days of cover, fading, or not selling at all</p></div></div>
      ${d.markdown.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Product</th><th class="r">On hand</th><th class="r">28d</th><th class="r">Tied up</th></tr></thead>
        <tbody>${d.markdown.slice(0, 12).map(p => `
          <tr>
            <td><div class="name-cell"><span>${esc(p.name)}</span><span class="sub">${esc(p.brand)}</span></div></td>
            <td class="r">${p.onHand}</td><td class="r">${p.u28}</td>
            <td class="r"><b>${money(p.stockValue, { pence: false })}</b></td>
          </tr>`).join("")}</tbody></table></div>`
        : `<p class="empty">Nothing stagnant.</p>`}
    </div>`;

  const onOrder = d.purchaseOrders.filter(po => po.status === "open");
  const orders = `
    <div class="card">
      <div class="card-head"><div><h3>On order</h3><p class="note">Marked as ordered here — each one lands in the diary on its expected date</p></div></div>
      ${onOrder.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Product</th><th class="r">Qty</th><th class="r">Raised</th><th class="r">Expected</th><th></th></tr></thead>
        <tbody>${onOrder.map(po => `
          <tr>
            <td><div class="name-cell"><span>${esc(po.label)}</span><span class="sub">${esc(po.brand)}</span></div></td>
            <td class="r">${po.qty || "—"}</td>
            <td class="r">${shortDay(po.raised.slice(0, 10))}</td>
            <td class="r"><b>${shortDay(po.expected)}</b></td>
            <td class="r">
              <button class="btn tiny" data-received="${esc(po.id)}">Arrived</button>
              <button class="btn tiny ghost" data-cancel="${esc(po.id)}">Cancel</button>
            </td>
          </tr>`).join("")}</tbody></table></div>`
        : `<p class="empty">Nothing on order.</p>`}
    </div>`;

  host.innerHTML =
    (!d.persistent ? `<div class="banner warn"><span>⚠</span><span><b>Lead times and orders won't survive a restart</b>No writable disk is attached, so anything you set here is lost on the next deploy. Attach a Render disk at /var/data to fix it.</span></div>` : "")
    + tiles + reorderTable
    + `<div class="grid split" style="margin-bottom:14px">${rising}${movers}</div>`
    + `<div class="grid split" style="margin-bottom:14px">${broken}${markdown}</div>`
    + orders;

  wireStock(d);
}

function wireStock(d) {
  const index = new Map();
  for (const bucket of ["reorder", "rising", "watch", "broken", "markdown", "newIn"]) {
    for (const p of d[bucket] || []) index.set(p.id, p);
  }

  $$("[data-order]").forEach(btn => btn.addEventListener("click", () => {
    const p = index.get(btn.dataset.order);
    if (p) openOrderDialog(p);
  }));

  $$("[data-received]").forEach(btn => btn.addEventListener("click", async () => {
    await api(`/api/stock/purchase-order/${encodeURIComponent(btn.dataset.received)}`, {
      method: "PATCH", body: JSON.stringify({ status: "received" }),
    });
    load(true);
  }));

  $$("[data-cancel]").forEach(btn => btn.addEventListener("click", async () => {
    await api(`/api/stock/purchase-order/${encodeURIComponent(btn.dataset.cancel)}`, { method: "DELETE" });
    load(true);
  }));

  const lead = $("#lead-times");
  if (lead) lead.addEventListener("click", () => openLeadTimes(d));
}

function openOrderDialog(p) {
  dialog({
    title: `Mark as ordered`,
    body: `
      <p style="font-size:13.5px;color:var(--text-2);margin:0">${esc(p.name)} — ${esc(p.brand)}</p>
      <div class="field"><label class="lbl" for="o-qty">Quantity</label>
        <input id="o-qty" type="number" min="0" value="${p.suggested || 0}"></div>
      <div class="field"><label class="lbl" for="o-lead">Arriving in (days)</label>
        <input id="o-lead" type="number" min="0" value="${p.leadTime}"></div>
      <div class="field"><label class="lbl" for="o-note">Note</label>
        <input id="o-note" type="text" placeholder="Optional — PO number, contact"></div>
      <p class="note">This stops the alerts for this line and puts an expected delivery in the diary.</p>`,
    confirm: "Mark ordered",
    onConfirm: async () => {
      await api("/api/stock/purchase-order", {
        method: "POST",
        body: JSON.stringify({
          productId: p.id,
          variationIds: p.sizes.map(s => s.id),
          brand: p.brand, label: p.name,
          qty: Number($("#o-qty").value || 0),
          leadDays: Number($("#o-lead").value || p.leadTime),
          note: $("#o-note").value,
        }),
      });
      load(true);
    },
  });
}

function openLeadTimes(d) {
  const brands = [...new Set([...d.reorder, ...d.rising, ...d.markdown, ...d.movers].map(p => p.brand))].sort();
  const table = d.settings.leadTimes;
  dialog({
    title: "Lead times",
    body: `
      <p class="note" style="margin:0">How long each brand takes to deliver. This is what decides when a line flags — a fast-selling piece from a slow brand needs reordering far earlier.</p>
      <div class="field"><label class="lbl" for="lt-default">Default (days)</label>
        <input id="lt-default" type="number" min="0" value="${table.default}"></div>
      ${brands.slice(0, 20).map((b, i) => `
        <div class="field"><label class="lbl" for="lt-${i}">${esc(b)}</label>
          <input id="lt-${i}" data-brand="${esc(b)}" type="number" min="0" placeholder="${table.default}" value="${table.brands?.[b] ?? ""}"></div>`).join("")}`,
    confirm: "Save",
    onConfirm: async () => {
      await api("/api/stock/lead-time", { method: "POST", body: JSON.stringify({ brand: "__default__", days: Number($("#lt-default").value) }) });
      for (const input of $$("[data-brand]")) {
        await api("/api/stock/lead-time", {
          method: "POST",
          body: JSON.stringify({ brand: input.dataset.brand, days: input.value === "" ? null : Number(input.value) }),
        });
      }
      load(true);
    },
  });
}

/* ── Team ──────────────────────────────────────────────────── */

function renderTeam(d) {
  const s = d.summary;

  const tiles = `
    <div class="grid k4" style="margin-bottom:14px">
      <div class="card tight"><div class="stat"><span class="kicker">Hours worked</span>
        <span class="value">${s.hours}</span><span class="meta">${s.shifts} shifts · ${s.active} on the team</span></div></div>
      <div class="card tight"><div class="stat"><span class="kicker">Labour cost</span>
        <span class="value">${compact(s.cost)}</span><span class="meta">${s.labourRatio !== null ? s.labourRatio + "% of takings" : "no takings to compare"}</span></div></div>
      <div class="card tight"><div class="stat"><span class="kicker">Takings per hour</span>
        <span class="value">${s.salesPerHour !== null ? money(s.salesPerHour, { pence: false }) : "—"}</span>
        <span class="meta">per hour actually worked</span></div></div>
      <div class="card tight"><div class="stat"><span class="kicker">Rostered ahead</span>
        <span class="value">${s.scheduledHours}</span><span class="meta">${compact(s.scheduledCost)} of wages, next 2 weeks</span></div></div>
    </div>`;

  const people = `
    <div class="card">
      <div class="card-head"><div><h3>By person</h3>
        <p class="note">Sales are credited to whoever rang them through — that's who was on the till, not necessarily who sold the coat.</p></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Role</th><th class="r">Hours</th><th class="r">Cost</th>
          <th class="r">Takings</th><th class="r">Per hour</th><th class="r">Avg sale</th><th class="r">Items/sale</th></tr></thead>
        <tbody>${d.people.length ? d.people.map(p => `
          <tr>
            <td><div class="name-cell"><span>${esc(p.name)}${p.isOwner ? ` <span class="pill">owner</span>` : ""}</span>
              ${p.status !== "ACTIVE" ? `<span class="sub">inactive</span>` : ""}</div></td>
            <td style="color:var(--text-3);font-size:12.5px">${esc(p.job || "—")}</td>
            <td class="r">${p.hours || "—"}</td>
            <td class="r">${p.cost ? money(p.cost, { pence: false }) : "—"}</td>
            <td class="r"><b>${p.net ? money(p.net) : "—"}</b></td>
            <td class="r">${p.perHour !== null ? money(p.perHour, { pence: false }) : "—"}</td>
            <td class="r">${p.atv !== null ? money(p.atv) : "—"}</td>
            <td class="r">${p.upt !== null ? p.upt.toFixed(1) : "—"}</td>
          </tr>`).join("") : `<tr><td colspan="8" class="empty">No one clocked in during this period.</td></tr>`}
        </tbody></table></div>
    </div>`;

  // Two measures of different scale, so two charts sharing one x-axis —
  // never two y-scales on one plot.
  const coverage = `
    <div class="card">
      <div class="card-head"><div><h3>Cover against trade</h3>
        <p class="note">Hours staffed and takings, hour by hour. A staffed hour with no takings is the cheapest thing on a rota to fix.</p></div></div>
      <div class="chart" id="chart-hours" data-title="Hours staffed by hour"></div>
      <div class="legend"><span><span class="swatch" style="background:var(--c4)"></span>Hours staffed</span></div>
      <div class="chart" id="chart-hsales" style="margin-top:12px" data-title="Takings by hour"></div>
      <div class="legend"><span><span class="swatch" style="background:var(--c1)"></span>Takings</span></div>
    </div>`;

  const rotaDays = new Map();
  for (const shift of d.upcoming) {
    if (!rotaDays.has(shift.day)) rotaDays.set(shift.day, []);
    rotaDays.get(shift.day).push(shift);
  }

  const rota = `
    <div class="card">
      <div class="card-head"><div><h3>Rota ahead</h3>
        <p class="note">Published shifts from Square, next two weeks</p></div></div>
      ${rotaDays.size ? [...rotaDays.entries()].slice(0, 14).map(([day, shifts]) => `
        <div style="display:flex;gap:14px;padding:8px 0;border-bottom:1px solid var(--rule-soft)">
          <div style="min-width:92px;font-size:12.5px"><b>${dayLabel(day)}</b></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;flex:1">
            ${shifts.map(sh => `<span class="pill${sh.published ? "" : " warning"}" title="${esc(sh.job)}">${esc(sh.name)} ${sh.from}–${sh.to}</span>`).join("")}
          </div>
          <div style="font-size:12px;color:var(--text-3)">${shifts.reduce((a, b) => a + b.hours, 0).toFixed(1)}h</div>
        </div>`).join("") : `<p class="empty">No shifts scheduled. Build the rota in Square under Staff → Shifts.</p>`}
    </div>`;

  $("#view-team").innerHTML =
    (d.problems.length ? `<div class="banner warn"><span>⚠</span><span>${d.problems.map(esc).join("<br>")}</span></div>` : "")
    + tiles + `<div class="grid split" style="margin-bottom:14px">${people}${coverage}</div>` + rota;

  if (d.hourly.length) {
    barChart($("#chart-hours"), {
      points: d.hourly, value: p => p.staffed, height: 110, colour: "var(--c4)",
      label: p => String(p.hour).padStart(2, "0"),
      tipHTML: p => `<b>${p.staffed}h staffed</b><div class="t-sub">${String(p.hour).padStart(2, "0")}:00${p.perStaffHour !== null ? ` · ${money(p.perStaffHour, { pence: false })} per staff hour` : ""}</div>`,
    });
    barChart($("#chart-hsales"), {
      points: d.hourly, value: p => p.net, height: 110, colour: "var(--c1)",
      label: p => String(p.hour).padStart(2, "0"),
      tipHTML: p => `<b>${money(p.net)}</b><div class="t-sub">${String(p.hour).padStart(2, "0")}:00 · ${p.staffed}h staffed</div>`,
    });
  }
}

/* ── Diary ─────────────────────────────────────────────────── */

const todayISO = () => new Date().toISOString().slice(0, 10);

function renderDiary(d) {
  const badge = $("#diary-badge");
  badge.hidden = !d.counts.overdueDeliveries;
  badge.textContent = d.counts.overdueDeliveries;

  const head = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    .map(n => `<div class="cal-head">${n}</div>`).join("");

  const cells = d.days.map(day => {
    const isToday = day.day === todayISO();
    const past = day.day < todayISO();
    const chips = [
      ...day.rota.map(r => `<button class="chip rota${r.published ? "" : " draft"}" data-shift title="${esc(r.job)}">${esc(r.initials)} <span class="who">${r.from}–${r.to}</span></button>`),
      ...day.deliveries.map(x => `<span class="chip delivery${x.overdue ? " overdue" : ""}">📦 ${esc(x.title)}${x.qty ? ` <span class="who">×${x.qty}</span>` : ""}</span>`),
      ...day.events.map(e => `<button class="chip event" data-edit="${esc(e.id)}">${esc(e.title)}${e.time ? ` <span class="who">${esc(e.time)}</span>` : ""}</button>`),
      ...day.social.map(e => `<button class="chip social${e.stage === "published" ? "" : " draft"}" data-edit="${esc(e.id)}">${esc(e.title)} <span class="who">${esc(e.channel || e.stage)}</span></button>`),
    ].join("");

    return `<div class="cell${isToday ? " today" : ""}${past ? " past" : ""}">
      <div class="cell-date">
        <span class="d">${Number(day.day.slice(8))}</span>
        ${day.hours ? `<span class="h">${day.hours}h</span>` : ""}
      </div>
      ${chips}
      <button class="chip" data-add="${day.day}" style="border-left-color:transparent;background:transparent;color:var(--text-3);text-align:center">+</button>
    </div>`;
  }).join("");

  // Pad the first week so the 1st lands under the right weekday.
  const firstIdx = (new Date(d.days[0].day + "T12:00:00Z").getUTCDay() + 6) % 7;
  const pad = Array.from({ length: firstIdx }, () => `<div></div>`).join("");

  $("#view-diary").innerHTML = `
    ${!d.persistent ? `<div class="banner warn"><span>⚠</span><span><b>Diary entries won't survive a restart</b>Attach a Render disk at /var/data to keep them.</span></div>` : ""}
    <div class="card" style="margin-bottom:14px">
      <div class="card-head">
        <div><h3>${shortDay(d.from)} — ${shortDay(d.to)}</h3>
          <p class="note">${plural(d.counts.shifts, "shift")} · ${plural(d.counts.social, "post")} · ${plural(d.counts.events, "event")} · ${plural(d.counts.deliveries, "delivery", "deliveries")}${d.counts.overdueDeliveries ? ` · <b style="color:var(--critical)">${d.counts.overdueDeliveries} overdue</b>` : ""}</p></div>
        <div style="display:flex;gap:6px">
          <button class="btn tiny" id="cal-prev">←</button>
          <button class="btn tiny" id="cal-today">Today</button>
          <button class="btn tiny" id="cal-next">→</button>
          <button class="btn tiny primary" id="cal-add">Add</button>
        </div>
      </div>
      <div class="cal">${head}${pad}${cells}</div>
      <div class="legend" style="margin-top:14px">
        <span><span class="swatch" style="background:var(--c4)"></span>Rota <span style="color:var(--text-3)">(dashed = unpublished)</span></span>
        <span><span class="swatch" style="background:var(--c5)"></span>Social</span>
        <span><span class="swatch" style="background:var(--c1)"></span>Events</span>
        <span><span class="swatch" style="background:var(--c3)"></span>Deliveries</span>
      </div>
    </div>`;

  $("#cal-prev").onclick = () => { state.diaryFrom = shiftDays(d.from, -28); load(true); };
  $("#cal-next").onclick = () => { state.diaryFrom = shiftDays(d.from, 28); load(true); };
  $("#cal-today").onclick = () => { state.diaryFrom = null; load(true); };
  $("#cal-add").onclick = () => openEntry({ day: todayISO() }, d);

  $$("[data-add]").forEach(b => b.onclick = () => openEntry({ day: b.dataset.add }, d));
  $$("[data-edit]").forEach(b => b.onclick = () => {
    const all = d.days.flatMap(x => [...x.social, ...x.events]);
    const entry = all.find(e => e.id === b.dataset.edit);
    if (entry) openEntry(entry, d);
  });
}

const shiftDays = (iso, n) => {
  const dt = new Date(iso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

function openEntry(entry, d) {
  const editing = Boolean(entry.id);
  dialog({
    title: editing ? "Edit entry" : "Add to the diary",
    body: `
      <div class="field"><label class="lbl" for="e-type">Type</label>
        <select id="e-type">
          <option value="social"${entry.type === "social" ? " selected" : ""}>Social post</option>
          <option value="event"${entry.type !== "social" ? " selected" : ""}>Event</option>
        </select></div>
      <div class="field"><label class="lbl" for="e-title">Title</label>
        <input id="e-title" type="text" value="${esc(entry.title || "")}" placeholder="Shop edit shoot, brand drop, late opening…"></div>
      <div class="grid k2" style="gap:10px">
        <div class="field"><label class="lbl" for="e-day">Date</label>
          <input id="e-day" type="date" value="${esc(entry.day || todayISO())}"></div>
        <div class="field"><label class="lbl" for="e-time">Time</label>
          <input id="e-time" type="time" value="${esc(entry.time || "")}"></div>
      </div>
      <div class="grid k2" style="gap:10px">
        <div class="field"><label class="lbl" for="e-channel">Channel</label>
          <select id="e-channel"><option value="">—</option>
            ${d.channels.map(c => `<option${entry.channel === c ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
        <div class="field"><label class="lbl" for="e-stage">Stage</label>
          <select id="e-stage">${d.stages.map(s => `<option value="${s}"${entry.stage === s ? " selected" : ""}>${s}</option>`).join("")}</select></div>
      </div>
      <div class="field"><label class="lbl" for="e-notes">Notes</label>
        <textarea id="e-notes" placeholder="Caption, brief, who's covering it">${esc(entry.notes || "")}</textarea></div>`,
    confirm: editing ? "Save" : "Add",
    destructive: editing ? "Delete" : null,
    onDestructive: async () => { await api(`/api/diary/${entry.id}`, { method: "DELETE" }); load(true); },
    onConfirm: async () => {
      const payload = {
        type: $("#e-type").value, title: $("#e-title").value,
        day: $("#e-day").value, time: $("#e-time").value,
        channel: $("#e-channel").value, stage: $("#e-stage").value,
        notes: $("#e-notes").value,
      };
      if (editing) await api(`/api/diary/${entry.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await api("/api/diary", { method: "POST", body: JSON.stringify(payload) });
      load(true);
    },
  });
}

/* ── Alerts ────────────────────────────────────────────────── */

function renderAlerts(d) {
  const s = d.status;
  const on = s.channels.length;

  $("#view-alerts").innerHTML = `
    <div class="grid split" style="margin-bottom:14px">
      <div class="card">
        <div class="card-head"><div><h3>Notifications</h3>
          <p class="note">${on ? `Going to ${s.channels.join(", ")}` : "No channel configured — alerts only appear here"}</p></div>
          <button class="btn tiny" id="test-alert">Send test</button></div>
        <table>
          <tbody>
            <tr><td>Delivery</td><td class="r">${s.webhook
              ? `<span class="pill good">Square webhook — instant</span>`
              : `<span class="pill warning">Polling — up to a minute behind</span>`}</td></tr>
            <tr><td>Every sale</td><td class="r">${s.alerts.sales ? `<span class="pill good">on</span>` : `<span class="pill">off</span>`}</td></tr>
            <tr><td>Reorder alerts</td><td class="r">${s.alerts.reorder ? `<span class="pill good">on</span>` : `<span class="pill">off</span>`}</td></tr>
            <tr><td>Daily close summary</td><td class="r">${s.alerts.daily ? `<span class="pill good">on at ${String(s.closeHour).padStart(2, "0")}:00</span>` : `<span class="pill">off</span>`}</td></tr>
            <tr><td>Daily target</td><td class="r">${s.dailyTarget ? money(s.dailyTarget, { pence: false }) : `<span class="pill">not set</span>`}</td></tr>
            <tr><td>Minimum sale to alert</td><td class="r">${s.saleFloor ? money(s.saleFloor, { pence: false }) : "every sale"}</td></tr>
          </tbody>
        </table>
        ${!s.webhook ? `<p class="note" style="margin-top:14px;line-height:1.6">For instant alerts, add a webhook in Square (Developer → Webhooks) pointing at <code>/webhooks/square</code> for <code>payment.created</code>, then set <code>SQUARE_WEBHOOK_SIGNATURE_KEY</code> and <code>SQUARE_WEBHOOK_URL</code>.</p>` : ""}
      </div>

      <div class="card">
        <div class="card-head"><div><h3>Recent alerts</h3><p class="note">Live — new ones appear without a refresh</p></div></div>
        <div id="feed">${d.feed.length ? d.feed.map(feedItem).join("") : `<p class="empty">Nothing yet.</p>`}</div>
      </div>
    </div>`;

  $("#test-alert").onclick = async () => {
    const btn = $("#test-alert");
    btn.disabled = true; btn.textContent = "Sending…";
    try { await api("/api/alerts/test", { method: "POST" }); btn.textContent = "Sent"; }
    catch { btn.textContent = "Failed"; }
    setTimeout(() => { btn.disabled = false; btn.textContent = "Send test"; }, 2000);
  };
}

const feedItem = a => `
  <div class="feed-item">
    <span class="feed-time">${timeOf(a.at)}</span>
    <span><b>${esc(a.title)}</b><br><span style="color:var(--text-3)">${esc(a.body).replace(/\n/g, "<br>")}</span></span>
  </div>`;

/* ── Dialog ────────────────────────────────────────────────── */

function dialog({ title, body, confirm, onConfirm, destructive, onDestructive }) {
  const dlg = $("#dlg");
  $("#dlg-body").innerHTML = `<h3>${esc(title)}</h3>${body}`;
  $("#dlg-foot").innerHTML =
    (destructive ? `<button type="button" class="btn ghost" id="dlg-del" style="margin-right:auto;color:var(--critical)">${esc(destructive)}</button>` : "")
    + `<button type="button" class="btn ghost" id="dlg-cancel">Cancel</button>`
    + `<button type="button" class="btn primary" id="dlg-ok">${esc(confirm)}</button>`;

  const close = () => dlg.close();
  $("#dlg-cancel").onclick = close;
  $("#dlg-ok").onclick = async () => {
    const btn = $("#dlg-ok");
    btn.disabled = true;
    try { await onConfirm(); close(); }
    catch (err) { btn.disabled = false; alert(err.message); }
  };
  if (destructive) $("#dlg-del").onclick = async () => { await onDestructive(); close(); };

  dlg.showModal();
}

/* ── Shell ─────────────────────────────────────────────────── */

function renderRanges() {
  $("#ranges").innerHTML = RANGES.map(([key, label]) =>
    `<button class="range" data-range="${key}" aria-pressed="${key === state.range}">${label}</button>`).join("");
  $$("[data-range]").forEach(b => b.onclick = () => {
    state.range = b.dataset.range;
    localStorage.setItem("herd.range", state.range);
    renderRanges(); load(true);
  });
  // Ranges only mean something on the two time-based tabs.
  $("#ranges").style.display = (state.view === "trading" || state.view === "team") ? "" : "none";
}

function selectView(view) {
  state.view = view;
  try { localStorage.setItem("herd.view", view); } catch {}
  $$(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.view === view)));
  $$("main section").forEach(s => s.hidden = s.id !== `view-${view}`);
  renderRanges();
  load();
}

async function load(force = false) {
  const view = state.view;
  const key = `${view}:${state.range}:${state.diaryFrom || ""}`;
  if (!force && state.data[key]) return;

  const host = $(`#view-${view}`);
  if (!host.innerHTML.trim()) {
    host.innerHTML = `<div class="grid k4">${"<div class='card tight'><div class='skeleton' style='height:56px'></div></div>".repeat(4)}</div>`;
  }

  try {
    let d;
    if (view === "trading") d = await api(`/api/overview?range=${state.range}`);
    else if (view === "stock") d = await api(`/api/stock${force ? "?refresh=1" : ""}`);
    else if (view === "team") d = await api(`/api/team?range=${state.range}`);
    else if (view === "diary") d = await api(`/api/diary${state.diaryFrom ? `?from=${state.diaryFrom}&to=${shiftDays(state.diaryFrom, 27)}` : ""}`);
    else if (view === "alerts") d = await api(`/api/alerts`);

    state.data[key] = d;
    globalBanner("");
    setLive("ok", "Live");

    if (view === "trading") renderTrading(d);
    else if (view === "stock") renderStock(d);
    else if (view === "team") renderTeam(d);
    else if (view === "diary") renderDiary(d);
    else if (view === "alerts") renderAlerts(d);
  } catch (err) {
    setLive("down", "Offline");
    const fix = {
      square_auth: "The Square access token was rejected. Regenerate it in the Square developer dashboard and update SQUARE_ACCESS_TOKEN.",
      square_scope: "This token is missing a permission. Reauthorise it with Items, Inventory, Orders, Employees and Timecards read access.",
      network: "Square couldn't be reached. This usually clears on its own.",
    }[err.kind];
    globalBanner(`<div class="banner bad"><span>✕</span><span><b>${esc(err.message)}</b>${fix ? esc(fix) : ""}</span></div>`);
  }
}

/* Background refresh: quiet, and only for the tab you're looking at. */
function startPolling() {
  setInterval(() => {
    if (document.hidden) return;
    if (state.view === "trading" || state.view === "alerts") load(true);
  }, 60000);

  try {
    const stream = new EventSource("/api/stream");
    stream.addEventListener("alert", e => {
      const record = JSON.parse(e.data);
      const feed = $("#feed");
      if (feed) feed.insertAdjacentHTML("afterbegin", feedItem(record));
      if (state.view === "trading") load(true);
      if (state.view === "stock" && /reorder|out of stock/i.test(record.title)) load(true);
    });
    stream.onerror = () => setLive("stale", "Reconnecting");
    stream.onopen = () => setLive("ok", "Live");
  } catch {}
}

function initTheme() {
  const saved = localStorage.getItem("herd.theme");
  if (saved) document.documentElement.dataset.theme = saved;
  $("#theme-toggle").onclick = () => {
    const now = document.documentElement.dataset.theme;
    const next = now === "dark" ? "light" : now === "light" ? "" : "dark";
    if (next) document.documentElement.dataset.theme = next;
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem("herd.theme", next); } catch {}
    load(true);
  };
}

$$(".tab").forEach(t => t.onclick = () => selectView(t.dataset.view));
initTheme();
renderRanges();
selectView(state.view);
startPolling();
