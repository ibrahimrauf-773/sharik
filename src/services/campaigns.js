// Core domain: campaigns, investing, escrow, close/release/refund, distributions, purification, wallet.
// Concurrency: capacity is reserved with a single conditional UPDATE (never overfills, even under races);
// state transitions use conditional updateMany (status guard) so retries/duplicate jobs are no-ops;
// every money movement is a balanced journal entry with an idempotency key.
const crypto = require("crypto");
const env = require("../config");
const db = require("../lib/db");
const { E } = require("../lib/errors");
const { audit } = require("../lib/audit");
const cache = require("../lib/cache");
const { N, toPKR, bps, allocateDistribution, fmtPKR } = require("../lib/money");
const L = require("./ledger");
const jobs = require("./jobs");
const { notify } = require("./notify");
const { screen, contractSummary } = require("./shariah");
const PAYMENT_TTL_MS = 30 * 60 * 1000;
const live = { deletedAt: null };
const ref = (p) => p + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
const slugify = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "campaign";
const invalidate = () => cache.delPrefix("campaigns:");

async function raisedMap(ids) {
  const g = await db.investment.groupBy({ by: ["campaignId"], where: { campaignId: { in: ids }, status: { in: ["escrow", "active"] } }, _sum: { amountPaisa: true }, _count: { _all: true } });
  return Object.fromEntries(g.map((r) => [r.campaignId, { raised: N(r._sum.amountPaisa || 0), investors: r._count._all }]));
}
function view(c, r = { raised: 0, investors: 0 }, extra = {}) {
  const daysLeft = c.deadline ? Math.max(0, Math.ceil((new Date(c.deadline) - Date.now()) / 864e5)) : c.durationDays;
  return {
    id: c.id, slug: c.slug, name: c.name, emoji: c.emoji, bg: c.bg, sector: c.sector, structure: c.structure, city: c.city,
    description: c.description, useOfFunds: c.useOfFunds, secpRegNo: c.secpRegNo, status: c.status, investorRatio: c.investorRatio,
    durationDays: c.durationDays, shariahRef: c.shariahRef, reviewNote: c.reviewNote, screening: c.screening, goLiveAt: c.goLiveAt, deadline: c.deadline, closedAt: c.closedAt,
    targetPaisa: N(c.targetPaisa), valuationPaisa: N(c.valuationPaisa), minTicketPaisa: N(c.minTicketPaisa), raisedPaisa: r.raised, committedPaisa: N(c.committedPaisa),
    target: toPKR(c.targetPaisa), valuation: toPKR(c.valuationPaisa), postMoney: toPKR(N(c.valuationPaisa) + N(c.targetPaisa)), minTicket: toPKR(c.minTicketPaisa), raised: toPKR(r.raised),
    remaining: toPKR(N(c.targetPaisa) - N(c.committedPaisa)), investors: r.investors, daysLeft, founder: c.founder ? { id: c.founder.id, name: c.founder.name } : undefined, ...extra,
  };
}
async function list({ status } = {}) {
  const key = "campaigns:list:" + (status || "all");
  const hit = await cache.get(key); if (hit) return hit;
  const cs = await db.campaign.findMany({ where: { ...live, status: status ? status : { in: ["live", "funded", "failed", "closing"] } }, orderBy: [{ status: "desc" }, { id: "asc" }] });
  const r = await raisedMap(cs.map((c) => c.id));
  const out = cs.map((c) => view(c, r[c.id]));
  await cache.set(key, out, 15);
  return out;
}
async function stats() {
  const hit = await cache.get("campaigns:stats"); if (hit) return hit;
  const [raised, investors, liveN] = await Promise.all([
    db.investment.aggregate({ where: { status: { in: ["escrow", "active"] } }, _sum: { amountPaisa: true } }),
    db.investment.findMany({ where: { status: { in: ["escrow", "active"] } }, distinct: ["userId"], select: { userId: true } }),
    db.campaign.count({ where: { ...live, status: "live" } }),
  ]);
  const s = { raised: toPKR(raised._sum.amountPaisa || 0), investors: investors.length, live: liveN };
  await cache.set("campaigns:stats", s, 15); return s;
}
async function getBySlug(slug, user) {
  const c = await db.campaign.findFirst({ where: { slug, ...live }, include: { founder: true, distributions: { where: { status: "posted" }, orderBy: { id: "asc" } }, documents: { where: { deletedAt: null }, orderBy: { id: "asc" } } } });
  if (!c) throw E.notFound("Campaign not found");
  const visible = ["live", "funded", "failed", "closing"].includes(c.status) || (user && (user.role === "admin" || user.id === c.founderId));
  if (!visible) throw E.notFound("Campaign not found");
  const r = (await raisedMap([c.id]))[c.id];
  const docs = c.documents.filter((d) => d.visibility === "public" || (user && (user.role === "admin" || user.id === c.founderId)));
  return view(c, r, {
    distributions: c.distributions.map((d) => ({ id: d.id, period: d.period, netResultPaisa: N(d.netResultPaisa), netResult: toPKR(d.netResultPaisa), impermissiblePct: d.impermissiblePct, note: d.note })),
    documents: docs.map((d) => ({ id: d.id, kind: d.kind, title: d.title, filename: d.filename, mime: d.mime, size: d.size, visibility: d.visibility, createdAt: d.createdAt })),
  });
}
async function mine(user) {
  const cs = await db.campaign.findMany({ where: { founderId: user.id, ...live }, orderBy: { id: "desc" } });
  const r = await raisedMap(cs.map((c) => c.id));
  return cs.map((c) => view(c, r[c.id]));
}
async function adminOverview() {
  const cs = await db.campaign.findMany({ where: live, include: { founder: true }, orderBy: { id: "asc" } });
  const r = await raisedMap(cs.map((c) => c.id));
  return cs.map((c) => view(c, r[c.id]));
}
async function create(user, d, ip) {
  if (!user.emailVerifiedAt) throw E.forbidden("Verify your email before submitting a campaign");
  const base = slugify(d.name); let slug = base, n = 1;
  while (await db.campaign.findUnique({ where: { slug } })) slug = `${base}-${++n}`;
  const data = { slug, name: d.name, sector: d.sector, structure: d.structure, city: d.city, description: d.description, useOfFunds: d.useOfFunds || "", secpRegNo: d.secpRegNo || "",
    targetPaisa: BigInt(d.targetPaisa), valuationPaisa: BigInt(d.valuationPaisa), minTicketPaisa: BigInt(d.minTicketPaisa), investorRatio: d.investorRatio, durationDays: d.durationDays,
    haramSector: d.haramSector, interestDebtRatio: d.interestDebtRatio, interestIncomePct: d.interestIncomePct, emoji: d.emoji || "🚀", bg: d.bg || "#e8f5ee", founderId: user.id };
  data.screening = screen(data);
  const c = await db.campaign.create({ data });
  await audit("campaign.submitted", { actorId: user.id, entity: "Campaign", entityId: c.id, data: { slug, screeningPass: data.screening.pass }, ip });
  return view(c);
}
async function nextShariahRef(tx) {
  const last = await tx.campaign.findFirst({ where: { shariahRef: { startsWith: "SSB-2026-" } }, orderBy: { shariahRef: "desc" }, select: { shariahRef: true } });
  const n = last ? parseInt(last.shariahRef.split("-")[2], 10) + 1 : 41;
  return `SSB-2026-${String(n).padStart(3, "0")}`;
}
async function review(admin, id, { decision, checklist = {}, note = "" }, ip) {
  const out = await db.$transaction(async (tx) => {
    const c = await tx.campaign.findFirst({ where: { id, ...live }, include: { founder: true } });
    if (!c) throw E.notFound("Campaign not found");
    if (c.status !== "pending") throw E.conflict("Campaign already reviewed");
    if (decision === "approve") {
      if (!c.screening?.pass) throw E.bad("Automated screening failed — cannot approve");
      const missing = (c.screening.checks || []).filter((x) => !checklist[x.key]).map((x) => x.key);
      if (missing.length) throw E.bad("Board must confirm every checklist item: " + missing.join(", "));
    }
    const now = new Date();
    const data = decision === "approve"
      ? { status: "live", shariahRef: await nextShariahRef(tx), reviewNote: note, goLiveAt: now, deadline: new Date(now.getTime() + c.durationDays * 864e5) }
      : { status: "rejected", reviewNote: note || "Rejected by Shariah board" };
    const r = await tx.campaign.updateMany({ where: { id, status: "pending" }, data });
    if (r.count !== 1) throw E.conflict("Campaign already reviewed");
    await audit("campaign." + (decision === "approve" ? "approved" : "rejected"), { actorId: admin.id, entity: "Campaign", entityId: id, data: { note, checklist, shariahRef: data.shariahRef }, ip }, tx);
    return { c, data };
  });
  await invalidate();
  await notify({ user: out.c.founder, template: "campaign_reviewed", data: { campaign: out.c.name, decision: decision === "approve" ? "approved" : "rejected", note } });
  return { id, ...out.data };
}

