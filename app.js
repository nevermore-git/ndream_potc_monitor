"use strict";
/* POTC Server Monitor - read-only static viewer.
   List view fetches status.json (all servers); detail view (#s/<num>) fetches detail/<num>.json
   (current stats + 24h CCU/FPS history + server-filtered event log), both written by the bridge
   (monitor_client.py). On GitHub Pages it reads via the UNauthenticated GitHub contents API (no
   token); on localhost it falls back to same-origin mock files. No dependencies. */

const REFRESH_MS = 90000;          // unauthenticated GitHub API = 60 req/hr -> poll every 90s (40/hr)
const STALE_SEC = 240;             // older than this -> flag the timestamp (bridge likely stopped)
const MIN_GAP_MS = 8000;           // min gap between event-driven refetches (one resume fires several events)
const CACHE_KEY = "poc.cache.v1";  // localStorage: last good payload per file (instant cold-open + offline)
const CACHE_MAX = 16;              // cap cached files (status.json always kept; oldest details evicted)
const PIN_KEY = "poc.pinned.v1";
const RANGE_KEY = "poc.range.v1";
const CUSTOM_KEY = "poc.customRange.v1";   // custom trend window {from,to} (epoch sec) when range === "custom"
const ACK_KEY = "poc.ackAlerts.v1";   // dismissed alert ids (per-episode); banner hides these

const state = {
  data: null,                      // status.json (list)
  detail: null,                    // detail/<num>.json (detail view)
  sortKey: "num",
  sortDir: { num: 1, ccu: -1, fps_avg: -1 },
  filter: "",
  pinned: loadPinned(),
  range: loadRange(),              // selected trend/event window (persisted): a RANGES key or "custom"
  custom: loadCustom(),            // {from,to} epoch-sec for the "Custom" range (persisted)
  fetching: false,                 // single-flight guard
  pending: false,                  // a fetch was requested mid-flight (e.g. route change) -> re-run
  lastFetch: 0,
  rlUntil: 0,                      // epoch ms the API is rate-limited until; while inside, we serve via raw CDN
};
if (state.range === "custom" && !state.custom) state.range = "3h";   // stored "custom" with no window -> fall back

function loadPinned() {
  try { return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || "[]")); }
  catch { return new Set(); }
}
function savePinned() {
  try { localStorage.setItem(PIN_KEY, JSON.stringify([...state.pinned])); } catch {}
}
function loadRange() { try { return localStorage.getItem(RANGE_KEY) || "3h"; } catch { return "3h"; } }
function loadCustom() {
  try { const v = JSON.parse(localStorage.getItem(CUSTOM_KEY) || "null");
    return (v && Number.isFinite(v.from) && Number.isFinite(v.to)) ? v : null; } catch { return null; }
}
function saveCustom() { try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(state.custom)); } catch {} }
function loadAck() { try { return new Set(JSON.parse(localStorage.getItem(ACK_KEY) || "[]")); } catch { return new Set(); } }
function saveAck(s) { try { localStorage.setItem(ACK_KEY, JSON.stringify([...s])); } catch {} }

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function fmtNum(v) { return v == null ? "–" : v.toLocaleString(); }
function fmtMem(kb) {                                  // used_memory is ~KB on the wire (verify vs Monitor)
  if (kb == null) return "–";
  if (kb >= 1048576) return (kb / 1048576).toFixed(1) + " GB";
  if (kb >= 1024) return Math.round(kb / 1024) + " MB";
  return kb + " KB";
}

/* natural compare so "1M85" < "1M458" and digits sort numerically */
function natCmp(a, b) {
  const ax = String(a).match(/(\d+|\D+)/g) || [];
  const bx = String(b).match(/(\d+|\D+)/g) || [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = /^\d/.test(ax[i]), bn = /^\d/.test(bx[i]);
    if (an && bn) { const d = +ax[i] - +bx[i]; if (d) return d; }
    else if (ax[i] !== bx[i]) return ax[i] < bx[i] ? -1 : 1;
  }
  return ax.length - bx.length;
}
function cmp(a, b) {
  const k = state.sortKey, dir = state.sortDir[k];
  if (k === "num") {
    const an = parseInt(dispNum(a.num), 10), bn = parseInt(dispNum(b.num), 10);
    if (!isNaN(an) && !isNaN(bn) && an !== bn) return (an - bn) * dir;
    return natCmp(a.num, b.num) * dir;
  }
  const av = a[k] == null ? -1 : a[k];
  const bv = b[k] == null ? -1 : b[k];
  if (av !== bv) return (av - bv) * dir;
  return natCmp(a.num, b.num);
}

function condClass(c) {
  c = (c || "").toLowerCase();
  if (c === "open" || c === "verygood" || c === "good" || c === "normal") return "c-open";
  if (c === "busy" || c === "verybusy") return "c-busy";
  if (c === "overflow") return "c-over";
  return "c-off";
}
function fpsClass(f) { return f == null ? "" : f >= 60 ? "ok" : f >= 30 ? "warn" : "bad"; }
function cpuClass(v) { return v == null ? "" : v < 70 ? "ok" : v < 90 ? "warn" : "bad"; }   // CPU%: low=good, high=bad

