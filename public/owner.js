// Sharik owner dashboard (founder only, TOTP required). Plain JS + inline SVG charts (CSP: script-src 'self', no CDNs).
(() => {
const API = (window.SHARIK_API_BASE || "").replace(/\/$/, "") + "/api/v1";
const $ = (s) => document.querySelector(s), root = $("#root");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const rs = (x) => "Rs " + Math.round(Number(x) || 0).toLocaleString("en-PK");
const num = (x) => (typeof x === "number" ? x.toLocaleString("en-PK") : x === true ? "✔" : x === false ? "✖" : esc(x ?? "—"));
const label = (k) => k.replace(/PKR$/, "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
const fmt = (k, v) => (/PKR$/.test(k) ? rs(v) : /Pct$/.test(k) && v != null ? v + "%" : num(v));
const COLORS = ["#13805a", "#d97706", "#2563eb", "#b42318", "#7c3aed", "#0891b2", "#64748b"];
let AT = null; const csrf = () => localStorage.getItem("sharik_csrf");
const SECTIONS = [["overview", "Overview"], ["money", "Money"], ["campaigns", "Campaigns"], ["users", "Users & KYC"], ["investments", "Investments"], ["shariah", "Shariah"], ["activity", "Activity"], ["system", "System"], ["analytics", "Analytics"]];
const today = new Date(), iso = (d) => d.toISOString().slice(0, 10);
const state = { section: (location.hash.slice(1) || "overview"), from: iso(new Date(today - 89 * 864e5)), to: iso(today) };

async function refresh() { if (!csrf()) return false; const r = await fetch(API + "/auth/refresh", { method: "POST", credentials: "include", headers: { "X-CSRF-Token": csrf() } }); if (!r.ok) return false; const j = await r.json(); AT = j.accessToken; if (j.user?.role !== "owner") return false; return true; }
async function get(path, raw) {
  let r = await fetch(API + path, { credentials: "include", headers: AT ? { Authorization: "Bearer " + AT } : {} });
  if (r.status === 401 && (await refresh())) r = await fetch(API + path, { credentials: "include", headers: { Authorization: "Bearer " + AT } });
  if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new Error(j.error?.message || r.statusText); e.code = j.error?.code; e.status = r.status; throw e; }
  return raw ? r : r.json();
}

// ---------- SVG charts ----------
function line(series, keys, { money = false, h = 220 } = {}) {
  if (!series?.length) return "<p class=mut>No data</p>";
  const W = 760, H = h, P = { l: 58, r: 10, t: 10, b: 24 }, n = series.length;
  const max = Math.max(1, ...series.flatMap((d) => keys.map((k) => d[k] || 0)));
  const x = (i) => P.l + (i * (W - P.l - P.r)) / Math.max(1, n - 1), y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(max * t)}" y2="${y(max * t)}" stroke="#eef2ef"/><text x="${P.l - 6}" y="${y(max * t) + 4}" font-size="10" text-anchor="end" fill="#5d6d65">${money ? compact(max * t) : Math.round(max * t)}</text>`).join("");
  const step = Math.ceil(n / 8), xl = series.map((d, i) => (i % step ? "" : `<text x="${x(i)}" y="${H - 6}" font-size="10" text-anchor="middle" fill="#5d6d65">${d.date.slice(5)}</text>`)).join("");
  const paths = keys.map((k, j) => `<path d="${series.map((d, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(d[k] || 0).toFixed(1)).join(" ")}" fill="none" stroke="${COLORS[j]}" stroke-width="2"><title>${esc(label(k))}</title></path>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${ticks}${xl}${paths}</svg>` + legend(keys);
}
const compact = (v) => (v >= 1e7 ? (v / 1e7).toFixed(1) + "Cr" : v >= 1e5 ? (v / 1e5).toFixed(1) + "L" : v >= 1e3 ? (v / 1e3).toFixed(0) + "k" : Math.round(v));
const legend = (keys) => `<div class="lg">${keys.map((k, j) => `<span><i style="background:${COLORS[j]}"></i>${esc(label(k))}</span>`).join("")}</div>`;
function bars(rows, lk, vk) {
  if (!rows?.length) return "<p class=mut>No data</p>";
  const max = Math.max(1, ...rows.map((r) => r[vk]));
  return `<table>${rows.map((r) => `<tr><td style="width:38%">${esc(r[lk])}</td><td><div class="bar" style="width:${Math.max(4, (r[vk] / max) * 100)}%">${num(r[vk])}</div></td></tr>`).join("")}</table>`;
}
function donut(obj) {
  const e = Object.entries(obj).filter(([, v]) => v > 0), tot = e.reduce((a, [, v]) => a + v, 0);
  if (!tot) return "<p class=mut>No data</p>";
  let a0 = -Math.PI / 2; const arcs = e.map(([k, v], i) => { const a1 = a0 + (v / tot) * 2 * Math.PI, big = a1 - a0 > Math.PI ? 1 : 0, p = (a) => `${80 + 60 * Math.cos(a)} ${80 + 60 * Math.sin(a)}`;
    const d = e.length === 1 ? `M80 20 A60 60 0 1 1 79.99 20` : `M${p(a0)} A60 60 0 ${big} 1 ${p(a1)}`; a0 = a1; return `<path d="${d}" fill="none" stroke="${COLORS[i % 7]}" stroke-width="26"><title>${esc(k)}: ${v}</title></path>`; }).join("");
  return `<div style="display:flex;gap:16px;align-items:center"><svg viewBox="0 0 160 160" width="150">${arcs}<text x="80" y="86" text-anchor="middle" font-size="18" font-weight="700">${tot}</text></svg><div class="lg" style="flex-direction:column">${e.map(([k, v], i) => `<span><i style="background:${COLORS[i % 7]}"></i>${esc(label(k))}: <b>${v}</b></span>`).join("")}</div></div>`;
}
function table(rows, cols) {
  if (!rows?.length) return "<p class=mut>Nothing here 🎉</p>";
  cols = cols || Object.keys(rows[0]);
  return `<div style="overflow-x:auto"><table><tr>${cols.map((c) => `<th>${esc(label(c))}</th>`).join("")}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${/At$|^at$|deadline/.test(c) && r[c] ? esc(new Date(r[c]).toLocaleString()) : fmt(c, r[c])}</td>`).join("")}</tr>`).join("")}</table></div>`;
}
const kpis = (o, pick) => `<div class="kpis">${Object.entries(o).filter(([k]) => !pick || pick.includes(k)).map(([k, v]) => `<div class="k"><small>${esc(label(k))}</small><b class="${k === "ledgerBalanced" ? (v ? "ok" : "bad") : /failed|error/i.test(k) && v > 0 ? "bad" : ""}">${fmt(k, v)}</b></div>`).join("")}</div>`;
const card = (title, body, csv) => `<div class="card"><h3>${esc(title)}${csv ? `<button class="btn o" data-csv="${csv}">⬇ CSV</button>` : ""}</h3>${body}</div>`;