// ---------- investing ----------
async function invest(user, slug, { amountPaisa, method }, idemKey, ip) {
  if (!user.emailVerifiedAt) throw E.forbidden("Verify your email before investing");
  if (idemKey) {
    const prev = await db.investment.findUnique({ where: { idempotencyKey: `${user.id}:${idemKey}` }, include: { payments: true, campaign: true } });
    if (prev) return investView(prev, prev.payments[0], prev.campaign);
  }
  const c = await db.campaign.findFirst({ where: { slug, ...live } });
  if (!c) throw E.notFound("Campaign not found");
  const amt = BigInt(amountPaisa);
  return db.$transaction(async (tx) => {
    // Atomic capacity reservation: succeeds only if live, not past deadline, min ticket ok (or exactly fills), and never exceeds target.
    const rows = await tx.$queryRaw`UPDATE "Campaign" SET "committedPaisa" = "committedPaisa" + ${amt}, "updatedAt" = now()
      WHERE id = ${c.id} AND status = 'live' AND "deletedAt" IS NULL AND (deadline IS NULL OR deadline > now())
        AND "committedPaisa" + ${amt} <= "targetPaisa"
        AND (${amt} >= "minTicketPaisa" OR "committedPaisa" + ${amt} = "targetPaisa")
      RETURNING "committedPaisa", "targetPaisa"`;
    if (!rows.length) {
      const fresh = await tx.campaign.findUnique({ where: { id: c.id } });
      const remaining = N(fresh.targetPaisa) - N(fresh.committedPaisa);
      if (fresh.status !== "live" || (fresh.deadline && fresh.deadline <= new Date())) throw E.conflict("Campaign is not open for investment", "campaign_closed");
      if (N(amt) > remaining) throw E.conflict(`Only ${fmtPKR(remaining)} of capacity remains`, "overfill");
      throw E.bad(`Minimum investment is ${fmtPKR(fresh.minTicketPaisa)}${remaining < N(fresh.minTicketPaisa) ? ` (or exactly the remaining ${fmtPKR(remaining)})` : ""}`);
    }
    const i = await tx.investment.create({ data: { ref: ref("SHK"), amountPaisa: amt, method, userId: user.id, campaignId: c.id, idempotencyKey: idemKey ? `${user.id}:${idemKey}` : null, contract: contractSummary({ investment: { ref: "", amountPaisa: amt }, campaign: c, user }) } });
    await tx.investment.update({ where: { id: i.id }, data: { contract: contractSummary({ investment: i, campaign: c, user }) } });
    const p = await tx.payment.create({ data: { id: "pay_" + crypto.randomBytes(10).toString("hex"), amountPaisa: amt, investmentId: i.id } });
    await audit("investment.created", { actorId: user.id, entity: "Investment", entityId: i.ref, data: { campaign: c.slug, amountPaisa: N(amt), paymentId: p.id }, ip }, tx);
    return { i, p };
  }).then(async ({ i, p }) => {
    await invalidate();
    await jobs.enqueue("expirePayment", { paymentId: p.id }, { delayMs: PAYMENT_TTL_MS, uniqueKey: "expire:" + p.id });
    return investView(i, p, c);
  });
}
function investView(i, p, c) {
  return { ref: i.ref, status: i.status, amountPaisa: N(i.amountPaisa), amount: toPKR(i.amountPaisa), method: i.method, campaign: c ? { slug: c.slug, name: c.name } : undefined,
    payment: p ? { id: p.id, status: p.status, provider: p.provider, amountPaisa: N(p.amountPaisa) } : undefined };
}
async function investmentForUser(user, refStr) {
  const i = await db.investment.findUnique({ where: { ref: refStr }, include: { payments: true, campaign: true } });
  if (!i || (i.userId !== user.id && user.role !== "admin")) throw E.notFound("Investment not found");
  return i;
}