/* ---------- list view ---------- */
function render() {
  const d = state.data;
  if (!d) return;
  document.getElementById("src").textContent = d.source || "?";
  document.getElementById("totccu").textContent = (d.summary?.total_ccu ?? "–").toLocaleString();
  document.getElementById("cnt").textContent = d.summary?.server_count ?? "–";
  renderUpdated();
  renderAlerts();

  const f = state.filter.trim().toLowerCase();
  let rows = (d.servers || []).filter(s =>
    !f || (s.num || "").toLowerCase().includes(f) || (s.name || "").toLowerCase().includes(f));
  rows.sort(cmp);
  const pin = rows.filter(s => state.pinned.has(s.num));
  const rest = rows.filter(s => !state.pinned.has(s.num));

  const list = document.getElementById("list");
  list.innerHTML = "";
  for (const s of pin) list.appendChild(rowEl(s, true));
  for (const s of rest) list.appendChild(rowEl(s, false));
  document.getElementById("foot").textContent =
    `${rows.length} / ${d.servers?.length || 0} shown` + (state.pinned.size ? ` · ${pin.length} pinned` : "");
}

function rowEl(s, pinned) {
  const el = document.createElement("div");
  el.className = "row" + (pinned ? " pinned" : "");
  el.addEventListener("click", () => navTo(s.num));          // tap row -> detail

  const star = document.createElement("span");
  star.className = "c-pin" + (pinned ? " on" : "");
  star.textContent = pinned ? "★" : "☆";
  star.setAttribute("role", "button");
  star.title = "Pin / unpin";
  star.onclick = (e) => { e.stopPropagation(); togglePin(s.num); };   // don't navigate

  const name = document.createElement("span");
  name.className = "c-name";
  name.innerHTML = `<span class="dot ${condClass(s.condition)}"></span><span class="num"></span>`;
  name.querySelector(".num").textContent = dispNum(s.num);
  name.querySelector(".dot").title = s.condition || "?";

  const ccu = el_span("c-ccu", s.ccu == null ? "–" : s.ccu.toLocaleString());
  const mn = el_span("c-min " + fpsClass(s.fps_min), s.fps_min == null ? "–" : s.fps_min);
  const av = el_span("c-avg " + fpsClass(s.fps_avg), s.fps_avg == null ? "–" : s.fps_avg);
  const mx = el_span("c-max " + fpsClass(s.fps_max), s.fps_max == null ? "–" : s.fps_max);

  el.append(star, name, ccu, mn, av, mx);
  return el;
}
function el_span(cls, text) { const e = document.createElement("span"); e.className = cls; e.textContent = text; return e; }
function dispNum(num) {                    // "1M458" -> "458" (drop the 1M/L prefix)
  const m = String(num || "").match(/(\d+)$/);
  return m ? m[1] : (num || "");
}

function togglePin(num) {
  if (!num) return;
  if (state.pinned.has(num)) state.pinned.delete(num); else state.pinned.add(num);
  savePinned();
  render();
}

/* Relative "updated" age. Minute-granular past the first minute (no per-second seconds
   field) so the label in the sticky header isn't repainting every tick — that constant
   churn was the visible jitter on iOS. setAge guards the write so an unchanged label
   touches nothing, and .updated is tabular-nums so a digit swap can't shift the layout. */
function relAge(sec) {
  if (sec < 60) return "just now";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  return Math.floor(sec / 3600) + "h ago";
}
function setAge(el, text, stale) {
  if (el.textContent !== text) el.textContent = text;
  if (el.classList.contains("stale") !== stale) el.classList.toggle("stale", stale);
}
function paintAge(el, d, mockText) {
  if (!el || !d) return;
  if (d.source === "mock") { setAge(el, mockText, false); return; }
  const age = Math.max(0, Math.floor(Date.now() / 1000 - (d.updated_epoch || 0)));
  setAge(el, relAge(age), age > STALE_SEC);
}
function renderUpdated() { paintAge(document.getElementById("updated"), state.data, "mock preview"); }

/* Alert "since" is an epoch (seconds) marking when the episode began — show it so you can tell when
   the alert fired. Phone-local clock (HH:MM); prefix the date only when it wasn't today (event/maint
   alerts can linger for hours and cross midnight). Absolute, not relative, so it never needs a repaint. */
function fmtAlertTime(sec) {
  if (!sec) return "";
  const d = new Date(sec * 1000), p = n => ("0" + n).slice(-2);
  const hm = p(d.getHours()) + ":" + p(d.getMinutes());
  return d.toDateString() === new Date().toDateString()
    ? hm : p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + hm;
}

/* Crash "time" is a UTC wall-clock string ("YYYY-MM-DD HH:MM:SS") from CrashReportServer. Render it in
   KST (UTC+9, no DST) with an explicit label so the on-screen time is unambiguous. Parse the fields as
   UTC, add 9h, then format the UTC components — device-timezone-independent. Unknown formats pass through. */
function fmtCrashTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || "");
  if (!m) return s || "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) + 9 * 3600 * 1000);
  const p = n => ("0" + n).slice(-2);
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + " " +
         p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) + " KST";
}

/* ---- anomaly alert banner (top of dashboard) ----
   status.json carries the active alert set (same conditions the bridge balloons to the tray). Each
   alert has a stable per-episode id; dismissing one stores its id in localStorage so it stays hidden,
   while a later recurrence (new episode = new id) re-appears. Acked ids no longer present are pruned
   so the store can't grow without bound. */