// ---------- section renderers ----------
const R = {
  overview: (d) => [["Money", d.money, ["totalRaisedPKR", "heldInEscrowPKR", "releasedPKR", "refundedPKR", "platformFeesPKR", "ledgerBalanced"]], ["Campaigns", d.campaigns, ["total", "pending", "live", "funded", "failed", "successRatePct"]], ["Users", d.users, ["total", "newInRange", "investor", "founder", "kycPending"]], ["Investments", d.investments, ["count", "volumePKR", "avgTicketPKR", "uniqueInvestorsAllTime"]], ["Shariah", d.shariah, ["pendingRulings", "flaggedCampaigns", "purificationPoolPKR"]], ["Traffic", d.analytics, ["pageviews", "visitorDays", "signups", "visitToSignupPct", "signupToPaidPct"]], ["System", d.system, ["status", "dbLatencyMs", "jobsFailed", "webhookErrors", "lastMigration"]]].map(([t, o, p]) => card(t, kpis(o, p))).join("") + `<p class=mut>Export everything: <button class="btn o" data-csv="overview">⬇ Overview CSV</button></p>`,
  money: (d) => kpis(d.kpis) + card("Money flow per day (PKR)", line(d.series, ["raised", "released", "refunded", "fees"], { money: true }), "money") + card("Distributions & withdrawals (PKR)", line(d.series, ["distributed", "withdrawn", "purified"], { money: true })),
  campaigns: (d) => kpis(d.kpis) + `<div class="grid2">${card("Funnel", bars(d.funnel, "stage", "count"))}${card("By status", donut(Object.fromEntries(["pending", "live", "closing", "funded", "failed", "rejected"].map((k) => [k, d.kpis[k]]))))}</div>` + card("New campaigns per day", line(d.series, ["created"])) + card("Top campaigns", table(d.top, ["name", "founder", "sector", "status", "targetPKR", "committedPKR", "pctFunded", "investors", "deadline"]), "campaigns"),
  users: (d) => kpis(d.kpis) + card("Sign-ups per day", line(d.series, ["total", "investor", "founder"])) + card(`KYC queue (no CNIC on file) — ${d.kycQueue.length}`, table(d.kycQueue, ["name", "email", "role", "emailVerified", "createdAt"]), "users"),
  investments: (d) => kpis(d.kpis) + `<div class="grid2">${card("Investments per day", line(d.series, ["investments"]))}${card("Volume per day (PKR)", line(d.series, ["amountPKR"], { money: true }))}</div>` + card(`Per-investor exposure (limit ${rs(d.kpis.perInvestorLimitPKR)})`, table(d.perInvestor, ["name", "email", "investments", "exposurePKR", "pctOfLimit", "overLimit"]), "investments"),
  shariah: (d) => kpis(d.kpis) + card("Pending Shariah rulings", table(d.pending, ["name", "sector", "structure", "flags", "interestDebtRatio", "interestIncomePct", "createdAt"]), "shariah") + card("Flagged campaigns (haram sector / interest ratios)", table(d.flagged, ["name", "status", "flags", "interestDebtRatio", "interestIncomePct"])) + card("Distributions with impermissible income", table(d.impurity)),
  activity: (d) => kpis(d.kpis) + `<div class="grid2">${card("Top actions", bars(d.byAction, "action", "count"))}${card("Live feed (auto-refresh 15s)", `<div style="max-height:420px;overflow:auto">${table(d.feed, ["at", "action", "actor", "actorRole", "entity", "entityId"])}</div>`, "activity")}</div>`,
  system: (d) => kpis(d.kpis) + card("Failed jobs", table(d.failedJobs), "system") + card("Webhook errors", table(d.webhookErrors)),
  analytics: (d) => kpis(d.kpis) + card("Traffic per day", line(d.series, ["pageviews", "visitors"]), "analytics") + `<div class="grid2">${card("Conversion funnel", bars(d.funnel, "stage", "count"))}${card("Devices", donut(Object.fromEntries(d.devices.map((x) => [x.device, x.n]))))}${card("Top pages", bars(d.topPaths, "path", "views"))}${card("Referrers (unique visitors)", bars(d.referrers, "referrer", "visitors"))}${card("Events", bars(d.events, "name", "n"))}</div><p class=mut>Privacy: first-party only, no cookies, no IP addresses; visitor ids are hashed and rotate daily.</p>`,
};