/** Payment confirmed by provider webhook. Idempotent. */
async function paymentSucceeded(paymentId, tx) {
  const p = await tx.payment.findUnique({ where: { id: paymentId }, include: { investment: { include: { campaign: true, user: true } } } });
  if (!p) throw E.notFound("payment not found");
  if (p.status === "succeeded") return { duplicate: true };
  await tx.payment.update({ where: { id: p.id }, data: { status: "succeeded" } });
  const i = p.investment;
  const moved = await tx.investment.updateMany({ where: { id: i.id, status: "pending_payment" }, data: { status: "escrow", settledAt: new Date() } });
  if (moved.count === 1) {
    await L.post(tx, { key: `payment:${p.id}`, kind: "payment", memo: `${i.ref} into escrow`, lines: [L.dr(L.ACC.clearing(), p.amountPaisa), L.cr(L.ACC.escrow(i.campaignId), p.amountPaisa)] });
    return { escrow: true, investment: i };
  }
  // Late payment for a cancelled/expired reservation: money arrived, credit investor wallet (withdrawable).
  await L.post(tx, { key: `payment:${p.id}`, kind: "payment", memo: `${i.ref} late payment → wallet`, lines: [L.dr(L.ACC.clearing(), p.amountPaisa), L.cr(L.ACC.wallet(i.userId), p.amountPaisa)] });
  return { wallet: true, investment: i };
}
async function paymentFailed(paymentId, tx) {
  const p = await tx.payment.findUnique({ where: { id: paymentId }, include: { investment: true } });
  if (!p || p.status !== "pending") return;
  await tx.payment.update({ where: { id: p.id }, data: { status: "failed" } });
  await releaseReservation(tx, p.investment);
}
async function releaseReservation(tx, i) {
  const r = await tx.investment.updateMany({ where: { id: i.id, status: "pending_payment" }, data: { status: "cancelled" } });
  if (r.count === 1) await tx.$executeRaw`UPDATE "Campaign" SET "committedPaisa" = "committedPaisa" - ${i.amountPaisa} WHERE id = ${i.campaignId}`;
}
jobs.register("expirePayment", async ({ paymentId }) => {
  await db.$transaction(async (tx) => {
    const p = await tx.payment.findUnique({ where: { id: paymentId }, include: { investment: true } });
    if (!p || p.status !== "pending") return;
    await tx.payment.update({ where: { id: p.id }, data: { status: "expired" } });
    await releaseReservation(tx, p.investment);
  });
  await invalidate();
});
jobs.register("expireStalePayments", async () => {
  const stale = await db.payment.findMany({ where: { status: "pending", createdAt: { lt: new Date(Date.now() - PAYMENT_TTL_MS) } }, select: { id: true }, take: 200 });
  for (const s of stale) await jobs.enqueue("expirePayment", { paymentId: s.id });
});

