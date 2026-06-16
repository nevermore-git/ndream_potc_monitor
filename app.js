"use strict";
/* POTC Server Monitor - read-only static viewer.
   List view fetches status.json (all servers); detail view (#s/<num>) fetches detail/<num>.json
   (current stats + 3h CCU/FPS history + server-filtered event log), both written by the bridge
   (monitor_client.py). On GitHub Pages it reads via the UNauthenticated GitHub contents API (no
   token); on localhost it falls back to same-origin mock files. No dependencies. */

const REFRESH_MS = 90000;          // unauthenticated GitHub API = 60 req/hr -> poll every 90s (40/hr)
const STALE_SEC = 240;             // older than this -> flag the timestamp (bridge likely stopped)
const MIN_GAP_MS = 8000;           // min gap between event-driven refetches (one resume fires several events)
const PIN_KEY = "poc.pinned.v1";

const state = {
  data: null,                      // status.json (list)
  detail: null,                    // detail/<num>.json (detail view)
  sortKey: "num",
  sortDir: { num: 1, ccu: -1, fps_avg: -1 },
  filter: "",
  pinned: loadPinned(),
  fetching: false,                 // single-flight guard
  pending: false,                  // a fetch was requested mid-flight (e.g. route change) -> re-run
  lastFetch: 0,
};

function loadPinned() {
  try { return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || "[]")); }
  catch { return new Set(); }
}
function savePinned() {
  try { localStorage.setItem(PIN_KEY, JSON.stringify([...state.pinned])); } catch {}
}

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

/* ---------- list view ---------- */
function render() {
  const d = state.data;
  if (!d) return;
  document.getElementById("src").textContent = d.source || "?";
  document.getElementById("totccu").textContent = (d.summary?.total_ccu ?? "–").toLocaleString();
  document.getElementById("cnt").textContent = d.summary?.server_count ?? "–";
  renderUpdated();

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
    `${rows.length} / ${d.servers?.length || 0} 서버 표시` + (state.pinned.size ? ` · 핀 ${pin.length}` : "");
}

