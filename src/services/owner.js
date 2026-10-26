// Owner (founder/super-admin) dashboard: read-only analytics across money, campaigns, users, investments,
// Shariah compliance, activity, system health and first-party analytics. Every section takes {from,to}
// and returns { kpis, series?, tables } so the same data can be rendered as charts or exported as CSV.
const bcrypt = require("bcryptjs");
const db = require("../lib/db");
const env = require("../config");
const { N, toPKR } = require("../lib/money");
const { hmac } = require("../lib/crypto");
const log = require("../lib/logger");

const DAY = 864e5;
function range({ from, to } = {}) {
  const t = to ? new Date(to) : new Date();
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(String(to))) t.setUTCHours(23, 59, 59, 999); // inclusive end date
  const f = from ? new Date(from) : new Date(t.getTime() - 89 * DAY);
  if (!from) f.setUTCHours(0, 0, 0, 0);
  if (isNaN(f) || isNaN(t) || f > t) throw require("../lib/errors").E.bad("Invalid date range");
  return { from: f, to: t };
}
const day = (d) => new Date(d).toISOString().slice(0, 10);
function days(r) { const out = []; for (let d = new Date(day(r.from)); d <= r.to; d = new Date(d.getTime() + DAY)) out.push(day(d)); return out; }
/** Fill a day-keyed map into a continuous series. */
const fill = (r, rows, keys) => days(r).map((d) => { const o = { date: d }; for (const k of keys) o[k] = rows[d]?.[k] ?? 0; return o; });
const pkr = (p) => toPKR(N(p || 0));

// ---------- Money (double-entry ledger, paisa → PKR) ----------
async function money(q) {
  const r = range(q);
  const rows = await db.$queryRaw`
    SELECT to_char(date_trunc('day', e."createdAt"), 'YYYY-MM-DD') AS d, e.kind,
      COALESCE(SUM(CASE WHEN a.code LIKE 'escrow:%' THEN l."amountPaisa" ELSE 0 END),0)::bigint AS esc,
      COALESCE(SUM(CASE WHEN a.code = 'revenue:platform_fee' THEN l."amountPaisa" ELSE 0 END),0)::bigint AS fee,
      COALESCE(SUM(CASE WHEN l."amountPaisa" > 0 THEN l."amountPaisa" ELSE 0 END),0)::bigint AS gross
    FROM "JournalEntry" e JOIN "LedgerLine" l ON l."entryId" = e.id JOIN "LedgerAccount" a ON a.id = l."accountId"
    WHERE e."createdAt" BETWEEN ${r.from} AND ${r.to} GROUP BY 1, 2`;
  const by = {}, tot = { raised: 0, released: 0, refunded: 0, fees: 0, distributed: 0, purified: 0, withdrawn: 0 };
  for (const x of rows) {
    const o = (by[x.d] ||= {});
    const esc = N(x.esc), fee = N(x.fee), gross = N(x.gross);
    const add = (k, v) => { o[k] = (o[k] || 0) + toPKR(v); tot[k] += v; };
    if (x.kind === "payment") add("raised", -esc > 0 ? -esc : 0);
    if (x.kind === "release") { add("released", esc); add("fees", -fee); }
    if (x.kind === "refund") add("refunded", esc);
    if (x.kind === "distribution") add("distributed", gross);
    if (x.kind === "purification") add("purified", gross);
    if (x.kind === "withdrawal") add("withdrawn", gross);
  }
  // Balances as of `to` (credit-normal accounts shown positive).
  const [bal] = await db.$queryRaw`
    SELECT
      COALESCE(-SUM(CASE WHEN a.code LIKE 'escrow:%' THEN l."amountPaisa" END),0)::bigint AS escrow,
      COALESCE(-SUM(CASE WHEN a.code = 'revenue:platform_fee' THEN l."amountPaisa" END),0)::bigint AS fees,
      COALESCE(-SUM(CASE WHEN a.code LIKE 'wallet:%' THEN l."amountPaisa" END),0)::bigint AS wallets,
      COALESCE(-SUM(CASE WHEN a.code = 'liability:purification_pool' THEN l."amountPaisa" END),0)::bigint AS purification,
      COALESCE(-SUM(CASE WHEN a.code LIKE 'payout:%' THEN l."amountPaisa" END),0)::bigint AS founders,
      COALESCE(SUM(l."amountPaisa"),0)::bigint AS trial
    FROM "LedgerLine" l JOIN "LedgerAccount" a ON a.id = l."accountId" JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE e."createdAt" <= ${r.to}`;
  const keys = Object.keys(tot);
  return {
    range: r,
    kpis: {
      totalRaisedPKR: toPKR(tot.raised), heldInEscrowPKR: pkr(bal.escrow), releasedPKR: toPKR(tot.released), refundedPKR: toPKR(tot.refunded),
      platformFeesPKR: toPKR(tot.fees), platformFeesAllTimePKR: pkr(bal.fees), distributedPKR: toPKR(tot.distributed), withdrawnPKR: toPKR(tot.withdrawn),
      investorWalletsPKR: pkr(bal.wallets), founderPayoutsPKR: pkr(bal.founders), purificationPoolPKR: pkr(bal.purification), ledgerBalanced: N(bal.trial) === 0,
    },
    series: fill(r, by, keys),
  };
}