// ---------- close / release / refund ----------
async function close(id, actor = null, ip = null) {
  const res = await db.$transaction(async (tx) => {
    const r = await tx.campaign.updateMany({ where: { id, status: "live" }, data: { status: "closing" } });
    if (r.count !== 1) { const c = await tx.campaign.findUnique({ where: { id } }); if (!c) throw E.notFound("Campaign not found"); throw E.conflict(`Campaign is ${c.status}, not live`); }
    const c = await tx.campaign.findUnique({ where: { id } });
    // cancel unpaid reservations
    const pend = await tx.investment.findMany({ where: { campaignId: id, status: "pending_payment" } });
    for (const i of pend) { await tx.payment.updateMany({ where: { investmentId: i.id, status: "pending" }, data: { status: "expired" } }); await releaseReservation(tx, i); }
    const esc = await tx.investment.findMany({ where: { campaignId: id, status: "escrow" }, include: { user: true } });
    const total = esc.reduce((a, i) => a + N(i.amountPaisa), 0);
    const funded = total >= N(c.targetPaisa);
    if (funded) {
      await tx.investment.updateMany({ where: { campaignId: id, status: "escrow" }, data: { status: "active" } });
      const fee = bps(total, env.PLATFORM_FEE_BPS);
      await L.post(tx, { key: `release:campaign:${id}`, kind: "release", memo: `${c.slug} funded — escrow released`, lines: [L.dr(L.ACC.escrow(id), total), L.cr(L.ACC.fee(), fee), L.cr(L.ACC.founder(id), total - fee)] });
      await tx.campaign.update({ where: { id }, data: { status: "funded", closedAt: new Date() } });
    } else {
      await tx.campaign.update({ where: { id }, data: { status: "failed", closedAt: new Date() } });
    }
    await audit("campaign.closed", { actorId: actor?.id ?? null, entity: "Campaign", entityId: id, data: { outcome: funded ? "funded" : "failed", raisedPaisa: total, targetPaisa: N(c.targetPaisa), by: actor ? "admin" : "deadline" }, ip }, tx);
    return { c, funded, total, esc };
  }, { timeout: 30000 });
  await invalidate();
  if (res.funded) for (const i of res.esc) await notify({ user: i.user, template: "campaign_funded", data: { campaign: res.c.name } });
  else for (const i of res.esc) await jobs.enqueue("refundInvestment", { investmentId: i.id }, { uniqueKey: "refund:" + i.id });
  return { status: res.funded ? "funded" : "failed", action: res.funded ? `escrow released to founder (fee ${env.PLATFORM_FEE_BPS / 100}%)` : `refunds queued for ${res.esc.length} investment(s)`, raisedPaisa: res.total, targetPaisa: N(res.c.targetPaisa), raised: toPKR(res.total), target: toPKR(res.c.targetPaisa) };
}
jobs.register("refundInvestment", async ({ investmentId }) => {
  const i = await db.$transaction(async (tx) => {
    const r = await tx.investment.updateMany({ where: { id: investmentId, status: "escrow" }, data: { status: "refunded" } });
    const inv = await tx.investment.findUnique({ where: { id: investmentId }, include: { user: true, campaign: true } });
    if (r.count === 1) await L.post(tx, { key: `refund:investment:${investmentId}`, kind: "refund", memo: `${inv.ref} refunded`, lines: [L.dr(L.ACC.escrow(inv.campaignId), inv.amountPaisa), L.cr(L.ACC.wallet(inv.userId), inv.amountPaisa)] });
    return r.count === 1 ? inv : null;
  });
  if (i) { await audit("investment.refunded", { entity: "Investment", entityId: i.ref, data: { amountPaisa: N(i.amountPaisa) } }); await notify({ user: i.user, template: "campaign_refunded", data: { campaign: i.campaign.name, amount: fmtPKR(i.amountPaisa) } }); }
});
jobs.register("closeDueCampaigns", async () => {
  const due = await db.campaign.findMany({ where: { status: "live", deletedAt: null, deadline: { lte: new Date() } }, select: { id: true } });
  for (const c of due) await close(c.id).catch(() => {});
});

