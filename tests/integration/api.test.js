import { describe, it, expect, beforeAll } from "vitest";
const { app, request, agent, login } = require("./helpers");
const db = require("../../src/lib/db");
const L = require("../../src/services/ledger");
const payments = require("../../src/services/payments");
const { authenticator } = require("otplib");
const V = "/api/v1";
let inv, adm, fnd;
const idOf = async (slug) => (await request(app).get(`${V}/campaigns/${slug}`)).body.id;
async function investAndPay(a, slug, amount, key) {
  const r = await a.auth(a.post(`${V}/campaigns/${slug}/invest`)).set(key ? { "Idempotency-Key": key } : {}).send({ amount, consentRisk: true, consentContract: true });
  if (r.status !== 201) return r;
  const p = await a.auth(a.post(`${V}/payments/${r.body.payment.id}/mock-pay`)).send({});
  expect(p.status).toBe(200);
  return a.auth(a.get(`${V}/investments/${r.body.ref}`));
}
const balanced = async () => (await db.$transaction((tx) => L.trialBalance(tx))).balanced;

beforeAll(async () => {
  inv = await login("investor@sharik.demo", "Investor@123");
  adm = await login("admin@sharik.demo", "Admin@123");
  fnd = await login("founder@sharik.demo", "Founder@123");
});

describe("platform", () => {
  it("health + openapi + versioning", async () => {
    expect((await request(app).get("/health")).body.ok).toBe(true);
    const h = await request(app).get(`${V}/health`); expect(h.status).toBe(200);
    const o = await request(app).get("/api/openapi.json"); expect(o.body.openapi).toMatch(/^3/); expect(Object.keys(o.body.paths).length).toBeGreaterThan(30);
    const r = await request(app).get("/api/campaigns"); expect(r.status).toBe(404); expect(r.body.error.message).toMatch(/v1/);
  });
  it("security headers + error shape + validation", async () => {
    const r = await request(app).get(`${V}/campaigns`); expect(r.headers["x-content-type-options"]).toBe("nosniff"); expect(r.headers["content-security-policy"]).toBeTruthy();
    const v = await request(app).post(`${V}/auth/register`).send({ email: "nope", password: "x" });
    expect(v.status).toBe(400); expect(v.body.error.code).toBe("validation_failed"); expect(v.body.error.details).toBeTruthy(); expect(v.body.error.requestId).toBeTruthy();
  });
  it("rejects unknown cross-site origins on unsafe methods", async () => {
    const r = await request(app).post(`${V}/auth/login`).set("Origin", "https://evil.example").send({ email: "investor@sharik.demo", password: "Investor@123" });
    expect(r.status).toBe(403); expect(r.body.error.code).toBe("bad_origin");
  });
  it("seeded ledger is balanced", async () => expect(await balanced()).toBe(true));
});