// ---------- Campaigns ----------
const STATUSES = ["pending", "live", "closing", "funded", "failed", "rejected"];
async function campaigns(q) {
  const r = range(q);
  const inRange = { createdAt: { gte: r.from, lte: r.to }, deletedAt: null };
  const [all, byStatus, list] = await Promise.all([
    db.campaign.count({ where: inRange }),
    db.campaign.groupBy({ by: ["status"], where: inRange, _count: true }),
    db.campaign.findMany({ where: { deletedAt: null }, orderBy: { committedPaisa: "desc" }, take: 10, include: { founder: { select: { name: true } }, _count: { select: { investments: { where: { status: { in: ["escrow", "active"] } } } } } } }),
  ]);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])); for (const g of byStatus) counts[g.status] = g._count;
  const reviewed = all - counts.pending, wentLive = counts.live + counts.closing + counts.funded + counts.failed;
  const created = await db.$queryRaw`SELECT to_char(date_trunc('day',"createdAt"),'YYYY-MM-DD') d, COUNT(*)::int n FROM "Campaign" WHERE "deletedAt" IS NULL AND "createdAt" BETWEEN ${r.from} AND ${r.to} GROUP BY 1`;
  return {
    range: r,
    kpis: { total: all, ...counts, successRatePct: counts.funded + counts.failed ? Math.round((counts.funded / (counts.funded + counts.failed)) * 1000) / 10 : null },
    funnel: [
      { stage: "Submitted", count: all }, { stage: "Shariah reviewed", count: reviewed },
      { stage: "Went live", count: wentLive }, { stage: "Funded", count: counts.funded },
    ],
    series: fill(r, Object.fromEntries(created.map((x) => [x.d, { created: x.n }])), ["created"]),
    top: list.map((c) => ({ id: c.id, slug: c.slug, name: c.name, founder: c.founder.name, sector: c.sector, status: c.status, targetPKR: pkr(c.targetPaisa), committedPKR: pkr(c.committedPaisa), pctFunded: N(c.targetPaisa) ? Math.round((N(c.committedPaisa) / N(c.targetPaisa)) * 1000) / 10 : 0, investors: c._count.investments, deadline: c.deadline })),
  };
}