function renderAlerts() {
  const bar = document.getElementById("alertbar");
  if (!bar) return;
  const alerts = (state.data && state.data.alerts) || [];
  const ack = loadAck();
  const present = new Set(alerts.map(a => a.id));
  let pruned = false;
  for (const id of [...ack]) if (!present.has(id)) { ack.delete(id); pruned = true; }
  if (pruned) saveAck(ack);

  const vis = alerts.filter(a => a && a.id && !ack.has(a.id));
  if (!vis.length) { bar.hidden = true; bar.innerHTML = ""; return; }
  bar.hidden = false;
  bar.innerHTML =
    `<div class="alert-h"><span>⚠ ${vis.length} alert${vis.length > 1 ? "s" : ""}</span>` +
    `<button class="alert-clear" data-all="1">Dismiss all</button></div>` +
    vis.map(a => {
      const tm = fmtAlertTime(a.since);
      const crash = a.level === "crash";                 // crash alerts are tappable -> crash detail view
      const num = crash ? "" : alertNum(a);              // fps/down/event alerts -> tappable to that server's detail
      const nav = crash ? ` data-crash="${esc(a.id)}"` : (num ? ` data-num="${esc(num)}"` : "");
      return `<div class="alert alert-${esc(a.level)}"${nav}>` +
        (tm ? `<span class="atime">${esc(tm)}</span>` : "") +
        `<span class="atext">${esc(a.text)}</span>` +
        (crash || num ? `<span class="achevron" aria-hidden="true">›</span>` : "") +
        `<button class="adismiss" data-id="${esc(a.id)}" title="Dismiss" aria-label="Dismiss">✓</button>` +
        `</div>`;
    }).join("");
}
function dismissAlert(id, all) {
  const ack = loadAck();
  if (all) { for (const a of (state.data?.alerts || [])) ack.add(a.id); }
  else if (id) ack.add(id);
  saveAck(ack);
  renderAlerts();
}

/* ---- crash detail view (opened from a crash alert; data rides in status.json.crashes) ----
   Renders the CrashReportServer analysis natively and offers a Copy button that puts the
   paste-ready Markdown (report_md) on the clipboard as PLAIN text — so pasting into Notion
   can't carry rich formatting and get mangled the way a copied Teams card does. */
function renderCrash(id) {
  const c = ((state.data && state.data.crashes) || []).find(x => x.id === id);
  const copyBtn = document.getElementById("c-copy");
  const meta = document.getElementById("c-meta");
  const srcCard = document.getElementById("c-src-card");
  document.getElementById("c-server").textContent = c ? (c.server || "?") : "?";
  if (!c) {
    state.crashCopy = "";
    copyBtn.disabled = true;
    meta.innerHTML = '<div class="nochart">This crash is no longer in the feed (rolled out or expired).</div>';
    srcCard.hidden = true;
    document.getElementById("c-stack").textContent = "";
    return;
  }
  state.crashCopy = c.report_md || "";
  copyBtn.disabled = !state.crashCopy;
  const rows = [
    ["Server", c.server], ["Version", c.version], ["Exception", c.exception],
    ["Location", c.location], ["Source", c.source], ["Time", fmtCrashTime(c.time)], ["Dump", c.dump],
  ].filter(r => r[1]);
  meta.innerHTML = rows.map(r =>
    `<div class="crow"><span class="ck">${esc(r[0])}</span><span class="cvv">${esc(r[1])}</span></div>`).join("");
  const code = (c.source_code || []).join("\n");
  srcCard.hidden = !code;
  document.getElementById("c-src").textContent = code;
  document.getElementById("c-stack").textContent = (c.call_stack || []).join("\n") || "(no call stack)";
}

async function copyText(text) {
  if (!text) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);          // plain text: Notion won't inherit rich formatting
    ok = true;
  } catch {
    const ta = document.createElement("textarea");      // iOS / older-Safari fallback
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { ok = document.execCommand("copy"); } catch {}
    document.body.removeChild(ta);
  }
  toast(ok ? "Copied — paste into Notion" : "Copy failed — long-press the text to select");
}

function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2200);
}

/* ---------- detail view ---------- */
/* maintenance bands + UTC-midnight grid, shared by lineChart & stackedChart (identical output). */
function _decor(opts, t, n, X, PT, PB, H) {
  let out = "";
  if (opts.bands && opts.bands.length && t && t.length === n) {
    const idxAt = ts => {                               // epoch -> fractional index on the time axis
      if (ts <= t[0]) return 0;
      for (let i = 0; i < n - 1; i++)
        if (t[i + 1] >= ts) return i + (ts - t[i]) / ((t[i + 1] - t[i]) || 1);
      return n - 1;
    };
    for (const b of opts.bands) {                       // [start, end|null] — null = still ongoing
      const s = Math.max(b[0], t[0]), e = Math.min(b[1] == null ? t[n - 1] : b[1], t[n - 1]);
      if (e <= s) continue;
      const x1 = X(idxAt(s)), x2 = X(idxAt(e));
      out += `<rect class="maintband" x="${x1.toFixed(1)}" y="${PT}" width="${Math.max(1, x2 - x1).toFixed(1)}" height="${H - PT - PB}"><title>Maintenance</title></rect>`;
    }
  }
  if (t && t.length === n) {                            // vertical marks at UTC midnight (epoch % 86400 == 0)
    for (let i = 0; i < n - 1; i++) {
      const a = t[i], b = t[i + 1];
      if (!(b > a)) continue;
      for (let m = Math.ceil(a / 86400) * 86400; m <= b; m += 86400) {
        if (m <= a) continue;
        const gx = X(i + (m - a) / (b - a)).toFixed(1);
        out += `<line class="daygrid" x1="${gx}" y1="${PT}" x2="${gx}" y2="${H - PB}" vector-effect="non-scaling-stroke"/>`;
      }
    }
  }
  return out;
}

