// Seeds fictional demo data THROUGH the real service layer (invest → signed-webhook payment → escrow → close → release → distributions),
// so the double-entry ledger is fully consistent. Safe to re-run: wipes all data first.
process.env.JOBS_MODE = "inline";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "warn";
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const env = require("../src/config");
const db = require("../src/lib/db");
const camp = require("../src/services/campaigns");
const payments = require("../src/services/payments");
const docs = require("../src/services/documents");
const pdf = require("../src/services/pdf");
const { screen } = require("../src/services/shariah");
const { toPaisa } = require("../src/lib/money");
const L = require("../src/services/ledger");
const D = 864e5;

(async () => {
  if (env.isProd && process.env.ALLOW_PROD_SEED !== "true") { console.error("Refusing to wipe a production DB. Set ALLOW_PROD_SEED=true to override."); process.exit(1); }
  const tables = ["AnalyticsEvent", "AuditLog", "LedgerLine", "JournalEntry", "LedgerAccount", "Payout", "Distribution", "WebhookEvent", "Payment", "Investment", "Document", "Campaign", "Session", "AuthToken", "Notification", "Job", "User"];
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  if (fs.existsSync(env.UPLOAD_DIR) && require("../src/services/storage").kind === "local") fs.rmSync(env.UPLOAD_DIR, { recursive: true, force: true });

  const now = new Date();
  const DEV_OWNER_TOTP = "JBSWY3DPEHPK3PXP"; // public dev-only TOTP secret
  const mk = async (email, name, role, pw) => db.user.create({ data: { email, name, role, passwordHash: await bcrypt.hash(pw, 10), emailVerifiedAt: now } });
  const investor = await mk("investor@sharik.demo", "Ayesha Investor (Demo)", "investor", "Investor@123");
  const founder = await mk("founder@sharik.demo", "Bilal Founder (Demo)", "founder", "Founder@123");
  const admin = await mk("admin@sharik.demo", "Shariah Board (Demo)", "admin", "Admin@123");
  const crowd = []; for (let i = 1; i <= 6; i++) crowd.push(await mk(`crowd${i}@sharik.demo`, `Sample Investor ${i}`, "investor", "Crowd@1234"));

  const C = [
    ["chai-junction", "Chai Junction (Sample)", "☕", "Food & Beverage", "Musharakah", "Lahore", 6000000, 48000000, 60, "#fdf1dc", "Fictional tea-café chain planning 6 new outlets near university campuses.", "funded"],
    ["zaraat-tech", "ZaraatTech (Sample)", "🌾", "AgriTech", "Mudarabah", "Multan", 25000000, 200000000, 50, "#e7f5e9", "Fictional IoT soil sensors & advisory app for smallholder farmers.", "live"],
    ["karigar-hub", "Karigar Hub (Sample)", "🧵", "E-commerce", "Musharakah", "Karachi", 800000, 60000000, 55, "#f3e8fb", "Fictional marketplace connecting women artisans to global buyers.", "live"],
    ["shifa-labs", "ShifaLabs (Sample)", "🩺", "HealthTech", "Musharakah", "Islamabad", 30000000, 300000000, 65, "#e3f0fb", "Fictional home diagnostic sample-collection service.", "live"],
    ["suraj-energy", "Suraj Energy (Sample)", "☀️", "Clean Energy", "Mudarabah", "Faisalabad", 20000000, 150000000, 40, "#fff6d6", "Fictional rooftop solar leasing for SMEs and textile units.", "live"],
    ["taleem-box", "TaleemBox (Sample)", "📚", "EdTech", "Musharakah", "Peshawar", 5000000, 35000000, 50, "#fde7e7", "Fictional Urdu/Pashto learning app for grades 1–8.", "live"],
    ["halwa-house", "Halwa House (Sample)", "🍮", "Food & Beverage", "Musharakah", "Hyderabad", 3000000, 20000000, 55, "#fbeee0", "Fictional sweets brand expanding to online delivery. Awaiting Shariah board review.", "pending"],
    ["quickcredit-pk", "QuickCredit PK (Sample)", "💳", "Fintech", "Mudarabah", "Karachi", 10000000, 90000000, 50, "#eeeeee", "Fictional consumer lending app — included to demo a FAILING screen (high interest-bearing debt).", "pending"],
  ];
  const camps = {};
  const days = { "karigar-hub": 5, "zaraat-tech": 34, "shifa-labs": 45, "suraj-energy": 12, "taleem-box": 28 };
  for (const [slug, name, emoji, sector, structure, city, target, valuation, investorRatio, bg, description, status] of C) {
    const data = { slug, name, emoji, sector, structure, city, investorRatio, bg, description, founderId: founder.id, status: "pending",
      targetPaisa: BigInt(toPaisa(target)), valuationPaisa: BigInt(toPaisa(valuation)), minTicketPaisa: BigInt(toPaisa(slug === "shifa-labs" ? 10000 : 5000)),
      useOfFunds: "Expansion 60%, team 25%, working capital 15% (fictional)", durationDays: days[slug] || 30, secpRegNo: "00" + (1000 + Object.keys(camps).length * 37),
      haramSector: false, interestDebtRatio: slug === "quickcredit-pk" ? 48 : 12, interestIncomePct: slug === "chai-junction" ? 1.1 : slug === "quickcredit-pk" ? 30 : 0 };
    data.screening = screen(data);
    const c = await db.campaign.create({ data });
    if (status !== "pending") {
      const checklist = Object.fromEntries(data.screening.checks.map((x) => [x.key, true]));
      await camp.review(admin, c.id, { decision: "approve", checklist, note: "Approved (sample ruling)." });
    }
    camps[slug] = await db.campaign.findUnique({ where: { id: c.id } });
  }
  // invest via real flow: reserve → provider webhook (signed) → escrow
  const invest = async (u, slug, amount) => {
    const r = await camp.invest(u, slug, { amountPaisa: toPaisa(amount), method: ["JazzCash", "Easypaisa", "Bank transfer"][u.id % 3] }, null);
    const evt = { id: "evt_seed_" + crypto.randomBytes(6).toString("hex"), type: "payment.succeeded", data: { paymentId: r.payment.id } };
    const raw = JSON.stringify(evt);
    await payments.handleWebhook(raw, payments.sign(raw));
    return r;
  };
  await invest(investor, "chai-junction", 25000);
  for (const [i, u] of crowd.entries()) await invest(u, "chai-junction", [1500000, 1200000, 1000000, 900000, 800000, 575000][i]);
  await camp.close(camps["chai-junction"].id, admin);
  const chai = camps["chai-junction"].id;
  for (const [period, net, imp, note] of [["Q2 2026", 900000, 0, ""], ["Q3 2026", 1150000, 1.1, "1.1% of Q3 income was bank profit on a legacy current account (fictional) — purify."]])
    await camp.createDistribution(admin, chai, { period, netResultPaisa: toPaisa(net), impermissiblePct: imp, note });
  await db.campaign.update({ where: { id: chai }, data: { goLiveAt: new Date(now - 230 * D), deadline: new Date(now - 200 * D), closedAt: new Date(now - 200 * D) } });

  await invest(investor, "suraj-energy", 50000);
  await invest(investor, "karigar-hub", 10000);
  for (const [i, u] of crowd.entries()) {
    await invest(u, "suraj-energy", 2400000); await invest(u, "zaraat-tech", 1500000); await invest(u, "karigar-hub", 120000);
    if (i < 3) await invest(u, "taleem-box", 500000);
    if (i < 2) await invest(u, "shifa-labs", 3000000);
  }
  // live campaigns went live 20 days ago (sample)
  for (const s of Object.keys(days)) await db.campaign.update({ where: { slug: s }, data: { goLiveAt: new Date(now - 20 * D), deadline: new Date(+now + days[s] * D) } });

  // sample documents (generated PDFs) through the storage adapter
  for (const [slug, c] of Object.entries(camps)) {
    const lines = [`${c.name} — fictional sample document for the Shareek demo.`, `Sector: ${c.sector} · City: ${c.city} · Structure: ${c.structure}`, c.description, "All figures are fictional."];
    const put = async (kind, title, visibility = "public") => docs.save({ buf: await pdf.samplePdf(title, lines), mime: "application/pdf", filename: `${slug}-${kind}.pdf`, kind, title, campaignId: c.id, visibility, actorId: founder.id });
    await put("pitch_deck", `${c.name} — Pitch deck`);
    await put("financials", `${c.name} — Financial summary`);
    if (c.status !== "pending") await put("fatwa", `Shariah board ruling ${c.shariahRef || ""}`.trim());
    await put("agreement", `${c.structure} agreement (template)`, "private");
  }
  // Dev/test-only owner (founder dashboard). NEVER created in production — prod owner comes from OWNER_EMAIL/OWNER_PASSWORD.
  if (!env.isProd) {
    const { encrypt } = require("../src/lib/crypto");
    await db.user.create({ data: { email: "owner@sharik.demo", name: "Owner (Dev)", role: "owner", passwordHash: await bcrypt.hash("Owner@123", 10), emailVerifiedAt: now, totpEnabled: true, totpSecretEnc: encrypt(DEV_OWNER_TOTP) } });
    // sample first-party analytics so the dashboard has traffic to show
    const paths = ["/", "/browse", "/c/chai-junction", "/signup", "/login", "/learn"], rows = [];
    for (let d = 0; d < 30; d++) for (let k = 0; k < 5 + ((d * 7) % 11); k++) {
      const at = new Date(now.getTime() - d * 864e5 - k * 3.6e6), v = `v${d}-${k % 4}`;
      rows.push({ at, name: "pageview", path: paths[(d + k) % paths.length], visitorHash: v, device: k % 3 ? "desktop" : "mobile", referrer: k % 4 === 0 ? "google.com" : null });
      if (k % 5 === 0) rows.push({ at, name: "invest_start", path: "/invest", visitorHash: v });
    }
    await db.analyticsEvent.createMany({ data: rows });
  }
  await db.$executeRawUnsafe(`TRUNCATE "Notification", "Job" RESTART IDENTITY`);
  const tb = await L.trialBalance();
  console.log(`Seeded: ${await db.user.count()} users, ${await db.campaign.count()} campaigns, ${await db.investment.count()} investments, ${await db.journalEntry.count()} journal entries; ledger balanced=${tb.balanced}`);
  console.log("Demo logins: investor@sharik.demo / Investor@123 · founder@sharik.demo / Founder@123 · admin@sharik.demo / Admin@123 · crowd1-6@sharik.demo / Crowd@1234" + (env.isProd ? "" : " · owner@sharik.demo / Owner@123 (dev only; TOTP secret " + DEV_OWNER_TOTP + ")"));
  await db.$disconnect();
})().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