let timer = null;
async function render() {
  clearTimeout(timer);
  const s = SECTIONS.find((x) => x[0] === state.section) ? state.section : "overview";
  root.innerHTML = `<header><b>🟢 Sharik · Owner</b><span class="sp"></span><label>From <input type="date" id="from" value="${state.from}"></label><label>To <input type="date" id="to" value="${state.to}"></label><button class="btn" id="apply">Apply</button><button class="btn o" id="out">Sign out</button></header>
  <nav>${SECTIONS.map(([k, t]) => `<a href="#${k}" class="${k === s ? "on" : ""}">${t}</a>`).join("")}</nav><main id="main"><p class=mut>Loading…</p></main>`;
  $("#apply").onclick = () => { state.from = $("#from").value; state.to = $("#to").value; render(); };
  $("#out").onclick = async () => { await fetch(API + "/auth/logout", { method: "POST", credentials: "include", headers: { "X-CSRF-Token": csrf() || "", ...(AT ? { Authorization: "Bearer " + AT } : {}) } }).catch(() => {}); AT = null; localStorage.removeItem("sharik_csrf"); loginView(); };
  try {
    const d = await get(`/owner/${s}?from=${state.from}&to=${state.to}`);
    $("#main").innerHTML = R[s](d) + `<p class=mut style="font-size:12px">Range ${esc(new Date(d.range.from).toLocaleDateString())} – ${esc(new Date(d.range.to).toLocaleDateString())} · generated ${new Date().toLocaleTimeString()}</p>`;
    document.querySelectorAll("[data-csv]").forEach((b) => (b.onclick = () => csv(b.dataset.csv)));
    if (s === "activity" || s === "system") timer = setTimeout(render, 15000);
  } catch (e) { if (e.status === 401) return loginView(); $("#main").innerHTML = `<div class="card bad">${esc(e.message)}${e.code === "totp_setup_required" ? " — enable 2FA from the Account page of the main app, then sign in again." : ""}</div>`; }
}
async function csv(section) {
  const r = await get(`/owner/${section}?format=csv&from=${state.from}&to=${state.to}`, true);
  const url = URL.createObjectURL(await r.blob()), a = document.createElement("a");
  a.href = url; a.download = `sharik-${section}-${state.from}_to_${state.to}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function loginView(msg) {
  root.innerHTML = `<div id="login" class="card"><h2>Owner sign-in</h2><p class=mut>Founder only. Two-factor code required.</p><form id="lf"><label>Email<input name="email" type="email" required autocomplete="username"></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label><label>Authenticator code<input name="totp" inputmode="numeric" pattern="\\d{6}" autocomplete="one-time-code" required></label><p class="err" id="err">${esc(msg || "")}</p><button class="btn" style="width:100%">Sign in</button></form></div>`;
  $("#lf").onsubmit = async (ev) => {
    ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target));
    const r = await fetch(API + "/auth/login", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return ($("#err").textContent = j.error?.message || "Sign-in failed");
    if (j.user.role !== "owner") { $("#err").textContent = "This dashboard is for the owner account only."; return; }
    AT = j.accessToken; localStorage.setItem("sharik_csrf", j.csrfToken); render();
  };
}
addEventListener("hashchange", () => { state.section = location.hash.slice(1) || "overview"; if (AT) render(); });
(async () => { try { if (await refresh()) return render(); } catch {} loginView(); })();
})();