// ---------- Users ----------
async function users(q) {
  const r = range(q);
  const [byRole, newUsers, kycDone, verified, twofa, total, queue, signups] = await Promise.all([
    db.user.groupBy({ by: ["role"], where: { deletedAt: null }, _count: true }),
    db.user.count({ where: { deletedAt: null, createdAt: { gte: r.from, lte: r.to } } }),
    db.user.count({ where: { deletedAt: null, cnicEnc: { not: null } } }),
    db.user.count({ where: { deletedAt: null, emailVerifiedAt: { not: null } } }),
    db.user.count({ where: { deletedAt: null, totpEnabled: true } }),
    db.user.count({ where: { deletedAt: null } }),
    // KYC queue: investors/founders without CNIC on file (newest first). CNIC itself is never returned.
    db.user.findMany({ where: { deletedAt: null, role: { in: ["investor", "founder"] }, cnicEnc: null }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, name: true, email: true, role: true, createdAt: true, emailVerifiedAt: true } }),
    db.$queryRaw`SELECT to_char(date_trunc('day',"createdAt"),'YYYY-MM-DD') d, role, COUNT(*)::int n FROM "User" WHERE "deletedAt" IS NULL AND "createdAt" BETWEEN ${r.from} AND ${r.to} GROUP BY 1,2`,
  ]);
  const by = {}; for (const x of signups) { const o = (by[x.d] ||= {}); o[x.role] = x.n; o.total = (o.total || 0) + x.n; }
  return {
    range: r,
    kpis: { total, newInRange: newUsers, ...Object.fromEntries(byRole.map((g) => [g.role, g._count])), kycOnFile: kycDone, kycPending: queue.length, emailVerified: verified, twoFactorEnabled: twofa },
    series: fill(r, by, ["total", "investor", "founder"]),
    kycQueue: queue.map((u) => ({ ...u, emailVerified: !!u.emailVerifiedAt, emailVerifiedAt: undefined })),
  };
}

// ---------- Investments ----------
async function investments(q) {
  const r = range(q);
  const w = { createdAt: { gte: r.from, lte: r.to } };
  const [byStatus, agg, per, daily] = await Promise.all([
    db.investment.groupBy({ by: ["status"], where: w, _count: true, _sum: { amountPaisa: true } }),
    db.investment.aggregate({ where: { ...w, status: { in: ["escrow", "active"] } }, _count: true, _avg: { amountPaisa: true }, _max: { amountPaisa: true }, _min: { amountPaisa: true }, _sum: { amountPaisa: true } }),
    db.$queryRaw`SELECT u.id, u.name, u.email, COUNT(i.id)::int n, SUM(i."amountPaisa")::bigint total FROM "Investment" i JOIN "User" u ON u.id = i."userId"
      WHERE i.status IN ('escrow','active') GROUP BY u.id ORDER BY total DESC LIMIT 20`,
    db.$queryRaw`SELECT to_char(date_trunc('day',"createdAt"),'YYYY-MM-DD') d, COUNT(*)::int n, SUM("amountPaisa")::bigint amt FROM "Investment" WHERE status IN ('escrow','active') AND "createdAt" BETWEEN ${r.from} AND ${r.to} GROUP BY 1`,
  ]);
  const limit = Number(process.env.INVESTOR_LIMIT_PKR || 1_000_000); // per-investor exposure threshold (reporting only)
  const investors = await db.investment.findMany({ where: { status: { in: ["escrow", "active"] } }, distinct: ["userId"], select: { userId: true } });
  return {
    range: r,
    kpis: { count: agg._count, volumePKR: pkr(agg._sum.amountPaisa), avgTicketPKR: Math.round(pkr(agg._avg.amountPaisa)), minTicketPKR: pkr(agg._min.amountPaisa), maxTicketPKR: pkr(agg._max.amountPaisa), uniqueInvestorsAllTime: investors.length, perInvestorLimitPKR: limit,
      ...Object.fromEntries(byStatus.map((g) => [`status_${g.status}`, g._count])) },
    series: fill(r, Object.fromEntries(daily.map((x) => [x.d, { investments: x.n, amountPKR: pkr(x.amt) }])), ["investments", "amountPKR"]),
    perInvestor: per.map((x) => ({ userId: x.id, name: x.name, email: x.email, investments: x.n, exposurePKR: pkr(x.total), pctOfLimit: Math.round((pkr(x.total) / limit) * 1000) / 10, overLimit: pkr(x.total) > limit })),
  };
}

