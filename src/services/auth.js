// Auth: bcrypt passwords, 15-min access JWT (in memory on client), rotating refresh token in httpOnly cookie,
// CSRF double-submit for cookie endpoints, revocable sessions, email verification, password reset, optional TOTP 2FA.
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const env = require("../config");
const db = require("../lib/db");
const { E, AppError } = require("../lib/errors");
const { sha256, randomToken, safeEqual, encrypt, decrypt } = require("../lib/crypto");
const { audit } = require("../lib/audit");
const { notify } = require("./notify");
authenticator.options = { window: 1 };
const COOKIE = "sharik_rt";
const pep = (s) => sha256(env.REFRESH_TOKEN_PEPPER + ":" + s);
const pub = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, emailVerified: !!u.emailVerifiedAt, totpEnabled: u.totpEnabled, kycOnFile: !!u.cnicEnc, cnicLast4: u.cnicLast4 });
const cookieOpts = () => ({ httpOnly: true, secure: env.isProd || env.cookieSameSite === "none", sameSite: env.cookieSameSite, path: "/api/v1/auth", maxAge: env.REFRESH_TOKEN_DAYS * 864e5 });
const accessToken = (u, sid) => jwt.sign({ sub: u.id, role: u.role, sid }, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL, issuer: "sharik" });