/* Stacked-area chart on a fixed 0–100% axis. `series` = [{vals,color,label}] stacked bottom→top; all
   series share null positions (W/U/S/D arrive together), so gaps break every band at the same index.
   Used for the tick-breakdown (WUSD) trend — the composition over time, so a fattening D/U band flags
   a DB/logic spike the way the single W-dominated line never could. */
function stackedChart(series, t, opts) {
  opts = opts || {};
  const W = 320, H = 96, PX = 4, PT = 10, PB = 8;
  const first = series[0] ? series[0].vals : [];
  const n = first.length;
  let count = 0;
  for (let i = 0; i < n; i++) if (first[i] != null) count++;
  if (count < 2) return `<div class="nochart">${opts.empty || "collecting… (1 pt/min)"}</div>`;
  const X = i => PX + (n <= 1 ? 0 : i * (W - 2 * PX) / (n - 1));
  const Y = v => PT + (H - PT - PB) * (1 - v / 100);    // absolute % -> a 26% D band reads true
  const runs = [];                                      // contiguous non-null spans (shared across series)
  let start = -1;
  for (let i = 0; i < n; i++) {
    const ok = first[i] != null;
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) { runs.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, n - 1]);
  const decor = _decor(opts, t, n, X, PT, PB, H);
  const cum = new Array(n).fill(0);                     // running stack baseline per index
  let polys = "";
  for (const s of series) {
    let path = "";
    for (const [a, b] of runs) {
      for (let i = a; i <= b; i++)                      // upper edge (cum+val), left→right
        path += (i === a ? "M" : "L") + X(i).toFixed(1) + " " + Y(cum[i] + (s.vals[i] || 0)).toFixed(1) + " ";
      for (let i = b; i >= a; i--)                      // lower edge (cum), right→left -> closed band
        path += "L" + X(i).toFixed(1) + " " + Y(cum[i]).toFixed(1) + " ";
      path += "Z ";
    }
    polys += `<path d="${path}" fill="${s.color}" opacity="0.8"/>`;
    for (let i = 0; i < n; i++) cum[i] += (s.vals[i] || 0);
  }
  const legend = series.slice().reverse().map(s =>      // top→bottom = W,U,S,D
    `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="spark" preserveAspectRatio="none">${decor}${polys}</svg>
  <div class="slegend">${legend}</div>`;
}

