// Test DB: apply migrations (non-destructive), then seed (seed TRUNCATEs to a clean state; refuses production).
const { execSync } = require("child_process");
module.exports = async function () {
  const url = process.env.TEST_DATABASE_URL || "postgresql://sharik:sharik@localhost:5433/sharik_test";
  const env = { ...process.env, NODE_ENV: "test", JOBS_MODE: "inline", DATABASE_URL: url, DIRECT_URL: url, UPLOAD_DIR: "./.test-uploads", LOG_LEVEL: "silent" };
  execSync("npx prisma migrate deploy", { env, stdio: "inherit" });
  execSync("node prisma/seed.js", { env, stdio: "inherit" });
};
