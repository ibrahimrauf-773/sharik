// Playwright E2E: boots the app on :3100 against the sharik_test DB (freshly seeded) and drives real Chrome.
const { defineConfig } = require("@playwright/test");
const DB = process.env.TEST_DATABASE_URL || "postgresql://sharik:sharik@localhost:5433/sharik_test";
const env = { NODE_ENV: "test", PORT: "3100", APP_URL: "http://localhost:3100", API_URL: "http://localhost:3100", CORS_ORIGIN: "http://localhost:3100", DATABASE_URL: DB, DIRECT_URL: DB, UPLOAD_DIR: "./.test-uploads", JOB_POLL_MS: "200", LOG_LEVEL: "warn" };
module.exports = defineConfig({
  testDir: "tests/e2e", timeout: 60000, workers: 1, retries: process.env.CI ? 1 : 0,
  globalSetup: require.resolve("./tests/e2e/setup.js"),
  use: { baseURL: "http://localhost:3100", headless: true, launchOptions: process.env.CHROME_PATH || require("fs").existsSync("/usr/bin/google-chrome") ? { executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome" } : {}, trace: "retain-on-failure" },
  webServer: { command: "node src/server.js", url: "http://localhost:3100/health", reuseExistingServer: false, env: { ...process.env, ...env }, timeout: 60000 },
});