// ---------- Shariah / compliance ----------
async function shariah(q) {
  const r = range(q);
  const [pending, flagged, rejected, dists, pool] = await Promise.all([
    db.campaign.findMany({ where: { status: "pending", deletedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, slug: true, name: true, sector: true, structure: true, haramSector: true, interestDebtRatio: true, interestIncomePct: true, createdAt: true } }),
    db.campaign.findMany({ where: { deletedAt: null, OR: [{ haramSector: true }, { interestDebtRatio: { gt: 33 } }, { interestIncomePct: { gt: 5 } }] }, select: { id: true, slug: true, name: true, status: true, haramSector: true, interestDebtRatio: true, interestIncomePct: true } }),
    db.campaign.count({ where: { status: "rejected", deletedAt: null, updatedAt: { gte: r.from, lte: r.to } } }),
    db.distribution.findMany({ where: { createdAt: { gte: r.from, lte: r.to }, impermissiblePct: { gt: 0 } }, include: { campaign: { select: { name: true } } } }),
    db.$queryRaw`SELECT COALESCE(-SUM(l."amountPaisa"),0)::bigint b FROM "LedgerLine" l JOIN "LedgerAccount" a ON a.id=l."accountId" WHERE a.code='liability:purification_pool'`,
  ]);
  const flagsOf = (c) => [c.haramSector && "haram_sector", c.interestDebtRatio > 33 && "interest_debt_ratio>33%", c.interestIncomePct > 5 && "interest_income>5%"].filter(Boolean);
  return {
    range: r,
    kpis: { pendingRulings: pending.length, flaggedCampaigns: flagged.length, rejectedInRange: rejected, distributionsWithImpurity: dists.length, purificationPoolPKR: pkr(pool[0].b),
      oldestPendingDays: pending[0] ? Math.floor((Date.now() - new Date(pending[0].createdAt)) / DAY) : 0 },
    pending: pending.map((c) => ({ ...c, flags: flagsOf(c).join(" ") })),
    flagged: flagged.map((c) => ({ ...c, flags: flagsOf(c).join(" ") })),
    impurity: dists.map((d) => ({ campaign: d.campaign.name, period: d.period, impermissiblePct: d.impermissiblePct, netResultPKR: pkr(d.netResultPaisa) })),
  };
}

// ---------- Activity (audit log) ----------
async function activity(q) {
  const r = range(q);
  const where = { at: { gte: r.from, lte: r.to }, ...(q.action ? { action: { startsWith: q.action } } : {}) };
  const [rows, byAction] = await Promise.all([
    db.auditLog.findMany({ where, orderBy: { id: "desc" }, take: Math.min(+q.limit || 100, 500) }),
    db.auditLog.groupBy({ by: ["action"], where, _count: true, orderBy: { _count: { action: "desc" } }, take: 15 }),
  ]);
  const ids = [...new Set(rows.map((x) => x.actorId).filter(Boolean))];
  const actors = Object.fromEntries((await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, role: true } })).map((u) => [u.id, u]));
  return {
    range: r,
    kpis: { events: byAction.reduce((a, g) => a + g._count, 0), failedLogins: byAction.find((g) => g.action === "auth.login_failed")?._count || 0 },
    byAction: byAction.map((g) => ({ action: g.action, count: g._count })),
    feed: rows.map((x) => ({ id: x.id, at: x.at, action: x.action, actor: actors[x.actorId]?.email || null, actorRole: actors[x.actorId]?.role || null, entity: x.entity, entityId: x.entityId })),
  };
}