function lineChart(vals, color, t, opts) {
  opts = opts || {};
  const W = 320, H = 96, PX = 4, PT = 10, PB = 8;
  let mn = Infinity, mx = -Infinity, count = 0;
  for (const v of vals) { if (v == null) continue; count++; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (count < 2) return `<div class="nochart">${opts.empty || "collecting… (1 pt/min)"}</div>`;
  if (opts.fixedMin != null) mn = opts.fixedMin;          // CPU%: pin to 0–100 so the absolute level reads true
  if (opts.fixedMax != null) mx = opts.fixedMax;
  if (mn === mx) { mn -= 1; mx += 1; }
  const n = vals.length;
  const X = i => PX + (n <= 1 ? 0 : i * (W - 2 * PX) / (n - 1));
  const Y = v => PT + (H - PT - PB) * (1 - (v - mn) / (mx - mn));
  const decor = _decor(opts, t, n, X, PT, PB, H);       // maintenance bands + UTC-midnight grid
  let line = "", firstX = 0, lastX = 0, started = false;
  vals.forEach((v, i) => {
    if (v == null) return;
    const x = X(i), y = Y(v);
    line += (started ? " L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    if (!started) { firstX = x; started = true; }
    lastX = x;
  });
  const area = `M${firstX.toFixed(1)} ${(H - PB).toFixed(1)} ` + line.slice(1) +
               ` L${lastX.toFixed(1)} ${(H - PB).toFixed(1)} Z`;
  return `<svg viewBox="0 0 ${W} ${H}" class="spark" preserveAspectRatio="none">
    ${decor}
    <path d="${area}" fill="${color}" opacity="0.13"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
  </svg>
  <div class="ylab"><span>${Math.round(mx)}</span><span>${Math.round(mn)}</span></div>`;
}

function histRange(ts) {
  if (!ts || ts.length < 2) return "";
  const f = new Date(ts[0] * 1000), l = new Date(ts[ts.length - 1] * 1000);
  const p = n => ("0" + n).slice(-2);
  const hm = d => p(d.getHours()) + ":" + p(d.getMinutes());
  const md = d => p(d.getMonth() + 1) + "-" + p(d.getDate());
  return f.toDateString() === l.toDateString()         // 24h window may span two days
    ? hm(f) + " ~ " + hm(l)
    : md(f) + " " + hm(f) + " ~ " + md(l) + " " + hm(l);
}
function fmtEvTime(e) {                                 // event timestamps are Master-UTC -> show phone-local
  const p = n => ("0" + n).slice(-2);
  if (e && e.ep) {
    const d = new Date(e.ep * 1000);
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  return String((e && e.date) || "").slice(5, 19);     // fallback (mock / unparsed): raw "MM-DD HH:MM:SS"
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  document.getElementById("d-num").textContent = dispNum(d.num);
  document.getElementById("d-name").textContent = d.name || "";
  const c = d.current || {};
  const dot = document.getElementById("d-dot");
  dot.className = "dot " + condClass(c.condition);
  dot.title = c.condition || "?";
  renderDUpdated();

  const cells = [
    ["CCU", fmtNum(c.ccu), c.condition || ""],
    ["Peak CCU", c.peak == null ? "—" : fmtNum(c.peak), c.peak == null ? "" : "day high", c.peak == null ? "muted" : ""],
    ["FPS", fmtNum(c.fps), `min ${c.fps_min ?? "–"} · avg ${c.fps_avg ?? "–"} · max ${c.fps_max ?? "–"}`, fpsClass(c.fps)],
    ["CPU", c.cpu == null ? "—" : c.cpu + "%", c.cpu == null ? "needs patch" : "", c.cpu == null ? "muted" : cpuClass(c.cpu)],
    ["Used Mem", fmtMem(c.used_mem), ""],
    ["Wait Dispatch", fmtNum(c.wait_dispatch), ""],
  ];
  document.getElementById("d-current").innerHTML = cells.map(([label, val, sub, cls]) =>
    `<div class="cur"><span class="cl">${esc(label)}</span><span class="cv ${cls || ""}">${esc(val)}</span>` +
    (sub ? `<span class="cs">${esc(sub)}</span>` : "") + `</div>`).join("");

  renderTickGauge(c.tick);                              // per-tick WUSD wall-clock split (모니터링툴 개편); hidden if absent
  if (state._rangeFilledNum !== d.num) { fillCustomInputs(); state._rangeFilledNum = d.num; }  // fill From/To when a server opens; skip on background refresh so a mid-edit isn't clobbered
  setRangeButtons();
  renderTrends();
}

/* WUSD current gauge: a stacked proportion bar (W/U/S/D% of one game tick's wall time) + avg tick ms.
   Hidden when the server reports no tick profile (non-GS, or bridge/Master not yet on the 개편 build). */
function renderTickGauge(tk) {
  const el = document.getElementById("d-tick");
  if (!el) return;
  if (!tk) { el.hidden = true; el.innerHTML = ""; return; }
  const segs = [["w", "Work", tk.w], ["u", "Update", tk.u], ["s", "Send", tk.s], ["d", "DB", tk.d]];
  el.hidden = false;
  el.innerHTML =
    `<div class="tick-h"><span class="cl">Tick breakdown (WUSD)</span>` +
    `<span class="tick-ms">${tk.ms == null ? "" : tk.ms + " ms/tick"}</span></div>` +
    `<div class="tickbar">` +
    segs.map(([k, l, v]) => `<span class="seg seg-${k}" style="width:${Math.max(0, v)}%" title="${l} ${v}%"></span>`).join("") +
    `</div>` +
    `<div class="ticklab">` +
    segs.map(([k, l, v]) => `<span class="tl tl-${k}"><i></i>${l} ${v}%</span>`).join("") +
    `</div>`;
}

/* ---- range-windowed trends + events. One selector drives all three sections. The detail file
   carries two trend buffers (minute=24h, hour=30d); we pick one by range and slice to its window.
   Falls back to the old flat history schema so it keeps working before the bridge is updated. ---- */
const RANGES = {
  "3h":  { sec: 3 * 3600,   src: "minute" },
  "1d":  { sec: 24 * 3600,  src: "minute" },
  "1w":  { sec: 7 * 86400,  src: "hour" },
  "2w":  { sec: 14 * 86400, src: "hour" },
  "1mo": { sec: 30 * 86400, src: "hour" },
};
function pickBuffer(h, src) {
  if (h && (h.minute || h.hour)) return (src === "hour" ? h.hour : h.minute) || { t: [], ccu: [], fps: [], cpu: [] };
  return { t: (h && h.t) || [], ccu: (h && h.ccu) || [], fps: (h && h.fps) || [], cpu: (h && h.cpu) || [] };   // old flat schema
}

/* Resolve the active selection to an absolute [lo,hi] window + which buffer to read. Presets are
   "last N from now"; "custom" is an explicit From–To (state.custom). Use the minute buffer (1-min res,
   24h deep) only when the whole window fits inside it; otherwise the hour buffer (1-hr res, 30d deep). */
function currentWindow() {
  const now = Date.now() / 1000;
  if (state.range === "custom" && state.custom) {
    const lo = state.custom.from, hi = state.custom.to;
    return { lo, hi, src: lo >= now - 24 * 3600 ? "minute" : "hour" };
  }
  const r = RANGES[state.range] || RANGES["3h"];
  return { lo: now - r.sec, hi: now, src: r.src };
}
function sliceRange(buf, lo, hi) {
  const t = [], ccu = [], fps = [], cpu = [], w = [], u = [], s = [], d = [];
  const cb = buf.cpu || [], wb = buf.w || [], ub = buf.u || [], sb = buf.s || [], db = buf.d || [];
  (buf.t || []).forEach((ti, i) => {
    if (ti >= lo && ti <= hi) {
      t.push(ti); ccu.push(buf.ccu[i]); fps.push(buf.fps[i]); cpu.push(cb[i] == null ? null : cb[i]);
      w.push(wb[i] == null ? null : wb[i]); u.push(ub[i] == null ? null : ub[i]);
      s.push(sb[i] == null ? null : sb[i]); d.push(db[i] == null ? null : db[i]);
    }
  });
  return { t, ccu, fps, cpu, w, u, s, d };
}

/* <input type="datetime-local"> speaks local wall-clock "YYYY-MM-DDTHH:MM" with no timezone. */
function toLocalInput(sec) {
  const d = new Date(sec * 1000), p = n => ("0" + n).slice(-2);
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
}
function fromLocalInput(v) {
  const t = new Date(v).getTime();                      // no zone in the string -> parsed as local time
  return isNaN(t) ? null : Math.floor(t / 1000);
}
function fillCustomInputs() {
  const from = document.getElementById("cr-from"), to = document.getElementById("cr-to");
  if (!from || !to) return;
  if (document.activeElement === from || document.activeElement === to) return;  // don't clobber a mid-edit
  const w = currentWindow();                          // reflect the ACTIVE window: a preset = [now-N, now], else the custom window
  from.value = toLocalInput(Math.floor(w.lo));
  to.value = toLocalInput(Math.floor(w.hi));
  const now = Math.floor(Date.now() / 1000);
  const lo = toLocalInput(now - 30 * 86400), hi = toLocalInput(now);   // guide rails: buffers span ~30d back to now
  from.min = to.min = lo; from.max = to.max = hi;
}

/* "Custom" freezes the currently-shown From–To (which already mirrors the active preset) as an
   absolute window. The From–To panel is always visible; the click handler runs this BEFORE flipping
   state.range, so currentWindow() still reports the preset being frozen. Absolute epochs -> the window
   stays put across reloads. */
function openCustom() {
  const w = currentWindow();                        // active preset's [lo,hi] (or the existing custom window)
  state.custom = { from: Math.floor(w.lo), to: Math.floor(w.hi) };
  saveCustom();
  state.range = "custom";
  try { localStorage.setItem(RANGE_KEY, "custom"); } catch {}
  fillCustomInputs();
  setRangeButtons();
  renderTrends();
}
function setRangeButtons() {   // the From–To panel is always visible; just reflect which range is active
  document.querySelectorAll("#d-ranges .rbtn").forEach(b => b.classList.toggle("active", b.dataset.r === state.range));
}
/* A wide range packs too many points into the chart (1D = 1440 minute points -> a dense noise band).
   Down-sample to <= TREND_MAX_PTS by bucket-averaging so the line reads as a trend (matches the ~180-pt
   density of 3H that reads fine). t stays aligned (bucket start); a bucket with no data stays null.
   The current-card min/avg/max come from the full window elsewhere, so the extremes aren't lost here. */
const TREND_MAX_PTS = 240;
function coarsen(sl, maxPts) {
  const n = (sl.t || []).length;
  if (n <= maxPts) return sl;
  const step = Math.ceil(n / maxPts);
  const keys = ["ccu", "fps", "cpu", "w", "u", "s", "d"];
  const out = { t: [] };
  keys.forEach(k => out[k] = []);
  for (let i = 0; i < n; i += step) {
    const end = Math.min(i + step, n);
    out.t.push(sl.t[i]);
    for (const k of keys) {
      const arr = sl[k] || [];
      let sum = 0, cnt = 0;
      for (let j = i; j < end; j++) { const v = arr[j]; if (v != null) { sum += v; cnt++; } }
      out[k].push(cnt ? sum / cnt : null);
    }
  }
  return out;
}
function renderTrends() {
  const d = state.detail;
  if (!d) return;
  const w = currentWindow();
  const sl = coarsen(sliceRange(pickBuffer(d.history || {}, w.src), w.lo, w.hi), TREND_MAX_PTS);
  const bands = d.maint || [];                          // 점검 windows, shaded on all three charts
  document.getElementById("chart-ccu").innerHTML = lineChart(sl.ccu, "#5b8cff", sl.t, { bands });
  document.getElementById("chart-fps").innerHTML = lineChart(sl.fps, "#8b7cff", sl.t, { bands });
  document.getElementById("chart-cpu").innerHTML =                                  // CPU% on a fixed 0–100 axis
    lineChart(sl.cpu, "#37c98a", sl.t, { bands, fixedMin: 0, fixedMax: 100, empty: "no CPU data (server needs Master patch)" });
  const tickEl = document.getElementById("chart-tick");                            // WUSD tick breakdown (stacked 0–100%)
  if (tickEl) {
    const hasTick = sl.w.some(v => v != null);
    tickEl.innerHTML = hasTick
      ? stackedChart([{ vals: sl.d, color: "#ff5d6c", label: "DB" }, { vals: sl.s, color: "#5b8cff", label: "Send" },
                      { vals: sl.u, color: "#f5b942", label: "Update" }, { vals: sl.w, color: "#38d39f", label: "Work" }],
                     sl.t, { bands })   // colors match --bad/--accent/--warn/--ok (and the .seg-* gauge)
      : `<div class="nochart">no tick data in range (needs the 개편 bridge build)</div>`;
  }
  const rng = histRange(sl.t);
  document.getElementById("ccu-range").textContent = rng;
  document.getElementById("fps-range").textContent = rng;
  document.getElementById("cpu-range").textContent = rng;
  const tr = document.getElementById("tick-range"); if (tr) tr.textContent = rng;
  const ev = (d.events || []).filter(e => (e && e.ep) ? (e.ep >= w.lo && e.ep <= w.hi) : true);   // events w/o ep (mock) always shown
  document.getElementById("ev-cnt").textContent = ev.length ? `${ev.length} events` : "";
  const box = document.getElementById("d-events");
  box.innerHTML = ev.length
    ? ev.map(e => `<div class="ev ev-${esc(e.sev)}"><span class="et">${esc(fmtEvTime(e))}</span>` +
        `<span class="em">${esc(e.msg)}</span></div>`).join("")
    : '<div class="nochart">No events</div>';
}

function renderDUpdated() { paintAge(document.getElementById("d-updated"), state.detail, "mock"); }

/* ---------- routing + data ---------- */
function currentRoute() {
  const h = location.hash || "";
  let m = h.match(/^#s\/(.+)$/);
  if (m) return { view: "detail", num: decodeURIComponent(m[1]) };
  m = h.match(/^#c\/(.+)$/);
  if (m) return { view: "crash", id: decodeURIComponent(m[1]) };
  return { view: "list" };
}
function navTo(num) { if (num) location.hash = "s/" + encodeURIComponent(num); }
function navToCrash(id) { if (id) location.hash = "c/" + encodeURIComponent(id); }
// Server-specific alerts embed the server num as the first id segment (fps:<num>:<since>, down:<num>:<ts>,
// evt:<num>:<logid>) -> tapping navigates to that server's detail. maint/maintend are server-wide (no num);
// crash alerts open the crash detail view instead (handled separately).
function alertNum(a) {
  if (!a || !a.id || a.level === "crash") return "";
  const m = /^(?:fps|down|evt):([^:]+)(?::|$)/.exec(a.id);
  return m ? m[1] : "";
}
function showView() {
  const r = currentRoute();
  document.getElementById("list-view").hidden = r.view !== "list";
  document.getElementById("detail-view").hidden = r.view !== "detail";
  document.getElementById("crash-view").hidden = r.view !== "crash";
}

function repoInfo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split("/").filter(Boolean)[0];
  return (m && repo) ? { owner: m[1], repo } : null;   // null => local preview (mock)
}
function apiUrl(file) {
  const repo = repoInfo();
  return `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${file}?ref=data`;
}
function rawUrl(file) {
  const repo = repoInfo();                                    // raw CDN of the data branch: ~5-min cached but
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/data/${file}`;  // NOT counted against the 60/hr API cap
}

/* localStorage cache of the last good payload per file: a cold open paints instantly (stale) instead
   of a blank screen, and a fully-offline load still shows something. Bounded so opening many detail
   pages can't blow the storage quota; status.json is always kept. */
function cachePut(file, data) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    all[file] = { at: Date.now(), data };
    const files = Object.keys(all);
    if (files.length > CACHE_MAX) {
      files.filter(f => f !== "status.json").sort((a, b) => all[a].at - all[b].at)
           .slice(0, files.length - CACHE_MAX).forEach(f => delete all[f]);
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {}
}
function cacheGet(file) {
  try { return (JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"))[file] || null; }
  catch { return null; }
}

async function fetchApi(url) {
  const r = await fetch(url, { cache: "no-store", headers: { Accept: "application/vnd.github.raw" } });
  if (!r.ok) {
    const e = new Error("HTTP " + r.status);
    if (r.status === 403 && r.headers.get("X-RateLimit-Remaining") === "0") {
      const reset = parseInt(r.headers.get("X-RateLimit-Reset") || "0", 10);
      e.resetMs = reset ? reset * 1000 : Date.now() + 3600000;   // when the 60/hr window refreshes
    }
    throw e;
  }
  return JSON.parse(await r.text());
}
async function fetchPlain(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return JSON.parse(await r.text());
}

/* One fetch, three tiers: prefer the fresh API; on the 60/hr cap (or any API error) fall back to the
   raw CDN (≤5-min stale, uncapped); if that fails too, fall back to the localStorage cache. While
   inside a known rate-limit window we skip the API entirely, so even repeated manual refreshes hit
   raw and never burn more quota. Returns {data, stale, src, cachedAt?}. */
async function loadFile(file) {
  if (!repoInfo()) {                                          // local preview -> same-origin mock
    const data = await fetchPlain(file + "?ts=" + Date.now());
    cachePut(file, data);
    return { data, stale: false, src: "mock" };
  }
  if (Date.now() >= state.rlUntil) {
    try {
      const data = await fetchApi(apiUrl(file));
      state.rlUntil = 0;
      cachePut(file, data);
      return { data, stale: false, src: "api" };
    } catch (e) {
      if (e.resetMs) state.rlUntil = e.resetMs;               // remember the reset; fall through to raw
    }
  }
  try {
    const data = await fetchPlain(rawUrl(file));
    cachePut(file, data);
    return { data, stale: true, src: "raw" };
  } catch (e2) {
    const c = cacheGet(file);
    if (c) return { data: c.data, stale: true, src: "cache", cachedAt: c.at };
    throw e2;
  }
}

function clockOf(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function staleBanner(res) {
  if (res.src === "cache") return "Offline — showing last saved " + clockOf(res.cachedAt);
  const left = state.rlUntil - Date.now();
  if (left > 0)
    return "Rate limited — showing ~5-min-old data, live again " + clockOf(state.rlUntil) +
           " (~" + Math.max(1, Math.round(left / 60000)) + " min)";
  return "Live API busy — showing a recent copy, retrying";
}
function setBanner(id, msg) {
  const b = document.getElementById(id);
  if (!b) return;
  if (msg) { b.hidden = false; b.textContent = msg; } else { b.hidden = true; }
}
function setRefreshing(on) {
  document.querySelectorAll(".refreshbtn").forEach(b => { b.classList.toggle("spin", on); b.disabled = on; });
}

/* one route-aware fetch; single-flight + debounced (the iOS resume burst collapses to one request).
   A request that arrives mid-flight (notably a route change) sets `pending` so we re-run for the
   current route when the in-flight fetch finishes - otherwise tapping a row during the initial
   load would drop the detail fetch and the page would stay blank until the next poll. */
function paint(r, data) {
  if (r.view === "detail") { state.detail = data; renderDetail(); }
  else { state.data = data; if (r.view === "crash") renderCrash(r.id); else render(); }   // crash data rides in status.json
}
async function activeFetch(force) {
  if (state.fetching) { state.pending = true; return; }
  if (!force && Date.now() - state.lastFetch < MIN_GAP_MS) return;
  state.fetching = true;
  setRefreshing(true);
  do {
    state.pending = false;
    state.lastFetch = Date.now();
    const r = currentRoute();
    const file = r.view === "detail" ? "detail/" + encodeURIComponent(r.num) + ".json" : "status.json";
    const bannerId = r.view === "detail" ? "d-banner" : "banner";
    if (r.view === "detail" ? !state.detail : !state.data) {   // cold open: paint cache instantly, no blank screen
      const c = cacheGet(file);
      if (c) { paint(r, c.data); setBanner(bannerId, "Offline — showing last saved " + clockOf(c.at)); }
    }
    try {
      const res = await loadFile(file);
      paint(r, res.data);
      setBanner(bannerId, res.stale ? staleBanner(res) : null);
    } catch (e) {
      setBanner(bannerId, "Load failed: " + (e.message || "error") + " (retrying)");
    }
  } while (state.pending);
  state.fetching = false;
  setRefreshing(false);
}

/* ---- events ---- */
document.getElementById("sorts").addEventListener("click", e => {
  const btn = e.target.closest(".sortbtn");
  if (!btn) return;
  const key = btn.dataset.key;
  if (state.sortKey === key) state.sortDir[key] *= -1; else state.sortKey = key;
  for (const b of document.querySelectorAll(".sortbtn")) {
    b.classList.toggle("active", b.dataset.key === state.sortKey);
    b.querySelector(".dir")?.remove();
    if (b.dataset.key === state.sortKey) {
      const dd = document.createElement("span");
      dd.className = "dir";
      dd.textContent = state.sortDir[state.sortKey] > 0 ? " ▲" : " ▼";
      b.appendChild(dd);
    }
  }
  render();
});
document.getElementById("alertbar").addEventListener("click", e => {
  const all = e.target.closest(".alert-clear");
  const one = e.target.closest(".adismiss");
  const crash = e.target.closest("[data-crash]");
  const srv = e.target.closest("[data-num]");
  if (all) dismissAlert(null, true);
  else if (one) dismissAlert(one.dataset.id, false);       // ✓ dismiss checked before nav, so it won't open the detail
  else if (crash) navToCrash(crash.dataset.crash);
  else if (srv) navTo(srv.dataset.num);                    // fps/down/event alert -> that server's detail
});
document.getElementById("filter").addEventListener("input", e => { state.filter = e.target.value; render(); });
document.getElementById("refresh").addEventListener("click", () => activeFetch(true));
document.getElementById("refresh2").addEventListener("click", () => activeFetch(true));
document.getElementById("d-ranges").addEventListener("click", e => {
  const b = e.target.closest(".rbtn");
  if (!b) return;
  if (b.dataset.r === "custom") { openCustom(); return; }   // reveals the From–To panel
  state.range = b.dataset.r;
  try { localStorage.setItem(RANGE_KEY, state.range); } catch {}
  fillCustomInputs();                                       // From/To mirrors the chosen preset's period (now-N .. now)
  setRangeButtons();
  renderTrends();
});
document.getElementById("cr-apply").addEventListener("click", () => {
  let from = fromLocalInput(document.getElementById("cr-from").value);
  let to = fromLocalInput(document.getElementById("cr-to").value);
  if (from == null || to == null) { toast("Pick both From and To"); return; }
  if (from > to) { const t = from; from = to; to = t; }     // tolerate reversed entry
  state.custom = { from, to };
  state.range = "custom";
  saveCustom();
  try { localStorage.setItem(RANGE_KEY, "custom"); } catch {}
  document.getElementById("cr-from").value = toLocalInput(from);   // reflect any swap back into the fields
  document.getElementById("cr-to").value = toLocalInput(to);
  renderTrends();
});
document.getElementById("back").addEventListener("click", () => {
  if (history.length > 1) history.back(); else location.hash = "";
});
document.getElementById("cback").addEventListener("click", () => {
  if (history.length > 1) history.back(); else location.hash = "";
});
document.getElementById("c-copy").addEventListener("click", () => copyText(state.crashCopy));

window.addEventListener("hashchange", () => { showView(); window.scrollTo(0, 0); activeFetch(true); });

/* refetch on every path back to the foreground (iOS Safari freezes timers when backgrounded;
   visibilitychange/pageshow/focus/online cover unlock, bfcache restore, focus, reconnect) */
document.addEventListener("visibilitychange", () => { if (!document.hidden) activeFetch(false); });
window.addEventListener("pageshow", () => activeFetch(false));
window.addEventListener("focus", () => activeFetch(false));
window.addEventListener("online", () => activeFetch(true));

setInterval(() => activeFetch(false), REFRESH_MS);
setInterval(() => { currentRoute().view === "detail" ? renderDUpdated() : renderUpdated(); }, 1000);

showView();
activeFetch(true);
