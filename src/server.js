const env = require("./config");
const log = require("./lib/logger");
const db = require("./lib/db");
const { createApp } = require("./app");
const jobs = require("./services/jobs");
const app = createApp();
const server = app.listen(env.PORT, () => log.info({ port: env.PORT, env: env.NODE_ENV, jobs: jobs.kind() }, `Shareek API listening on :${env.PORT} (docs at /api/docs)`));
// Founder-only owner account: provisioned solely from OWNER_EMAIL/OWNER_PASSWORD env vars (idempotent; never logged).
require("./services/owner").ensureOwnerFromEnv().then((r) => { if (!r.skipped) log.info({ created: r.created }, "owner account provisioned from env"); }).catch((e) => log.error({ err: e.message }, "owner provisioning failed"));
jobs.start().catch((e) => log.error({ err: e.message }, "job worker failed to start"));
async function shutdown(sig) {
  log.info({ sig }, "shutting down");
  server.close();
  await jobs.stop().catch(() => {});
  await db.$disconnect().catch(() => {});
  setTimeout(() => process.exit(0), 200).unref();
}
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
process.on("unhandledRejection", (e) => log.error({ err: e }, "unhandledRejection"));