describe("auth", () => {
  it("wrong password 401, guards enforce roles", async () => {
    expect((await request(app).post(`${V}/auth/login`).send({ email: "investor@sharik.demo", password: "bad" })).status).toBe(401);
    expect((await request(app).get(`${V}/portfolio`)).status).toBe(401);
    expect((await inv.auth(inv.get(`${V}/admin/overview`))).status).toBe(403);
    expect((await fnd.auth(fnd.post(`${V}/campaigns/taleem-box/invest`)).send({ amount: 5000, consentRisk: true, consentContract: true })).status).toBe(403);
    expect((await adm.auth(adm.get(`${V}/admin/overview`))).status).toBe(200);
    expect((await request(app).get(`${V}/auth/me`).set("Authorization", "Bearer garbage")).status).toBe(401);
  });
  it("refresh requires CSRF header, rotates, and detects reuse", async () => {
    const a = await login("crowd1@sharik.demo", "Crowd@1234");
    const old = a.jar.getCookie("shareek_rt", { path: "/api/v1/auth", domain: "127.0.0.1", secure: false, script: false });
    expect((await a.post(`${V}/auth/refresh`)).status).toBe(403);
    const r = await a.post(`${V}/auth/refresh`).set("X-CSRF-Token", a.csrf);
    expect(r.status).toBe(200); expect(r.body.accessToken).toBeTruthy();
    expect(String(r.headers["set-cookie"])).toMatch(/HttpOnly/i);
    // replay the old (rotated) refresh token -> session revoked
    const replay = await request(app).post(`${V}/auth/refresh`).set("Cookie", `shareek_rt=${old ? old.value : "x"}`).set("X-CSRF-Token", a.csrf);
    expect(replay.status).toBe(401);
    const after = await request(app).get(`${V}/auth/me`).set("Authorization", "Bearer " + r.body.accessToken);
    expect(after.status).toBe(401);
  });
  it("logout revokes the access token immediately", async () => {
    const a = await login("crowd2@sharik.demo", "Crowd@1234");
    expect((await a.auth(a.post(`${V}/auth/logout`)).set("X-CSRF-Token", a.csrf)).status).toBeLessThan(300);
    expect((await a.auth(a.get(`${V}/auth/me`))).status).toBe(401);
  });
  it("register -> verify email via outbox -> forgot/reset password", async () => {
    const a = agent(); const email = `new${Date.now()}@example.com`;
    const r = await a.post(`${V}/auth/register`).send({ name: "New Person", email, password: "Passw0rd!x" });
    expect(r.status).toBe(201); expect(r.body.user.emailVerified).toBe(false);
    const n = await db.notification.findFirst({ where: { to: email, template: "verify_email" }, orderBy: { id: "desc" } });
    const tok = JSON.stringify(n).match(/#\/verify\/([A-Za-z0-9_-]+)/)[1];
    expect((await request(app).post(`${V}/auth/verify-email`).send({ token: tok })).status).toBe(200);
    expect((await request(app).post(`${V}/auth/verify-email`).send({ token: tok })).status).toBe(400);
    expect((await request(app).post(`${V}/auth/forgot-password`).send({ email: "nobody@example.com" })).status).toBe(200);
    await request(app).post(`${V}/auth/forgot-password`).send({ email });
    const m = await db.notification.findFirst({ where: { to: email, template: "reset_password" }, orderBy: { id: "desc" } });
    const rt = JSON.stringify(m).match(/#\/reset\/([A-Za-z0-9_-]+)/)[1];
    expect((await request(app).post(`${V}/auth/reset-password`).send({ token: rt, password: "N3wPassw0rd!" })).status).toBe(200);
    expect((await a.post(`${V}/auth/refresh`).set("X-CSRF-Token", r.body.csrfToken)).status).toBe(401); // sessions revoked
    await login(email, "N3wPassw0rd!");
  });
  it("TOTP 2FA setup/enable/login/disable", async () => {
    const a = await login("crowd3@sharik.demo", "Crowd@1234");
    const s = await a.auth(a.post(`${V}/auth/2fa/setup`)); expect(s.body.qrDataUrl).toMatch(/^data:image\/png/);
    expect((await a.auth(a.post(`${V}/auth/2fa/enable`)).send({ code: "000000" })).status).toBe(400);
    expect((await a.auth(a.post(`${V}/auth/2fa/enable`)).send({ code: authenticator.generate(s.body.secret) })).status).toBe(200);
    const no = await request(app).post(`${V}/auth/login`).send({ email: "crowd3@sharik.demo", password: "Crowd@1234" });
    expect(no.status).toBe(401); expect(no.body.error.code).toBe("totp_required");
    const b = await login("crowd3@sharik.demo", "Crowd@1234", authenticator.generate(s.body.secret));
    expect((await b.auth(b.post(`${V}/auth/2fa/disable`)).send({ password: "Crowd@1234", code: authenticator.generate(s.body.secret) })).status).toBe(200);
    await login("crowd3@sharik.demo", "Crowd@1234");
  });
  it("KYC CNIC is encrypted at rest", async () => {
    const r = await inv.auth(inv.post(`${V}/me/kyc`)).send({ cnic: "35202-1234567-1", phone: "+92 321 7654321" });
    expect(r.status).toBe(200);
    const u = await db.user.findUnique({ where: { email: "investor@sharik.demo" } });
    expect(JSON.stringify(u)).not.toContain("35202"); expect(u.cnicEnc).toMatch(/^v1\./); expect(u.cnicLast4).toBe("5671");
    expect(require("../../src/lib/crypto").decrypt(u.cnicEnc)).toMatch(/35202-?1234567-?1/);
  });
});

describe("investing, escrow, webhooks", () => {
  it("enforces min ticket and consents", async () => {
    expect((await inv.auth(inv.post(`${V}/campaigns/taleem-box/invest`)).send({ amount: 4999, consentRisk: true, consentContract: true })).status).toBe(400);
    expect((await inv.auth(inv.post(`${V}/campaigns/taleem-box/invest`)).send({ amount: 5000, consentRisk: true })).status).toBe(400);
  });
  it("invest -> signed webhook -> escrow; idempotency key replays", async () => {
    const before = (await request(app).get(`${V}/campaigns/taleem-box`)).body.raised;
    const r = await investAndPay(inv, "taleem-box", 10000, "k-abc-0001");
    expect(r.body.status).toBe("escrow");
    const again = await inv.auth(inv.post(`${V}/campaigns/taleem-box/invest`)).set("Idempotency-Key", "k-abc-0001").send({ amount: 10000, consentRisk: true, consentContract: true });
    expect(again.body.ref).toBe(r.body.ref);
    expect((await request(app).get(`${V}/campaigns/taleem-box`)).body.raised).toBe(before + 10000);
    expect(await balanced()).toBe(true);
  });
  it("webhook: bad signature rejected, duplicate event idempotent", async () => {
    const r = await inv.auth(inv.post(`${V}/campaigns/taleem-box/invest`)).send({ amount: 6000, consentRisk: true, consentContract: true });
    const evt = { id: "evt_test_dupe_0001", type: "payment.succeeded", data: { paymentId: r.body.payment.id } }; const raw = JSON.stringify(evt);
    expect((await request(app).post(`${V}/webhooks/mockpay`).set("Content-Type", "application/json").set("X-Mockpay-Signature", "t=1,v1=00").send(raw)).status).toBe(401);
    const bad = payments.sign(raw).replace(/v1=./, "v1=0"); expect((await request(app).post(`${V}/webhooks/mockpay`).set("Content-Type", "application/json").set("X-Mockpay-Signature", bad).send(raw)).status).toBe(401);
    const ok1 = await request(app).post(`${V}/webhooks/mockpay`).set("Content-Type", "application/json").set("X-Mockpay-Signature", payments.sign(raw)).send(raw);
    const ok2 = await request(app).post(`${V}/webhooks/mockpay`).set("Content-Type", "application/json").set("X-Mockpay-Signature", payments.sign(raw)).send(raw);
    expect(ok1.status).toBe(200); expect(ok2.body.duplicate).toBe(true);
    const lines = await db.journalEntry.count({ where: { idempotencyKey: `payment:${r.body.payment.id}` } }); expect(lines).toBe(1);
    expect((await inv.auth(inv.get(`${V}/investments/${r.body.ref}`))).body.status).toBe("escrow");
  });
  it("concurrent investments never overfill", async () => {
    const c = (await request(app).get(`${V}/campaigns/karigar-hub`)).body; const remaining = c.remaining;
    const users = await Promise.all([1, 2, 4, 5, 6].map((i) => login(`crowd${i}@sharik.demo`, "Crowd@1234")));
    const reqs = Array.from({ length: 20 }, (_, k) => { const a = users[k % users.length]; return a.auth(a.post(`${V}/campaigns/karigar-hub/invest`)).send({ amount: 10000, consentRisk: true, consentContract: true }); });
    const res = await Promise.all(reqs);
    const ok = res.filter((r) => r.status === 201).length;
    expect(ok).toBe(Math.floor(remaining / 10000));
    res.filter((r) => r.status !== 201).forEach((r) => expect(r.status).toBe(409));
    const row = await db.campaign.findUnique({ where: { slug: "karigar-hub" } });
    expect(Number(row.committedPaisa)).toBeLessThanOrEqual(Number(row.targetPaisa));
  });
});

describe("close, refund, distributions", () => {
  it("failed campaign refunds every escrow investment to wallets", async () => {
    const id = await idOf("taleem-box");
    const w0 = (await inv.auth(inv.get(`${V}/portfolio`))).body.totals.wallet;
    const r = await adm.auth(adm.post(`${V}/admin/campaigns/${id}/close`)); expect(r.body.status).toBe("failed");
    const esc = await db.investment.count({ where: { campaignId: id, status: "escrow" } }); expect(esc).toBe(0);
    const w1 = (await inv.auth(inv.get(`${V}/portfolio`))).body.totals.wallet; expect(w1).toBe(w0 + 16000);
    expect((await adm.auth(adm.post(`${V}/admin/campaigns/${id}/close`))).status).toBe(409);
    const L2 = await db.$transaction((tx) => L.balance(L.ACC.escrow(id).code, tx)); expect(Number(L2)).toBe(0);
    expect(await balanced()).toBe(true);
  });
  it("distribution posts exact largest-remainder payouts", async () => {
    const id = await idOf("chai-junction");
    const r = await adm.auth(adm.post(`${V}/admin/campaigns/${id}/distributions`)).send({ period: "Q4 test", netResult: 100001.23, impermissiblePct: 1.1 });
    expect(r.status).toBe(201);
    const d = await db.distribution.findFirst({ where: { campaignId: id, period: "Q4 test" }, include: { payouts: true } });
    expect(d.status).toBe("posted");
    expect(d.payouts.reduce((a, p) => a + Number(p.amountPaisa), 0)).toBe(Math.round(10000123 * 0.6));
    expect(await balanced()).toBe(true);
  });
  it("withdraw requires idempotency key and is idempotent", async () => {
    expect((await inv.auth(inv.post(`${V}/wallet/withdraw`)).send({ amount: 100 })).status).toBe(400);
    const a = await inv.auth(inv.post(`${V}/wallet/withdraw`)).set("Idempotency-Key", "wd-test-0001").send({ amount: 100 });
    const w = (await inv.auth(inv.get(`${V}/portfolio`))).body.totals.wallet;
    await inv.auth(inv.post(`${V}/wallet/withdraw`)).set("Idempotency-Key", "wd-test-0001").send({ amount: 100 });
    expect(a.status).toBe(200); expect((await inv.auth(inv.get(`${V}/portfolio`))).body.totals.wallet).toBe(w);
  });
  it("PDF contract + statement", async () => {
    const p = (await inv.auth(inv.get(`${V}/portfolio`))).body;
    const c = await inv.auth(inv.get(`${V}/investments/${p.holdings[0].ref}/contract.pdf`)); expect(c.headers["content-type"]).toMatch(/pdf/); expect(c.body.slice(0, 4).toString()).toBe("%PDF");
    const s = await inv.auth(inv.get(`${V}/portfolio/statement.pdf`)); expect(s.status).toBe(200);
  });
});

describe("founder flow, uploads, admin", () => {
  it("founder submits -> admin must tick checklist -> live", async () => {
    const r = await fnd.auth(fnd.post(`${V}/campaigns`)).send({ name: "Test Halal Bakery", city: "Lahore", sector: "Food", structure: "Musharakah", description: "A test bakery campaign for CI.", target: 200000, valuation: 2000000, investorRatio: 50 });
    expect(r.status).toBe(201);
    const id = r.body.id ?? r.body.campaign?.id;
    expect((await adm.auth(adm.post(`${V}/admin/campaigns/${id}/review`)).send({ decision: "approve" })).status).toBe(400);
    const c = await db.campaign.findUnique({ where: { id } });
    const checklist = Object.fromEntries(c.screening.checks.map((x) => [x.key, true]));
    const ok = await adm.auth(adm.post(`${V}/admin/campaigns/${id}/review`)).send({ decision: "approve", checklist });
    expect(ok.status).toBe(200); expect((await db.campaign.findUnique({ where: { id } })).status).toBe("live");
  });
  it("uploads: type sniffing, signed URLs, private docs hidden", async () => {
    const id = await idOf("zaraat-tech");
    const bad = await fnd.auth(fnd.post(`${V}/campaigns/${id}/documents`)).field("kind", "pitch_deck").attach("file", Buffer.from("MZ not a pdf"), { filename: "x.pdf", contentType: "application/pdf" });
    expect(bad.status).toBe(400);
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
    const ok = await fnd.auth(fnd.post(`${V}/campaigns/${id}/documents`)).field("kind", "financials").field("visibility", "private").attach("file", pdf, { filename: "f.pdf", contentType: "application/pdf" });
    expect(ok.status).toBe(201);
    expect((await inv.auth(inv.get(`${V}/documents/${ok.body.id}/url`))).status).toBe(404);
    const u = await adm.auth(adm.get(`${V}/documents/${ok.body.id}/url`)); expect(u.status).toBe(200);
    const path = new URL(u.body.url).pathname + new URL(u.body.url).search;
    const f = await request(app).get(path); expect(f.status).toBe(200); expect(f.body.slice(0, 4).toString()).toBe("%PDF");
    expect((await request(app).get(path.replace(/sig=./, "sig=0"))).status).toBe(403);
  });
  it("audit log records actions and is append-only", async () => {
    const a = await adm.auth(adm.get(`${V}/admin/audit?limit=200`));
    const actions = a.body.map((x) => x.action);
    for (const k of ["auth.login", "campaign.approved", "campaign.closed"]) expect(actions).toContain(k);
    await expect(db.$executeRawUnsafe(`UPDATE "AuditLog" SET action='x' WHERE id=${a.body[0].id}`)).rejects.toThrow();
    await expect(db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE id=${a.body[0].id}`)).rejects.toThrow();
  });
  it("admin soft-deletes a campaign", async () => {
    const r = await fnd.auth(fnd.post(`${V}/campaigns`)).send({ name: "Pending Delete Me", city: "Karachi", sector: "Retail", structure: "Mudarabah", description: "A pending campaign to delete.", target: 150000, valuation: 900000, investorRatio: 40 });
    const id = r.body.id ?? r.body.campaign?.id; const slug = r.body.slug ?? r.body.campaign?.slug;
    expect((await adm.auth(adm.delete(`${V}/admin/campaigns/${await idOf("chai-junction")}`))).status).toBe(409);
    expect((await adm.auth(adm.delete(`${V}/admin/campaigns/${id}`))).status).toBeLessThan(300);
    expect((await request(app).get(`${V}/campaigns/${slug}`)).status).toBe(404);
    expect((await db.campaign.findUnique({ where: { id } })).deletedAt).toBeTruthy();
  });
});