async function createSession(u, req) {
  const id = randomToken(16), secret = randomToken(32), csrf = randomToken(24);
  await db.session.create({ data: { id, userId: u.id, refreshHash: pep(secret), csrfHash: sha256(csrf), userAgent: String(req.headers["user-agent"] || "").slice(0, 200), ip: req.ip, expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 864e5) } });
  return { refresh: `${id}.${secret}`, csrf, sid: id };
}
function issue(res, u, s) {
  res.cookie(COOKIE, s.refresh, cookieOpts());
  return { accessToken: accessToken(u, s.sid), csrfToken: s.csrf, expiresIn: env.ACCESS_TOKEN_TTL, user: pub(u) };
}
async function sendToken(u, type, ttlMs) {
  const raw = randomToken(32);
  await db.authToken.create({ data: { type, tokenHash: sha256(raw), userId: u.id, expiresAt: new Date(Date.now() + ttlMs) } });
  await notify({ user: u, template: type, data: { token: raw } });
}
async function register(req, res, { name, email, password, role }) {
  email = email.toLowerCase();
  if (await db.user.findUnique({ where: { email } })) throw E.conflict("Email already registered", "email_taken");
  const u = await db.user.create({ data: { name, email, role, passwordHash: await bcrypt.hash(password, 12) } });
  await audit("auth.register", { actorId: u.id, entity: "User", entityId: u.id, data: { role }, ip: req.ip });
  await sendToken(u, "verify_email", 48 * 3600e3);
  return issue(res, u, await createSession(u, req));
}
async function login(req, res, { email, password, totp }) {
  const u = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  const ok = u && !u.deletedAt && (await bcrypt.compare(password, u.passwordHash));
  if (!ok) { await audit("auth.login_failed", { entity: "User", entityId: u?.id ?? null, data: { email }, ip: req.ip }); throw E.unauth("Invalid email or password", "invalid_credentials"); }
  if (u.totpEnabled) {
    if (!totp) throw new AppError(401, "totp_required", "Enter the 6-digit code from your authenticator app");
    if (!authenticator.check(String(totp), decrypt(u.totpSecretEnc))) { await audit("auth.totp_failed", { actorId: u.id, ip: req.ip }); throw new AppError(401, "totp_invalid", "Invalid authentication code"); }
  }
  await audit("auth.login", { actorId: u.id, entity: "User", entityId: u.id, ip: req.ip });
  return issue(res, u, await createSession(u, req));
}
function readCookie(req) {
  const v = req.cookies?.[COOKIE]; if (!v || !v.includes(".")) throw E.unauth("No session", "no_session");
  const [sid, secret] = v.split("."); return { sid, secret };
}
async function checkCsrf(req, s) {
  const t = req.get("x-csrf-token");
  if (!t || !safeEqual(sha256(t), s.csrfHash)) throw E.forbidden("CSRF token missing or invalid");
}
async function refresh(req, res) {
  const { sid, secret } = readCookie(req);
  const s = await db.session.findUnique({ where: { id: sid }, include: { user: true } });
  if (!s || s.revokedAt || s.expiresAt < new Date() || s.user.deletedAt) { res.clearCookie(COOKIE, { ...cookieOpts(), maxAge: undefined }); throw E.unauth("Session expired", "session_expired"); }
  await checkCsrf(req, s);
  if (!safeEqual(pep(secret), s.refreshHash)) {
    // refresh-token reuse ⇒ likely theft: revoke the session
    await db.session.update({ where: { id: sid }, data: { revokedAt: new Date() } });
    await audit("auth.refresh_reuse", { actorId: s.userId, entity: "Session", entityId: sid, ip: req.ip });
    throw E.unauth("Session revoked", "session_revoked");
  }
  const next = randomToken(32);
  const r = await db.session.updateMany({ where: { id: sid, refreshHash: s.refreshHash, revokedAt: null }, data: { refreshHash: pep(next), lastUsedAt: new Date() } });
  if (r.count !== 1) throw E.unauth("Session revoked", "session_revoked");
  res.cookie(COOKIE, `${sid}.${next}`, cookieOpts());
  return { accessToken: accessToken(s.user, sid), expiresIn: env.ACCESS_TOKEN_TTL, user: pub(s.user) };
}
async function logout(req, res, all = false) {
  let s = null;
  try { const { sid } = readCookie(req); s = await db.session.findUnique({ where: { id: sid } }); } catch {}
  if (s) { await checkCsrf(req, s); }
  const userId = s?.userId ?? req.user?.id;
  if (all && userId) await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  else if (s) await db.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
  else if (req.auth?.sid) await db.session.update({ where: { id: req.auth.sid }, data: { revokedAt: new Date() } });
  res.clearCookie(COOKIE, { ...cookieOpts(), maxAge: undefined });
  if (userId) await audit(all ? "auth.logout_all" : "auth.logout", { actorId: userId, ip: req.ip });
  return { ok: true };
}
/** Access-token middleware helper: verifies JWT, then that session is live and user not deleted. */
async function authenticate(req) {
  const h = req.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  let p; try { p = jwt.verify(h.slice(7), env.JWT_ACCESS_SECRET, { issuer: "sharik" }); } catch (e) { throw E.unauth(e.name === "TokenExpiredError" ? "Access token expired" : "Invalid token", e.name === "TokenExpiredError" ? "token_expired" : "invalid_token"); }
  const s = await db.session.findUnique({ where: { id: p.sid }, include: { user: true } });
  if (!s || s.revokedAt || s.user.deletedAt) throw E.unauth("Session revoked", "session_revoked");
  req.auth = { sid: p.sid }; return s.user;
}
async function useToken(type, raw) {
  const t = await db.authToken.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: true } });
  if (!t || t.type !== type || t.usedAt || t.expiresAt < new Date()) throw E.bad("Link is invalid or has expired");
  const r = await db.authToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
  if (r.count !== 1) throw E.bad("Link already used");
  return t.user;
}
async function verifyEmail(token, ip) {
  const u = await useToken("verify_email", token);
  await db.user.update({ where: { id: u.id }, data: { emailVerifiedAt: u.emailVerifiedAt || new Date() } });
  await audit("auth.email_verified", { actorId: u.id, ip });
  return { ok: true };
}
async function resendVerification(user) { if (user.emailVerifiedAt) return { ok: true, alreadyVerified: true }; await sendToken(user, "verify_email", 48 * 3600e3); return { ok: true }; }
async function forgot(email, ip) {
  const u = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (u && !u.deletedAt) { await sendToken(u, "reset_password", 3600e3); await audit("auth.reset_requested", { actorId: u.id, ip }); }
  return { ok: true, message: "If that email is registered, a reset link has been sent." };
}
async function reset(token, password, ip) {
  const u = await useToken("reset_password", token);
  await db.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(password, 12) } });
  await db.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit("auth.password_reset", { actorId: u.id, ip });
  await notify({ user: u, template: "security_alert", data: { what: "your password was reset and all sessions were signed out." } });
  return { ok: true };
}
async function totpSetup(user) {
  if (user.totpEnabled) throw E.conflict("2FA already enabled");
  const secret = authenticator.generateSecret();
  await db.user.update({ where: { id: user.id }, data: { totpSecretEnc: encrypt(secret) } });
  const otpauth = authenticator.keyuri(user.email, "Sharik", secret);
  return { secret, otpauthUrl: otpauth, qrDataUrl: await QRCode.toDataURL(otpauth) };
}
async function totpEnable(user, code, ip) {
  const u = await db.user.findUnique({ where: { id: user.id } });
  if (!u.totpSecretEnc) throw E.bad("Call /auth/2fa/setup first");
  if (!authenticator.check(String(code), decrypt(u.totpSecretEnc))) throw E.bad("Invalid code");
  await db.user.update({ where: { id: u.id }, data: { totpEnabled: true } });
  await audit("auth.2fa_enabled", { actorId: u.id, ip });
  return { ok: true };
}
async function totpDisable(user, { password, code }, ip) {
  const u = await db.user.findUnique({ where: { id: user.id } });
  if (!u.totpEnabled) return { ok: true };
  if (!(await bcrypt.compare(password, u.passwordHash))) throw E.unauth("Wrong password", "invalid_credentials");
  if (!authenticator.check(String(code), decrypt(u.totpSecretEnc))) throw E.bad("Invalid code");
  await db.user.update({ where: { id: u.id }, data: { totpEnabled: false, totpSecretEnc: null } });
  await audit("auth.2fa_disabled", { actorId: u.id, ip });
  return { ok: true };
}
async function saveKyc(user, { cnic, phone }, ip) {
  const digits = cnic.replace(/\D/g, "");
  await db.user.update({ where: { id: user.id }, data: { cnicEnc: encrypt(digits), cnicLast4: digits.slice(-4), phone: phone ?? undefined } });
  await audit("kyc.updated", { actorId: user.id, entity: "User", entityId: user.id, data: { cnicLast4: digits.slice(-4) }, ip });
  return { ok: true, cnicLast4: digits.slice(-4) };
}
async function sessions(user) {
  const s = await db.session.findMany({ where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastUsedAt: "desc" } });
  return s.map((x) => ({ id: x.id.slice(0, 6) + "…", userAgent: x.userAgent, ip: x.ip, createdAt: x.createdAt, lastUsedAt: x.lastUsedAt }));
}
module.exports = { register, login, refresh, logout, authenticate, verifyEmail, resendVerification, forgot, reset, totpSetup, totpEnable, totpDisable, saveKyc, sessions, pub, COOKIE };
