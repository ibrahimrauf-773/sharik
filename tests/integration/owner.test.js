import { describe, it, expect, beforeAll } from "vitest";
const { authenticator } = require("otplib");
const { request, app, login } = require("./helpers");
const db = require("../../src/lib/db");
const owner = require("../../src/services/owner");
const DEV_TOTP = "JBSWY3DPEHPK3PXP";
const code = () => authenticator.generate(DEV_TOTP);
const SECTIONS = ["overview", "money", "campaigns", "users", "investments", "shariah", "activity", "system", "analytics"];

describe("owner dashboard access control", () => {
  let o;
  beforeAll(async () => { o = await login("owner@sharik.demo", "Owner@123", code()); });

  it("owner login requires TOTP", async () => {
    const r = await request(app).post("/api/v1/auth/login").send({ email: "owner@sharik.demo", password: "Owner@123" });
    expect(r.status).toBe(401); expect(r.body.error?.code || r.body.code).toBe("totp_required");
  });

  it("anonymous gets 401 on every owner endpoint", async () => {
    for (const s of SECTIONS) expect((await request(app).get(`/api/v1/owner/${s}`)).status).toBe(401);
  });

  for (const [email, pw] of [["admin@sharik.demo", "Admin@123"], ["investor@sharik.demo", "Investor@123"], ["founder@sharik.demo", "Founder@123"]]) {
    it(`${email.split("@")[0]} gets 403 on every owner endpoint (JSON and CSV)`, async () => {
      const a = await login(email, pw);
      for (const s of SECTIONS) {
        expect((await a.auth(a.get(`/api/v1/owner/${s}`))).status).toBe(403);
        expect((await a.auth(a.get(`/api/v1/owner/${s}?format=csv`))).status).toBe(403);
      }
    });
  }

  it("an owner WITHOUT 2FA enabled is rejected (totp_setup_required)", async () => {
    const bcrypt = require("bcryptjs");
    await db.user.create({ data: { email: "owner-no2fa@test.local", name: "No2FA", role: "owner", passwordHash: await bcrypt.hash("Owner@12345", 4), emailVerifiedAt: new Date() } });
    const a = await login("owner-no2fa@test.local", "Owner@12345");
    const r = await a.auth(a.get("/api/v1/owner/overview"));
    expect(r.status).toBe(403); expect(JSON.stringify(r.body)).toContain("totp_setup_required");
  });

  it("owner cannot disable 2FA", async () => {
    const r = await o.auth(o.post("/api/v1/auth/2fa/disable")).set("X-CSRF-Token", o.csrf).send({ password: "Owner@123", code: code() });
    expect(r.status).toBe(403);
  });

  it("owner (with TOTP session) can read every section", async () => {
    for (const s of SECTIONS) { const r = await o.auth(o.get(`/api/v1/owner/${s}`)); expect(r.status, s + JSON.stringify(r.body)).toBe(200); expect(r.body.range || r.body.kpis).toBeTruthy(); }
  });
});

describe("owner dashboard data", () => {
  let o;
  beforeAll(async () => { o = await login("owner@sharik.demo", "Owner@123", code()); });

  it("money KPIs come from a balanced ledger", async () => {
    const r = await o.auth(o.get("/api/v1/owner/money"));
    expect(r.body.kpis.ledgerBalanced).toBe(true);
    expect(r.body.kpis.totalRaisedPKR).toBeGreaterThan(0);
    expect(r.body.series.length).toBeGreaterThanOrEqual(89);
  });

  it("campaign funnel is monotonic and counts statuses", async () => {
    const r = await o.auth(o.get("/api/v1/owner/campaigns?from=2000-01-01"));
    const f = r.body.funnel.map((x) => x.count);
    for (let i = 1; i < f.length; i++) expect(f[i]).toBeLessThanOrEqual(f[i - 1]);
    expect(r.body.kpis.total).toBeGreaterThan(0); expect(r.body.top.length).toBeGreaterThan(0);
  });

  it("users section never leaks CNIC or password hashes", async () => {
    const r = await o.auth(o.get("/api/v1/owner/users?from=2000-01-01"));
    const s = JSON.stringify(r.body);
    expect(s).not.toMatch(/passwordHash|cnicEnc|totpSecret/);
    expect(r.body.kpis.owner).toBeGreaterThanOrEqual(1);
  });

  it("CSV export works for each section with correct headers", async () => {
    for (const s of SECTIONS) {
      const r = await o.auth(o.get(`/api/v1/owner/${s}?format=csv&from=2000-01-01`));
      expect(r.status, s).toBe(200);
      expect(r.headers["content-type"]).toContain("text/csv");
      expect(r.headers["content-disposition"]).toContain(`sharik-${s}-`);
    }
    const m = await o.auth(o.get("/api/v1/owner/money?format=csv"));
    expect(m.text.split("\n")[0]).toContain("date,raised");
  });

  it("rejects invalid date ranges", async () => {
    expect((await o.auth(o.get("/api/v1/owner/money?from=2026-10-10&to=2026-01-01"))).status).toBe(400);
    expect((await o.auth(o.get("/api/v1/owner/money?from=notadate"))).status).toBe(400);
  });

  it("CSV escapes formula injection", () => {
    expect(owner.toCSV([{ a: "=cmd()", b: 'x,"y"' }])).toBe(`a,b\n'=cmd(),"x,""y"""\n`);
  });

  it("track endpoint stores a privacy-safe event and shows in analytics", async () => {
    const before = await db.analyticsEvent.count();
    const r = await request(app).post("/api/v1/track").send({ name: "pageview", path: "/browse", referrer: "https://news.example.com/a?b=c", cid: "test-client-123" });
    expect(r.status).toBe(202);
    expect(await db.analyticsEvent.count()).toBe(before + 1);
    const e = await db.analyticsEvent.findFirst({ orderBy: { id: "desc" } });
    expect(e.referrer).toBe("news.example.com"); expect(e.visitorHash).not.toContain("test-client");
    expect(Object.keys(e)).not.toContain("ip");
    expect((await request(app).post("/api/v1/track").send({ name: "Bad Name!", path: "/" })).status).toBe(400);
    const a = await o.auth(o.get("/api/v1/owner/analytics"));
    expect(a.body.kpis.pageviews).toBeGreaterThan(0); expect(a.body.funnel[0].stage).toBe("Visitors");
  });

  it("ensureOwnerFromEnv is idempotent, hashes the password, and skips when unset", async () => {
    expect((await owner.ensureOwnerFromEnv({})).skipped).toBe(true);
    const env = { OWNER_EMAIL: "Founder@Test.Local", OWNER_PASSWORD: "a-long-test-passphrase" };
    const a = await owner.ensureOwnerFromEnv(env), b = await owner.ensureOwnerFromEnv(env);
    expect(a.created).toBe(true); expect(b.created).toBe(false); expect(b.id).toBe(a.id);
    const u = await db.user.findUnique({ where: { email: "founder@test.local" } });
    expect(u.role).toBe("owner"); expect(u.passwordHash).not.toContain("a-long-test-passphrase"); expect(u.passwordHash).toMatch(/^\$2/);
  });
});
