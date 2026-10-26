const multer = require("multer");
const rateLimit = require("express-rate-limit");
const env = require("../config");
const db = require("../lib/db");
const { E } = require("../lib/errors");
const { toPaisa, N, toPKR } = require("../lib/money");
const { def, z } = require("./registry");
const auth = require("../services/auth");
const camp = require("../services/campaigns");
const pay = require("../services/payments");
const docs = require("../services/documents");
const storage = require("../services/storage");
const pdf = require("../services/pdf");
const L = require("../services/ledger");
const jobs = require("../services/jobs");

const authLimiter = rateLimit({ windowMs: 60_000, limit: env.RATE_LIMIT_AUTH_PER_MIN, standardHeaders: "draft-7", legacyHeaders: false, skip: () => env.isTest && !process.env.TEST_RATE_LIMIT,
  handler: (_q, res) => res.status(429).json({ error: { code: "rate_limited", message: "Too many attempts, try again in a minute" } }) });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: docs.MAX, files: 1 } }).single("file");

// --- shared schemas ---
const pkr = z.coerce.number().positive().max(1e12).transform((v) => toPaisa(v));
const email = z.string().trim().email().max(200);
const password = z.string().min(8, "Password must be at least 8 characters").max(200);
const id = z.object({ id: z.coerce.number().int().positive() });
const slug = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,60}$/) });
const idemKey = (req) => { const k = req.get("idempotency-key"); if (k && !/^[A-Za-z0-9_\-:.]{8,100}$/.test(k)) throw E.bad("Invalid Idempotency-Key"); return k || null; };

// ---------- health ----------
def("get", "/health", { tag: "ops", summary: "Health check (pings DB)" }, async () => {
  await db.$queryRaw`SELECT 1`;
  return { ok: true, db: "up", jobs: jobs.kind(), storage: storage.kind, cache: require("../lib/cache").kind, mailer: require("../services/mailer").mailer.kind, time: new Date().toISOString() };
});

// ---------- auth ----------
const T = "auth";
def("post", "/auth/register", { tag: T, summary: "Create account (investor or founder); sends verification email", rateLimit: authLimiter, status: 201,
  body: z.object({ name: z.string().trim().min(2).max(100), email, password, role: z.enum(["investor", "founder"]).default("investor") }) }, (req, res) => auth.register(req, res, req.body));
def("post", "/auth/login", { tag: T, summary: "Log in; returns access token + csrfToken, sets httpOnly refresh cookie. 401 totp_required if 2FA is on", rateLimit: authLimiter,
  body: z.object({ email, password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/).optional() }) }, (req, res) => auth.login(req, res, req.body));
def("post", "/auth/refresh", { tag: T, summary: "Rotate refresh cookie and mint a new access token (requires X-CSRF-Token)", headers: ["X-CSRF-Token"], rateLimit: authLimiter }, (req, res) => auth.refresh(req, res));
def("post", "/auth/logout", { tag: T, summary: "Revoke this session (requires X-CSRF-Token)", headers: ["X-CSRF-Token"], auth: "optional" }, (req, res) => auth.logout(req, res));
def("post", "/auth/logout-all", { tag: T, summary: "Revoke all of my sessions", headers: ["X-CSRF-Token"], auth: "user" }, (req, res) => auth.logout(req, res, true));
def("get", "/auth/me", { tag: T, summary: "Current user", auth: "user" }, (req) => ({ user: auth.pub(req.user) }));
def("get", "/auth/sessions", { tag: T, summary: "My active sessions", auth: "user" }, (req) => auth.sessions(req.user));
def("post", "/auth/verify-email", { tag: T, summary: "Verify email with token from email", rateLimit: authLimiter, body: z.object({ token: z.string().min(10).max(200) }) }, (req) => auth.verifyEmail(req.body.token, req.ip));
def("post", "/auth/resend-verification", { tag: T, summary: "Re-send verification email", auth: "user", rateLimit: authLimiter }, (req) => auth.resendVerification(req.user));
def("post", "/auth/forgot-password", { tag: T, summary: "Email a reset link (always 200)", rateLimit: authLimiter, body: z.object({ email }) }, (req) => auth.forgot(req.body.email, req.ip));
def("post", "/auth/reset-password", { tag: T, summary: "Set new password with reset token; revokes all sessions", rateLimit: authLimiter, body: z.object({ token: z.string().min(10).max(200), password }) }, (req) => auth.reset(req.body.token, req.body.password, req.ip));
def("post", "/auth/2fa/setup", { tag: T, summary: "Start TOTP 2FA setup (returns otpauth URL + QR)", auth: "user" }, (req) => auth.totpSetup(req.user));
def("post", "/auth/2fa/enable", { tag: T, summary: "Confirm TOTP code and enable 2FA", auth: "user", rateLimit: authLimiter, body: z.object({ code: z.string().regex(/^\d{6}$/) }) }, (req) => auth.totpEnable(req.user, req.body.code, req.ip));
def("post", "/auth/2fa/disable", { tag: T, summary: "Disable 2FA (password + code)", auth: "user", rateLimit: authLimiter, body: z.object({ password: z.string().min(1), code: z.string().regex(/^\d{6}$/) }) }, (req) => auth.totpDisable(req.user, req.body, req.ip));
def("post", "/me/kyc", { tag: T, summary: "Save CNIC (AES-GCM encrypted at rest) and phone", auth: "user",
  body: z.object({ cnic: z.string().regex(/^\d{5}-?\d{7}-?\d$/, "CNIC format 12345-1234567-1"), phone: z.string().regex(/^\+?\d[\d\- ]{8,15}$/).optional() }) }, (req) => auth.saveKyc(req.user, req.body, req.ip));

