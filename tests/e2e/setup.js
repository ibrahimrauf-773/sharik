const { execSync } = require("child_process");
module.exports = async () => {
  const url = process.env.TEST_DATABASE_URL || "postgresql://sharik:sharik@localhost:5433/sharik_test";
  const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: url, DIRECT_URL: url, UPLOAD_DIR: "./.test-uploads" };
  execSync("npx prisma migrate deploy && node prisma/seed.js", { env, stdio: "inherit" });
};
