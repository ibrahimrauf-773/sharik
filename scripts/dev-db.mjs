// Local PostgreSQL for dev/test with no Docker: downloads-free embedded Postgres binaries (npm embedded-postgres).
// Usage: npm run db:start  (keeps running; Ctrl+C to stop). Databases: sharik (dev) and sharik_test (tests) on port 5433.
import EmbeddedPostgres from "embedded-postgres";
const port = +(process.env.PG_PORT || 5433);
const pg = new EmbeddedPostgres({ databaseDir: "./.pgdata", user: "sharik", password: "sharik", port, persistent: true, onLog: () => {} });
import fs from "node:fs";
if (!fs.existsSync("./.pgdata/PG_VERSION")) await pg.initialise();
await pg.start();
for (const db of ["sharik", "sharik_test", "sharik_shadow"]) await pg.createDatabase(db).catch(() => {});
console.log(`Embedded Postgres ready: postgresql://sharik:sharik@localhost:${port}/sharik (and /sharik_test)`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