// ---------- campaigns ----------
const C = "campaigns";
def("get", "/stats", { tag: C, summary: "Platform stats" }, () => camp.stats());
def("get", "/campaigns", { tag: C, summary: "List public campaigns (cached)", query: z.object({ status: z.enum(["live", "funded", "failed", "closing"]).optional() }) }, (req) => camp.list(req.q));
def("get", "/campaigns/mine", { tag: C, summary: "My campaigns", auth: ["founder", "admin"] }, (req) => camp.mine(req.user));
def("get", "/campaigns/:slug", { tag: C, summary: "Campaign detail incl. documents & distributions", auth: "optional", params: slug }, (req) => camp.getBySlug(req.params.slug, req.user));
def("post", "/campaigns", { tag: C, summary: "Submit campaign for Shariah review", auth: ["founder"], status: 201,
  body: z.object({
    name: z.string().trim().min(2).max(100), city: z.string().trim().min(2).max(60), sector: z.string().trim().min(2).max(60), structure: z.enum(["Musharakah", "Mudarabah"]),
    description: z.string().trim().min(10).max(600), useOfFunds: z.string().trim().max(600).optional(), secpRegNo: z.string().trim().max(30).optional(),
    target: pkr.refine((p) => p >= toPaisa(100000), "Target must be at least Rs 100,000"), valuation: pkr, minTicket: z.coerce.number().min(5000, "Minimum ticket is Rs 5,000").default(5000).transform(toPaisa),
    investorRatio: z.coerce.number().int().min(1).max(99), durationDays: z.coerce.number().int().min(7).max(120).default(30),
    haramSector: z.coerce.boolean().default(false), interestDebtRatio: z.coerce.number().min(0).max(100).default(0), interestIncomePct: z.coerce.number().min(0).max(100).default(0),
    emoji: z.string().max(8).optional(),
  }).refine((d) => d.minTicket <= d.target, { message: "Min ticket cannot exceed target", path: ["minTicket"] }) },
  (req) => { const b = req.body; return camp.create(req.user, { ...b, targetPaisa: b.target, valuationPaisa: b.valuation, minTicketPaisa: b.minTicket }, req.ip); });
def("post", "/campaigns/:slug/invest", { tag: C, summary: "Reserve an investment (atomic, never overfills). Returns a pending payment to complete via mockpay. Supports Idempotency-Key.", auth: ["investor"], status: 201, params: slug, headers: ["Idempotency-Key"],
  body: z.object({ amount: z.coerce.number().positive().max(1e10), method: z.enum(["JazzCash", "Easypaisa", "Bank transfer"]).default("JazzCash"), consentRisk: z.literal(true, { errorMap: () => ({ message: "Risk consent required" }) }), consentContract: z.literal(true, { errorMap: () => ({ message: "Contract consent required" }) }) }) },
  (req) => camp.invest(req.user, req.params.slug, { amountPaisa: toPaisa(req.body.amount), method: req.body.method }, idemKey(req), req.ip));

// ---------- investments & payments ----------
const I = "investing";
def("get", "/investments/:ref", { tag: I, summary: "Investment status", auth: "user", params: z.object({ ref: z.string().max(40) }) }, async (req) => { const i = await camp.investmentForUser(req.user, req.params.ref); return camp.investView(i, i.payments.at(-1), i.campaign); });
def("get", "/investments/:ref/contract", { tag: I, summary: "Contract summary (JSON)", auth: "user", params: z.object({ ref: z.string().max(40) }) }, async (req) => (await camp.investmentForUser(req.user, req.params.ref)).contract);
def("get", "/investments/:ref/contract.pdf", { tag: I, summary: "Contract summary (PDF)", auth: "user", params: z.object({ ref: z.string().max(40) }) }, async (req, res) => {
  const i = await camp.investmentForUser(req.user, req.params.ref);
  res.type("application/pdf").set("Content-Disposition", `attachment; filename="sharik-contract-${i.ref}.pdf"`).send(await pdf.contractPdf(i.contract));
});
def("post", "/payments/:id/mock-pay", { tag: I, summary: "Simulate paying at the provider; provider then calls our signed webhook (async, retried)", auth: "user", params: z.object({ id: z.string().regex(/^pay_[a-f0-9]{20}$/) }), body: z.object({ outcome: z.enum(["succeeded", "failed"]).default("succeeded") }) },
  (req) => pay.mockPay(req.user, req.params.id, req.body.outcome));