// ---------- System ----------
async function system(q) {
  const r = range(q);
  const t0 = Date.now(); await db.$queryRaw`SELECT 1`; const dbMs = Date.now() - t0;
  const [jobs, failedJobs, hooks, hookErrors, migrations] = await Promise.all([
    db.job.groupBy({ by: ["status"], _count: true }),
    db.job.findMany({ where: { status: "failed" }, orderBy: { updatedAt: "desc" }, take: 25, select: { id: true, type: true, attempts: true, lastError: true, updatedAt: true } }),
    db.webhookEvent.groupBy({ by: ["status"], where: { receivedAt: { gte: r.from, lte: r.to } }, _count: true }),
    db.webhookEvent.findMany({ where: { status: "error" }, orderBy: { receivedAt: "desc" }, take: 25, select: { id: true, provider: true, type: true, receivedAt: true } }),
    db.$queryRaw`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`.catch(() => []),
  ]);
  const mem = process.memoryUsage();
  const jobsBy = Object.fromEntries(jobs.map((g) => [g.status, g._count])), hooksBy = Object.fromEntries(hooks.map((g) => [g.status, g._count]));
  return {
    range: r,
    kpis: { status: dbMs < 1000 ? "ok" : "degraded", dbLatencyMs: dbMs, uptimeMin: Math.round(process.uptime() / 60), memoryMB: Math.round(mem.rss / 1048576), node: process.version, env: env.NODE_ENV,
      jobsQueued: jobsBy.queued || 0, jobsRunning: jobsBy.running || 0, jobsDone: jobsBy.done || 0, jobsFailed: jobsBy.failed || 0,
      webhooksProcessed: hooksBy.processed || 0, webhooksIgnored: hooksBy.ignored || 0, webhookErrors: hooksBy.error || 0, lastMigration: migrations[0]?.migration_name || null },
    failedJobs, webhookErrors: hookErrors,
  };
}

// ---------- First-party analytics ----------
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));
async function track(req, { name, path, referrer, cid }) {
  let ref = null; try { if (referrer) { const h = new URL(referrer).hostname; if (h && h !== req.hostname) ref = h; } } catch {}
  const ua = String(req.headers["user-agent"] || "");
  if (/bot|crawl|spider|headless/i.test(ua) && !env.isTest) return { ok: true };
  // Daily-rotating pseudonymous id: same visitor = same hash within a UTC day, unlinkable across days. No IP stored.
  const visitorHash = hmac(env.JWT_ACCESS_SECRET, `${cid || "anon"}:${day(new Date())}`).slice(0, 32);
  let role = null; try { const auth = require("./auth"); role = (await auth.authenticate(req))?.role || null; } catch {}
  await db.analyticsEvent.create({ data: { name: clip(name, 40), path: clip(path, 200), referrer: clip(ref, 120), visitorHash, device: /Mobi|Android/i.test(ua) ? "mobile" : "desktop", role } });
  return { ok: true };
}
async function analytics(q) {
  const r = range(q);
  const [daily, topPaths, refs, events, devices, uniq, signups, investors, paid] = await Promise.all([
    db.$queryRaw`SELECT to_char(date_trunc('day',at),'YYYY-MM-DD') d, COUNT(*) FILTER (WHERE name='pageview')::int pv, COUNT(DISTINCT "visitorHash")::int uv FROM "AnalyticsEvent" WHERE at BETWEEN ${r.from} AND ${r.to} GROUP BY 1`,
    db.$queryRaw`SELECT path, COUNT(*)::int views FROM "AnalyticsEvent" WHERE name='pageview' AND at BETWEEN ${r.from} AND ${r.to} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
    db.$queryRaw`SELECT COALESCE(referrer,'(direct)') referrer, COUNT(DISTINCT "visitorHash")::int visitors FROM "AnalyticsEvent" WHERE at BETWEEN ${r.from} AND ${r.to} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
    db.$queryRaw`SELECT name, COUNT(*)::int n FROM "AnalyticsEvent" WHERE at BETWEEN ${r.from} AND ${r.to} GROUP BY 1 ORDER BY 2 DESC`,
    db.$queryRaw`SELECT device, COUNT(DISTINCT "visitorHash")::int n FROM "AnalyticsEvent" WHERE at BETWEEN ${r.from} AND ${r.to} GROUP BY 1`,
    db.$queryRaw`SELECT COUNT(DISTINCT ("visitorHash", date_trunc('day',at)))::int n FROM "AnalyticsEvent" WHERE at BETWEEN ${r.from} AND ${r.to}`,
    db.user.count({ where: { deletedAt: null, role: { in: ["investor", "founder"] }, createdAt: { gte: r.from, lte: r.to } } }),
    db.$queryRaw`SELECT COUNT(DISTINCT "userId")::int n FROM "Investment" WHERE "createdAt" BETWEEN ${r.from} AND ${r.to}`,
    db.$queryRaw`SELECT COUNT(DISTINCT "userId")::int n FROM "Investment" WHERE status IN ('escrow','active') AND "createdAt" BETWEEN ${r.from} AND ${r.to}`,
  ]);
  const visitors = uniq[0].n, pv = daily.reduce((a, x) => a + x.pv, 0);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    range: r,
    kpis: { pageviews: pv, visitorDays: visitors, signups, startedInvesting: investors[0].n, paidInvestors: paid[0].n, visitToSignupPct: pct(signups, visitors), signupToPaidPct: pct(paid[0].n, signups) },
    series: fill(r, Object.fromEntries(daily.map((x) => [x.d, { pageviews: x.pv, visitors: x.uv }])), ["pageviews", "visitors"]),
    funnel: [{ stage: "Visitors", count: visitors }, { stage: "Sign-ups", count: signups }, { stage: "Started investing", count: investors[0].n }, { stage: "Paid (escrow)", count: paid[0].n }],
    topPaths, referrers: refs, events, devices,
  };
}

