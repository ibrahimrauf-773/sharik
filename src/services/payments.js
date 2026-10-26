// Mock payment provider ("mockpay") with Stripe-style signed webhooks.
// Signature header: X-Mockpay-Signature: t=<unix>,v1=<hex hmac_sha256(WEBHOOK_SECRET, `${t}.${rawBody}`)>
// Processing is idempotent (WebhookEvent PK = event id, written in the same transaction as the effect).
const crypto = require("crypto");
const env = require("../config");
const db = require("../lib/db");
const log = require("../lib/logger");
const { E } = require("../lib/errors");
const { hmac, safeEqual } = require("../lib/crypto");
const { audit } = require("../lib/audit");
const jobs = require("./jobs");
const camp = require("./campaigns");
const { notify } = require("./notify");
const { fmtPKR } = require("../lib/money");
const TOLERANCE_S = 300;
function sign(raw, t = Math.floor(Date.now() / 1000)) { return `t=${t},v1=${hmac(env.WEBHOOK_SECRET, `${t}.${raw}`)}`; }
function verify(raw, header) {
  if (!header) throw E.unauth("Missing signature", "bad_signature");
  const parts = Object.fromEntries(String(header).split(",").map((kv) => kv.split("=")));
  const t = +parts.t;
  if (!t || Math.abs(Date.now() / 1000 - t) > TOLERANCE_S) throw E.unauth("Signature timestamp outside tolerance", "bad_signature");
  if (!parts.v1 || !safeEqual(parts.v1, hmac(env.WEBHOOK_SECRET, `${t}.${raw}`))) throw E.unauth("Invalid signature", "bad_signature");
}
async function processEvent(evt) {
  const res = await db.$transaction(async (tx) => {
    try { await tx.webhookEvent.create({ data: { id: evt.id, provider: "mockpay", type: evt.type, payload: evt } }); }
    catch (e) { if (e.code === "P2002") return { duplicate: true }; throw e; }
    if (evt.type === "payment.succeeded") return camp.paymentSucceeded(evt.data.paymentId, tx);
    if (evt.type === "payment.failed") { await camp.paymentFailed(evt.data.paymentId, tx); return { failed: true }; }
    await tx.webhookEvent.update({ where: { id: evt.id }, data: { status: "ignored" } });
    return { ignored: true };
  });
  if (res.duplicate) return { ok: true, duplicate: true };
  await camp.invalidate();
  if (res.escrow) {
    await audit("payment.succeeded", { entity: "Payment", entityId: evt.data.paymentId, data: { ref: res.investment.ref } });
    await notify({ user: res.investment.user, template: "investment_confirmed", data: { campaign: res.investment.campaign.name, amount: fmtPKR(res.investment.amountPaisa), ref: res.investment.ref } });
  }
  return { ok: true };
}
async function handleWebhook(raw, header) {
  verify(raw, header);
  let evt; try { evt = JSON.parse(raw); } catch { throw E.bad("Invalid JSON"); }
  if (!evt?.id || !evt?.type) throw E.bad("Malformed event");
  return processEvent(evt);
}
/** Simulate the customer completing payment at the provider → provider sends a webhook (with retries). */
async function mockPay(user, paymentId, outcome = "succeeded") {
  const p = await db.payment.findUnique({ where: { id: paymentId }, include: { investment: true } });
  if (!p || (p.investment.userId !== user.id && user.role !== "admin")) throw E.notFound("Payment not found");
  if (p.status !== "pending") throw E.conflict(`Payment is ${p.status}`);
  const evt = { id: "evt_" + crypto.randomBytes(10).toString("hex"), type: outcome === "failed" ? "payment.failed" : "payment.succeeded", created: Math.floor(Date.now() / 1000), data: { paymentId, amountPaisa: Number(p.amountPaisa) } };
  await jobs.enqueue("deliverWebhook", { event: evt }, { maxAttempts: 8, uniqueKey: "wh:" + paymentId + ":" + outcome });
  return { queued: true, eventId: evt.id };
}
jobs.register("deliverWebhook", async ({ event }) => {
  const raw = JSON.stringify(event);
  if (env.JOBS_MODE === "inline") return handleWebhook(raw, sign(raw)); // tests/scripts: no HTTP hop
  const r = await fetch(`${env.API_URL}/api/v1/webhooks/mockpay`, { method: "POST", headers: { "Content-Type": "application/json", "X-Mockpay-Signature": sign(raw) }, body: raw, signal: AbortSignal.timeout(10000) });
  if (!r.ok) { const t = await r.text().catch(() => ""); log.warn({ status: r.status, t }, "webhook delivery failed"); throw new Error(`webhook HTTP ${r.status}`); }
});
module.exports = { sign, verify, handleWebhook, processEvent, mockPay };