def("get", "/portfolio", { tag: I, summary: "My holdings, distributions, purification and ledger wallet balance", auth: ["investor"] }, (req) => camp.portfolio(req.user));
def("get", "/portfolio/statement.pdf", { tag: I, summary: "Investor statement (PDF)", auth: ["investor"] }, async (req, res) => {
  const p = await camp.portfolio(req.user);
  res.type("application/pdf").set("Content-Disposition", 'attachment; filename="sharik-statement.pdf"').send(await pdf.statementPdf({ user: req.user, portfolio: p, generatedAt: new Date().toISOString().slice(0, 10) }));
});
def("post", "/portfolio/purify", { tag: I, summary: "Donate all outstanding purification (wallet → purification pool)", auth: ["investor"] }, (req) => camp.purifyAll(req.user, req.ip));
def("post", "/wallet/withdraw", { tag: I, summary: "Withdraw wallet balance to bank (mock). Requires Idempotency-Key.", auth: ["investor"], headers: ["Idempotency-Key"], body: z.object({ amount: z.coerce.number().positive().max(1e10) }) },
  (req) => camp.withdraw(req.user, toPaisa(req.body.amount), idemKey(req), req.ip));

// ---------- webhooks (raw body, mounted before json parser in app.js) ----------
// documented here; implemented in app.js so the raw body is available for HMAC.

// ---------- documents ----------
const D = "documents";
def("post", "/campaigns/:id/documents", { tag: D, summary: "Upload campaign document (pitch deck, financials, fatwa, agreement)", auth: ["founder", "admin"], status: 201, params: id, pre: upload,
  multipart: { type: "object", properties: { file: { type: "string", format: "binary" }, kind: { type: "string", enum: ["pitch_deck", "financials", "fatwa", "agreement", "offer_doc"] }, title: { type: "string" }, visibility: { type: "string", enum: ["public", "private"] } } } },
  async (req) => {
    const b = z.object({ kind: z.enum(["pitch_deck", "financials", "fatwa", "agreement", "offer_doc"]), title: z.string().max(120).optional(), visibility: z.enum(["public", "private"]).default("public") }).parse(req.body || {});
    const c = await db.campaign.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!c) throw E.notFound("Campaign not found");
    if (req.user.role !== "admin" && c.founderId !== req.user.id) throw E.forbidden();
    if (!req.file) throw E.bad("file is required");
    const d = await docs.save({ buf: req.file.buffer, mime: req.file.mimetype, filename: req.file.originalname, kind: b.kind, title: b.title, campaignId: c.id, visibility: b.visibility, actorId: req.user.id, ip: req.ip });
    return { id: d.id, title: d.title, kind: d.kind, visibility: d.visibility };
  });
def("post", "/me/kyc/documents", { tag: D, summary: "Upload KYC document (private)", auth: "user", status: 201, pre: upload, multipart: { type: "object", properties: { file: { type: "string", format: "binary" }, title: { type: "string" } } } }, async (req) => {
  if (!req.file) throw E.bad("file is required");
  const d = await docs.save({ buf: req.file.buffer, mime: req.file.mimetype, filename: req.file.originalname, kind: "kyc", title: String(req.body?.title || "CNIC").slice(0, 120), ownerId: req.user.id, visibility: "private", actorId: req.user.id, ip: req.ip });
  return { id: d.id, title: d.title, kind: d.kind };
});
def("get", "/me/documents", { tag: D, summary: "My private documents", auth: "user" }, async (req) => (await db.document.findMany({ where: { ownerId: req.user.id, deletedAt: null } })).map((d) => ({ id: d.id, kind: d.kind, title: d.title, filename: d.filename, createdAt: d.createdAt })));
def("get", "/documents/:id/url", { tag: D, summary: "Get a short-lived signed download URL", auth: "optional", params: id }, (req) => docs.signedUrl(req.user, req.params.id));
def("delete", "/documents/:id", { tag: D, summary: "Soft-delete a document", auth: "user", params: id }, (req) => docs.remove(req.user, req.params.id, req.ip));
def("get", "/files/:key", { tag: D, summary: "Local-storage signed file download (exp + sig)", params: z.object({ key: z.string().max(300) }), query: z.object({ exp: z.string(), sig: z.string() }) }, async (req, res) => {
  if (storage.kind !== "local" || !storage.verify(req.params.key, req.q.exp, req.q.sig)) throw E.forbidden("Invalid or expired link");
  const d = await db.document.findUnique({ where: { storageKey: req.params.key } });
  if (!d || d.deletedAt) throw E.notFound();
  res.type(d.mime).set("Content-Disposition", `inline; filename="${d.filename.replace(/"/g, "")}"`).set("Cache-Control", "private, max-age=300").send(await storage.get(d.storageKey));
});