function rowEl(s, pinned) {
  const el = document.createElement("div");
  el.className = "row" + (pinned ? " pinned" : "");
  el.addEventListener("click", () => navTo(s.num));          // tap row -> detail

  const star = document.createElement("span");
  star.className = "c-pin" + (pinned ? " on" : "");
  star.textContent = pinned ? "★" : "☆";
  star.setAttribute("role", "button");
  star.title = "핀 고정/해제";
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

function renderUpdated() {
  const el = document.getElementById("updated");
  const d = state.data;
  if (!d) return;
  if (d.source === "mock") { el.textContent = "목업 미리보기"; el.classList.remove("stale"); return; }
  const age = Math.max(0, Math.floor(Date.now() / 1000 - (d.updated_epoch || 0)));
  el.textContent = age < 60 ? `${age}초 전` : `${Math.floor(age / 60)}분 ${age % 60}초 전`;
  el.classList.toggle("stale", age > STALE_SEC);
}

/* ---------- detail view ---------- */
function lineChart(vals, color) {
  const W = 320, H = 96, PX = 4, PT = 10, PB = 8;
  let mn = Infinity, mx = -Infinity, count = 0;
  for (const v of vals) { if (v == null) continue; count++; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (count < 2) return '<div class="nochart">데이터 수집 중… (분당 1포인트)</div>';
  if (mn === mx) { mn -= 1; mx += 1; }
  const n = vals.length;
  const X = i => PX + (n <= 1 ? 0 : i * (W - 2 * PX) / (n - 1));
  const Y = v => PT + (H - PT - PB) * (1 - (v - mn) / (mx - mn));
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
    <path d="${area}" fill="${color}" opacity="0.13"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
  </svg>
  <div class="ylab"><span>${Math.round(mx)}</span><span>${Math.round(mn)}</span></div>`;
}

function histRange(ts) {
  if (!ts || ts.length < 2) return "";
  const f = new Date(ts[0] * 1000), l = new Date(ts[ts.length - 1] * 1000);
  const hm = d => ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  return hm(f) + " ~ " + hm(l);
}
function fmtEvTime(date) { return String(date || "").slice(5, 16); }   // "MM-DD HH:MM"

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
    ["동접 (CCU)", fmtNum(c.ccu), c.condition || ""],
    ["FPS", fmtNum(c.fps), `min ${c.fps_min ?? "–"} · avg ${c.fps_avg ?? "–"} · max ${c.fps_max ?? "–"}`, fpsClass(c.fps)],
    ["CPU", "—", "서버 패치 필요", "muted"],
    ["Used Mem", fmtMem(c.used_mem), ""],
    ["Wait Dispatch", fmtNum(c.wait_dispatch), ""],
    ["Dispatched", fmtNum(c.dispatched), ""],
    ["In Packets", fmtNum(c.in_packets), ""],
    ["Connections", fmtNum(c.connections), ""],
  ];
  document.getElementById("d-current").innerHTML = cells.map(([label, val, sub, cls]) =>
    `<div class="cur"><span class="cl">${esc(label)}</span><span class="cv ${cls || ""}">${esc(val)}</span>` +
    (sub ? `<span class="cs">${esc(sub)}</span>` : "") + `</div>`).join("");

  const h = d.history || { t: [], ccu: [], fps: [] };
  document.getElementById("chart-ccu").innerHTML = lineChart(h.ccu || [], "#5b8cff");
  document.getElementById("chart-fps").innerHTML = lineChart(h.fps || [], "#8b7cff");
  const rng = histRange(h.t);
  document.getElementById("ccu-range").textContent = rng;
  document.getElementById("fps-range").textContent = rng;

  const ev = d.events || [];
  document.getElementById("ev-cnt").textContent = ev.length ? `${ev.length}건` : "";
  const box = document.getElementById("d-events");
  box.innerHTML = ev.length
    ? ev.map(e => `<div class="ev ev-${esc(e.sev)}"><span class="et">${esc(fmtEvTime(e.date))}</span>` +
        `<span class="em">${esc(e.msg)}</span></div>`).join("")
    : '<div class="nochart">이벤트 없음</div>';
}

function renderDUpdated() {
  const el = document.getElementById("d-updated");
  const d = state.detail;
  if (!d || !el) return;
  if (d.source === "mock") { el.textContent = "목업"; el.classList.remove("stale"); return; }
  const age = Math.max(0, Math.floor(Date.now() / 1000 - (d.updated_epoch || 0)));
  el.textContent = age < 60 ? `${age}초 전` : `${Math.floor(age / 60)}분 ${age % 60}초 전`;
  el.classList.toggle("stale", age > STALE_SEC);
}

/* ---------- routing + data ---------- */
function currentRoute() {
  const m = (location.hash || "").match(/^#s\/(.+)$/);
  return m ? { view: "detail", num: decodeURIComponent(m[1]) } : { view: "list" };
}
function navTo(num) { if (num) location.hash = "s/" + encodeURIComponent(num); }
function showView() {
  const r = currentRoute();
  document.getElementById("list-view").hidden = r.view !== "list";
  document.getElementById("detail-view").hidden = r.view !== "detail";
}

function repoInfo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split("/").filter(Boolean)[0];
  return (m && repo) ? { owner: m[1], repo } : null;   // null => local preview (mock)
}
function apiUrl(file) {
  const repo = repoInfo();
  return repo
    ? `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${file}?ref=data`
    : file + "?ts=" + Date.now();
}
function ghOpts() {
  return repoInfo()
    ? { cache: "no-store", headers: { Accept: "application/vnd.github.raw" } }
    : { cache: "no-store" };
}
async function fetchJson(url) {
  const r = await fetch(url, ghOpts());
  if (!r.ok) {
    if (r.status === 403 && r.headers.get("X-RateLimit-Remaining") === "0")
      throw new Error("요청 한도 초과 — 잠시 후 자동 갱신");
    throw new Error("HTTP " + r.status);
  }
  return JSON.parse(await r.text());
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
async function activeFetch(force) {
  if (state.fetching) { state.pending = true; return; }
  if (!force && Date.now() - state.lastFetch < MIN_GAP_MS) return;
  state.fetching = true;
  setRefreshing(true);
  do {
    state.pending = false;
    state.lastFetch = Date.now();
    const r = currentRoute();
    try {
      if (r.view === "detail") {
        state.detail = await fetchJson(apiUrl("detail/" + encodeURIComponent(r.num) + ".json"));
        setBanner("d-banner", null);
        renderDetail();
      } else {
        state.data = await fetchJson(apiUrl("status.json"));
        setBanner("banner", null);
        render();
      }
    } catch (e) {
      setBanner(r.view === "detail" ? "d-banner" : "banner",
        "데이터 로드 실패: " + e.message + " (자동 재시도 중)");
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
document.getElementById("filter").addEventListener("input", e => { state.filter = e.target.value; render(); });
document.getElementById("refresh").addEventListener("click", () => activeFetch(true));
document.getElementById("refresh2").addEventListener("click", () => activeFetch(true));
document.getElementById("back").addEventListener("click", () => {
  if (history.length > 1) history.back(); else location.hash = "";
});

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