async function overview(q) {
  const [m, c, u, i, s, sys, a] = await Promise.all([money(q), campaigns(q), users(q), investments(q), shariah(q), system(q), analytics(q)]);
  return { range: m.range, money: m.kpis, campaigns: c.kpis, users: u.kpis, investments: i.kpis, shariah: s.kpis, system: sys.kpis, analytics: a.kpis };
}

const SECTIONS = { overview, money, campaigns, users, investments, shariah, activity, system, analytics };
// Which table each section exports as CSV.
const CSV_TABLE = { money: "series", campaigns: "top", users: "kycQueue", investments: "perInvestor", shariah: "pending", activity: "feed", system: "failedJobs", analytics: "series" };
function toCSV(rows) {
  if (!rows || !rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => { if (v == null) return ""; if (v instanceof Date) v = v.toISOString(); else if (typeof v === "object") v = JSON.stringify(v); else v = String(v);
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; // CSV/formula injection guard
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}
async function exportCSV(section, q) {
  if (section === "overview") { const o = await overview(q); return toCSV(Object.entries(o).filter(([k]) => k !== "range").flatMap(([sec, k]) => Object.entries(k).map(([metric, value]) => ({ section: sec, metric, value })))); }
  const data = await SECTIONS[section](q);
  return toCSV(data[CSV_TABLE[section]]);
}

/** Idempotent production owner bootstrap from OWNER_EMAIL / OWNER_PASSWORD (never logged). */
async function ensureOwnerFromEnv(e = process.env) {
  const email = (e.OWNER_EMAIL || "").trim().toLowerCase(), pw = e.OWNER_PASSWORD || "";
  if (!email || !pw) return { created: false, skipped: true };
  if (pw.length < 12) { log.warn("OWNER_PASSWORD too short (min 12 chars); owner not provisioned"); return { skipped: true }; }
  const u = await db.user.findUnique({ where: { email } });
  if (u) {
    const same = await bcrypt.compare(pw, u.passwordHash);
    await db.user.update({ where: { id: u.id }, data: { role: "owner", deletedAt: null, ...(same ? {} : { passwordHash: await bcrypt.hash(pw, 12) }) } });
    if (u.role !== "owner" || !same) await require("../lib/audit").audit("owner.provisioned", { entity: "User", entityId: u.id, data: { updatedPassword: !same, promoted: u.role !== "owner" } });
    return { created: false, id: u.id };
  }
  const c = await db.user.create({ data: { email, name: e.OWNER_NAME || "Founder", role: "owner", passwordHash: await bcrypt.hash(pw, 12), emailVerifiedAt: new Date() } });
  await require("../lib/audit").audit("owner.provisioned", { entity: "User", entityId: c.id, data: { created: true } });
  return { created: true, id: c.id };
}

module.exports = { ...SECTIONS, SECTIONS, exportCSV, toCSV, track, range, ensureOwnerFromEnv };