// ---------- admin ----------
const A = "admin";
def("get", "/admin/overview", { tag: A, summary: "All campaigns", auth: ["admin"] }, () => camp.adminOverview());
def("post", "/admin/campaigns/:id/review", { tag: A, summary: "Approve (go live) or reject after Shariah checklist", auth: ["admin"], params: id,
  body: z.object({ decision: z.enum(["approve", "reject"]), checklist: z.record(z.boolean()).default({}), note: z.string().max(500).default("") }) }, (req) => camp.review(req.user, req.params.id, req.body, req.ip));
def("post", "/admin/campaigns/:id/close", { tag: A, summary: "Close now: release escrow if target met, else queue refunds", auth: ["admin"], params: id }, (req) => camp.close(req.params.id, req.user, req.ip));
def("delete", "/admin/campaigns/:id", { tag: A, summary: "Soft-delete a pending/rejected campaign", auth: ["admin"], params: id }, (req) => camp.softDelete(req.user, req.params.id, req.ip));
def("post", "/admin/campaigns/:id/distributions", { tag: A, summary: "Queue a profit/loss distribution (posted by background job)", auth: ["admin"], status: 201, params: id,
  body: z.object({ period: z.string().trim().min(2).max(30), netResult: z.coerce.number().refine((v) => v !== 0, "Net result cannot be zero").refine((v) => Math.abs(v) <= 1e11), impermissiblePct: z.coerce.number().min(0).max(100).default(0), note: z.string().max(300).optional() }) },
  (req) => camp.createDistribution(req.user, req.params.id, { ...req.body, netResultPaisa: toPaisa(req.body.netResult) }, req.ip));
def("get", "/admin/audit", { tag: A, summary: "Append-only audit log", auth: ["admin"], query: z.object({ action: z.string().max(60).optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }, async (req) => {
  const rows = await db.auditLog.findMany({ where: { ...(req.q.action ? { action: { startsWith: req.q.action } } : {}), ...(req.q.before ? { id: { lt: req.q.before } } : {}) }, orderBy: { id: "desc" }, take: req.q.limit });
  const actors = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId).filter(Boolean))] } }, select: { id: true, email: true } });
  const em = Object.fromEntries(actors.map((a) => [a.id, a.email]));
  return rows.map((r) => ({ ...r, actor: r.actorId ? em[r.actorId] : "system" }));
});
def("get", "/admin/ledger", { tag: A, summary: "Trial balance (derived from journal lines)", auth: ["admin"] }, () => L.trialBalance());
def("get", "/admin/ledger/entries", { tag: A, summary: "Recent journal entries", auth: ["admin"], query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) }, async (req) =>
  (await db.journalEntry.findMany({ orderBy: { id: "desc" }, take: req.q.limit, include: { lines: { include: { account: true } } } })).map((e) => ({ id: e.id, key: e.idempotencyKey, kind: e.kind, memo: e.memo, createdAt: e.createdAt, lines: e.lines.map((l) => ({ account: l.account.code, amountPaisa: N(l.amountPaisa) })) })));
def("get", "/admin/jobs", { tag: A, summary: "Background job queue (Postgres backend)", auth: ["admin"] }, async () => {
  const g = await db.job.groupBy({ by: ["status"], _count: { _all: true } });
  const failed = await db.job.findMany({ where: { status: "failed" }, orderBy: { id: "desc" }, take: 20 });
  return { backend: jobs.kind(), counts: Object.fromEntries(g.map((r) => [r.status, r._count._all])), failed };
});

// ---------- dev outbox ----------
if (env.devOutbox) def("get", "/dev/outbox", { tag: "dev", summary: "Dev only: recent emails/SMS (disabled in production)", query: z.object({ to: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }) }, async (req) =>
  db.notification.findMany({ where: req.q.to ? { to: req.q.to.toLowerCase() } : {}, orderBy: { id: "desc" }, take: req.q.limit }));

module.exports = { authLimiter };