// ---------- distributions ----------
async function createDistribution(admin, id, { period, netResultPaisa, impermissiblePct, note }, ip) {
  const c = await db.campaign.findFirst({ where: { id, ...live } });
  if (!c) throw E.notFound("Campaign not found");
  if (c.status !== "funded") throw E.conflict("Distributions only for funded campaigns");
  const d = await db.distribution.create({ data: { campaignId: id, period, netResultPaisa: BigInt(netResultPaisa), impermissiblePct, note: note || "" } }).catch((e) => { if (e.code === "P2002") throw E.conflict(`A distribution for ${period} already exists`); throw e; });
  await audit("distribution.created", { actorId: admin.id, entity: "Distribution", entityId: d.id, data: { campaign: c.slug, period, netResultPaisa, impermissiblePct }, ip });
  await jobs.enqueue("processDistribution", { distributionId: d.id }, { uniqueKey: "dist:" + d.id });
  return distributionView(d.id);
}
async function distributionView(id) {
  const d = await db.distribution.findUnique({ where: { id }, include: { payouts: true } });
  return { id: d.id, period: d.period, status: d.status, netResultPaisa: N(d.netResultPaisa), netResult: toPKR(d.netResultPaisa), impermissiblePct: d.impermissiblePct,
    payouts: d.payouts.map((p) => ({ investmentId: p.investmentId, userId: p.userId, amountPaisa: N(p.amountPaisa), amount: toPKR(p.amountPaisa), purificationPaisa: N(p.purificationPaisa), purification: toPKR(p.purificationPaisa) })) };
}
jobs.register("processDistribution", async ({ distributionId }) => {
  const res = await db.$transaction(async (tx) => {
    const r = await tx.distribution.updateMany({ where: { id: distributionId, status: "queued" }, data: { status: "posted" } });
    if (r.count !== 1) return null;
    const d = await tx.distribution.findUnique({ where: { id: distributionId }, include: { campaign: true } });
    const invs = await tx.investment.findMany({ where: { campaignId: d.campaignId, status: "active" }, orderBy: { id: "asc" }, include: { user: true } });
    const { rows } = allocateDistribution(d.campaign, invs, d.netResultPaisa, d.impermissiblePct);
    await tx.payout.createMany({ data: rows.map((x) => ({ distributionId, investmentId: x.investmentId, userId: x.userId, amountPaisa: BigInt(x.amountPaisa), purificationPaisa: BigInt(x.purificationPaisa) })) });
    const pos = rows.filter((x) => x.amountPaisa > 0);
    if (pos.length) {
      // Profit cash arrives from the business (via gateway clearing) and is credited to investor wallets. Losses reduce holding value only (no cash moves).
      await L.post(tx, { key: `distribution:${distributionId}`, kind: "distribution", memo: `${d.campaign.slug} ${d.period}`, lines: [L.dr(L.ACC.clearing(), pos.reduce((a, x) => a + x.amountPaisa, 0)), ...pos.map((x) => L.cr(L.ACC.wallet(x.userId), x.amountPaisa))] });
    }
    return { d, rows, invs };
  }, { timeout: 30000 });
  if (!res) return;
  const byInv = Object.fromEntries(res.invs.map((i) => [i.id, i]));
  for (const x of res.rows) await notify({ user: byInv[x.investmentId].user, template: "distribution_posted", data: { campaign: res.d.campaign.name, period: res.d.period, amount: fmtPKR(x.amountPaisa), purification: fmtPKR(x.purificationPaisa) } });
});

