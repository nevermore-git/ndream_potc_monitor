"use strict";
/* POTC Server Monitor - read-only static viewer.
   Fetches ./status.json (written by the bridge: monitor_client.py --emit), renders a
   sortable / pinnable / filterable list. No dependencies; works on GitHub Pages or any
   static host that serves status.json same-origin. */

const REFRESH_MS = 90000;          // unauthenticated GitHub API = 60 req/hr -> poll every 90s (40/hr)
const STALE_SEC = 240;             // older than this -> flag the timestamp (bridge likely stopped)
const MIN_GAP_MS = 8000;           // min gap between event-driven refetches (one resume fires several events)
const PIN_KEY = "poc.pinned.v1";

const state = {
  data: null,
  sortKey: "num",                  // num | ccu | fps
  sortDir: { num: 1, ccu: -1, fps_avg: -1 },
  filter: "",
  pinned: loadPinned(),
  fetching: false,                 // single-flight guard (no overlapping requests)
  lastFetch: 0,                    // epoch ms of the last fetch start (debounce source)
};

function loadPinned() {
  try { return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || "[]")); }
  catch { return new Set(); }
}
function savePinned() {
  try { localStorage.setItem(PIN_KEY, JSON.stringify([...state.pinned])); } catch {}
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
  return natCmp(a.num, b.num);                 // tiebreak by number
}

function condClass(c) {
  c = (c || "").toLowerCase();
  if (c === "open" || c === "verygood" || c === "good" || c === "normal") return "c-open";
  if (c === "busy" || c === "verybusy") return "c-busy";
  if (c === "overflow") return "c-over";
  return "c-off";
}
function fpsClass(f) { return f == null ? "" : f >= 60 ? "ok" : f >= 30 ? "warn" : "bad"; }
function usageClass(v) { return v == null ? "" : v < 70 ? "ok" : v < 90 ? "warn" : "bad"; }  // CPU/mem %: low=good

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
  // pinned float to top, keeping the chosen sort within each group
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
  const star = document.createElement("span");
  star.className = "c-pin" + (pinned ? " on" : "");
  star.textContent = pinned ? "★" : "☆";
  star.setAttribute("role", "button");
  star.title = "핀 고정/해제";
  star.onclick = () => { togglePin(s.num); };

  const name = document.createElement("span");
  name.className = "c-name";
  name.innerHTML = `<span class="dot ${condClass(s.condition)}"></span><span class="num"></span>`;
  name.querySelector(".num").textContent = dispNum(s.num);   // colored status dot, then number
  name.querySelector(".dot").title = s.condition || "?";     // hover shows full status text

  const ccu = el_span("c-ccu", s.ccu == null ? "–" : s.ccu.toLocaleString());
  const mn = el_span("c-min " + fpsClass(s.fps_min), s.fps_min == null ? "–" : s.fps_min);
  const av = el_span("c-avg " + fpsClass(s.fps_avg), s.fps_avg == null ? "–" : s.fps_avg);
  const mx = el_span("c-max " + fpsClass(s.fps_max), s.fps_max == null ? "–" : s.fps_max);

  el.append(star, name, ccu, mn, av, mx);
  return el;
}
function el_span(cls, text) { const e = document.createElement("span"); e.className = cls; e.textContent = text; return e; }
function dispNum(num) {                    // "1M458" -> "458", "L484" -> "484" (drop the 1M/L prefix)
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

/* Data source: the repo is PUBLIC and status.json lives on its `data` branch. The viewer reads it
   through the UNauthenticated GitHub contents API (Accept: raw) - no token, and the API returns
   fresh content (~60s cache) so it beats the Pages CDN's 5-min cache / 6-min rebuild. The API
   allows 60 req/hr unauthenticated, hence the 90s poll above. On localhost it falls back to the
   same-origin mock so `python -m http.server` previews still work. */
function repoInfo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split("/").filter(Boolean)[0];
  return (m && repo) ? { owner: m[1], repo } : null;   // null => local preview (mock)
}

function setRefreshing(on) {
  const btn = document.getElementById("refresh");
  if (btn) { btn.classList.toggle("spin", on); btn.disabled = on; }
}

/* force=true  -> manual button / first load / reconnect: bypass the debounce (still single-flight).
   force=false -> interval + resume events: skip if a fetch is in flight or one started <MIN_GAP_MS ago.
   A single iOS resume can fire visibilitychange + pageshow + focus together; the debounce collapses
   that burst into one request so the unauthenticated 60 req/hr budget holds. */
async function fetchStatus(force) {
  if (state.fetching) return;
  if (!force && Date.now() - state.lastFetch < MIN_GAP_MS) return;
  state.fetching = true;
  state.lastFetch = Date.now();
  setRefreshing(true);
  const repo = repoInfo();
  const url = repo
    ? `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/status.json?ref=data`
    : "status.json?ts=" + Date.now();
  const opts = repo
    ? { cache: "no-store", headers: { Accept: "application/vnd.github.raw" } }
    : { cache: "no-store" };
  try {
    const r = await fetch(url, opts);
    if (!r.ok) {
      if (r.status === 403 && r.headers.get("X-RateLimit-Remaining") === "0")
        throw new Error("요청 한도 초과 — 잠시 후 자동 갱신");
      throw new Error("HTTP " + r.status);
    }
    state.data = JSON.parse(await r.text());
    document.getElementById("banner").hidden = true;
    render();
  } catch (e) {
    const b = document.getElementById("banner");
    b.hidden = false;
    b.textContent = "데이터 로드 실패: " + e.message + " (자동 재시도 중)";
  } finally {
    state.fetching = false;
    setRefreshing(false);
  }
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
      const d = document.createElement("span");
      d.className = "dir";
      d.textContent = state.sortDir[state.sortKey] > 0 ? " ▲" : " ▼";
      b.appendChild(d);
    }
  }
  render();
});
document.getElementById("filter").addEventListener("input", e => { state.filter = e.target.value; render(); });
document.getElementById("refresh").addEventListener("click", () => fetchStatus(true));

/* Refetch on every path back to the foreground. iOS Safari freezes timers while the PWA/tab is
   backgrounded or the phone is locked, so the 90s interval is suspended and data is stale on resume.
   visibilitychange = tab switch / unlock, pageshow = bfcache restore (back-forward, app resume),
   focus = window focus, online = network reconnect. MIN_GAP_MS dedupes the resume burst. */
document.addEventListener("visibilitychange", () => { if (!document.hidden) fetchStatus(false); });
window.addEventListener("pageshow", () => fetchStatus(false));
window.addEventListener("focus", () => fetchStatus(false));
window.addEventListener("online", () => fetchStatus(true));

setInterval(() => fetchStatus(false), REFRESH_MS);
setInterval(renderUpdated, 1000);
fetchStatus(true);
