const { test, expect } = require("@playwright/test");
async function login(page, email, password) {
  await page.goto("/#/login");
  await page.fill('input[name=email]', email); await page.fill('input[name=password]', password);
  await page.click('form button.btn');
  await expect(page.locator("#navu")).toContainText("Logout");
}
test.beforeEach(async ({ page }) => { page.on("dialog", (d) => d.accept()); });

test("browse campaigns and see documents", async ({ page }) => {
  await page.goto("/#/browse");
  await expect(page.getByText("ZaraatTech").first()).toBeVisible();
  await page.goto("/#/c/chai-junction");
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  await expect(page.getByText("Shariah board ruling SSB-2026-041")).toBeVisible();
});

test("investor invests via mock payment webhook, sees portfolio, session survives reload via refresh cookie", async ({ page }) => {
  await login(page, "investor@sharik.demo", "Investor@123");
  await page.goto("/#/invest/taleem-box/1");
  await page.fill("#amt", "7500");
  await page.click("#go1");
  // step 2: contract + consents
    await page.check("#k1"); await page.check("#k2"); await page.click("#go2");
  await page.click("#pay");
  await expect(page.getByText(/SHK-[0-9A-F]{8}/)).toBeVisible({ timeout: 20000 });
  await page.reload();
  await expect(page.locator("#navu")).toContainText("Logout");
  await page.goto("/#/portfolio");
  await expect(page.getByText("TaleemBox").first()).toBeVisible();
  await expect(page.getByText("Download statement (PDF)")).toBeVisible();
  await page.click("#navu >> text=Logout");
  await page.reload();
  await expect(page.locator("#navu")).not.toContainText("Logout");
});

test("admin sees audit log and balanced ledger", async ({ page }) => {
  await login(page, "admin@sharik.demo", "Admin@123");
  await page.goto("/#/audit");
  await expect(page.getByRole("heading", { name: /Audit log/ })).toBeVisible();
  await expect(page.getByText("auth.login").first()).toBeVisible();
  await page.goto("/#/ledger");
  await expect(page.getByText("✓ balanced")).toBeVisible();
});

test("founder sees campaigns and upload form; forgot password flow", async ({ page }) => {
  await login(page, "founder@sharik.demo", "Founder@123");
  await page.goto("/#/founder");
  await expect(page.getByRole("heading", { name: "Upload a document" })).toBeVisible();
  await page.click("#navu >> text=Logout");
  await expect(page.locator("#navu")).not.toContainText("Logout");
  await page.goto("/#/forgot");
  await page.fill("input[name=email]", "founder@sharik.demo"); await page.click("#ff button");
  await expect(page.getByText("Check your email")).toBeVisible();
});

test("PWA + mobile shell: manifest, service worker, tab bar, no CSP violations", async ({ page, request }) => {
  const csp = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text()); });
  await page.setViewportSize({ width: 390, height: 844 });
  const man = await request.get("/manifest.webmanifest");
  expect(man.ok()).toBeTruthy();
  const mj = await man.json();
  expect(mj.short_name).toBe("Shareek");
  expect(mj.display).toBe("standalone");
  expect((await request.get("/sw.js")).ok()).toBeTruthy();
  expect((await request.get("/offline.html")).ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.locator("#tabs")).toBeVisible();
  await expect(page.locator("#tabs a")).toHaveCount(4);
  await expect(page.getByRole("heading", { name: /next great/ })).toBeVisible();
  const reg = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; });
  expect(reg).toBeTruthy();
  await page.locator(".camp").first().click();
  await expect(page.locator(".cta-bar")).toBeVisible();
  expect(csp).toEqual([]);
});