// ---------- portfolio / wallet ----------
async function portfolio(user) {
  const [invs, payouts, wallet] = await Promise.all([
    db.investment.findMany({ where: { userId: user.id, status: { not: "cancelled" } }, include: { campaign: true, payouts: true }, orderBy: { id: "asc" } }),
    db.payout.findMany({ where: { userId: user.id }, include: { distribution: { include: { campaign: true } } }, orderBy: { id: "asc" } }),
    L.balance(`wallet:user:${user.id}`),
  ]);
  const holdings = invs.map((i) => {
    const rec = i.payouts.reduce((a, p) => a + N(p.amountPaisa), 0), post = N(i.campaign.valuationPaisa) + N(i.campaign.targetPaisa);
    return { ref: i.ref, status: i.status, amountPaisa: N(i.amountPaisa), amount: toPKR(i.amountPaisa), receivedPaisa: rec, received: toPKR(rec), equitySharePct: (N(i.amountPaisa) / post) * 100, createdAt: i.createdAt,
      campaign: { slug: i.campaign.slug, name: i.campaign.name, emoji: i.campaign.emoji, structure: i.campaign.structure, status: i.campaign.status } };
  });
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const inv = sum(holdings.filter((h) => ["active", "escrow"].includes(h.status)), (h) => h.amountPaisa);
  const escrow = sum(holdings.filter((h) => h.status === "escrow"), (h) => h.amountPaisa);
  const pending = sum(holdings.filter((h) => h.status === "pending_payment"), (h) => h.amountPaisa);
  const refunded = sum(holdings.filter((h) => h.status === "refunded"), (h) => h.amountPaisa);
  const dist = sum(payouts, (p) => N(p.amountPaisa));
  const purify = sum(payouts.filter((p) => !p.donated), (p) => N(p.purificationPaisa));
  return {
    totals: { investedPaisa: inv, escrowPaisa: escrow, pendingPaisa: pending, refundedPaisa: refunded, distributionsPaisa: dist, purifyPaisa: purify, walletPaisa: wallet,
      invested: toPKR(inv), escrow: toPKR(escrow), pending: toPKR(pending), refunded: toPKR(refunded), distributions: toPKR(dist), purify: toPKR(purify), wallet: toPKR(wallet), holdings: holdings.filter((h) => h.status !== "refunded" && h.status !== "pending_payment").length },
    holdings,
    payouts: payouts.map((p) => ({ id: p.id, period: p.distribution.period, campaign: p.distribution.campaign.name, amountPaisa: N(p.amountPaisa), amount: toPKR(p.amountPaisa), purificationPaisa: N(p.purificationPaisa), purification: toPKR(p.purificationPaisa), donated: p.donated, impermissiblePct: p.distribution.impermissiblePct, note: p.distribution.note })),
  };
}
async function purifyAll(user, ip) {
  const due = await db.payout.findMany({ where: { userId: user.id, donated: false, purificationPaisa: { gt: 0 } } });
  let total = 0;
  for (const p of due) {
    await db.$transaction(async (tx) => {
      const r = await tx.payout.updateMany({ where: { id: p.id, donated: false }, data: { donated: true } });
      if (r.count !== 1) return;
      await L.post(tx, { key: `purification:payout:${p.id}`, kind: "purification", memo: "Purification donation", lines: [L.dr(L.ACC.wallet(user.id), p.purificationPaisa), L.cr(L.ACC.purification(), p.purificationPaisa)] });
      total += N(p.purificationPaisa);
    });
  }
  if (total) await audit("purification.donated", { actorId: user.id, entity: "User", entityId: user.id, data: { amountPaisa: total }, ip });
  return { donatedPaisa: total, donated: toPKR(total) };
}
async function withdraw(user, amountPaisa, idemKey, ip) {
  if (!idemKey) throw E.bad("Idempotency-Key header required");
  const key = `withdrawal:user:${user.id}:${idemKey}`;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${user.id})`; // serialise a user's withdrawals
    const dup = await tx.journalEntry.findUnique({ where: { idempotencyKey: key } });
    if (dup) return { duplicate: true, walletPaisa: await L.balance(`wallet:user:${user.id}`, tx) };
    const bal = await L.balance(`wallet:user:${user.id}`, tx);
    if (amountPaisa > bal) throw E.conflict(`Insufficient wallet balance (${fmtPKR(bal)})`, "insufficient_funds");
    await L.post(tx, { key, kind: "withdrawal", memo: "Mock bank withdrawal", lines: [L.dr(L.ACC.wallet(user.id), amountPaisa), L.cr(L.ACC.clearing(), amountPaisa)] });
    await audit("wallet.withdrawal", { actorId: user.id, entity: "User", entityId: user.id, data: { amountPaisa }, ip }, tx);
    return { walletPaisa: bal - amountPaisa, wallet: toPKR(bal - amountPaisa) };
  });
}
async function softDelete(admin, id, ip) {
  const c = await db.campaign.findFirst({ where: { id, ...live } });
  if (!c) throw E.notFound();
  if (!["pending", "rejected"].includes(c.status)) throw E.conflict("Only pending or rejected campaigns can be deleted");
  await db.campaign.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit("campaign.deleted", { actorId: admin.id, entity: "Campaign", entityId: id, ip });
  await invalidate();
}
module.exports = { list, stats, getBySlug, mine, adminOverview, create, review, invest, investView, investmentForUser, paymentSucceeded, paymentFailed, close, createDistribution, distributionView, portfolio, purifyAll, withdraw, softDelete, invalidate, view };
