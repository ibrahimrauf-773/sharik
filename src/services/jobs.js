// Job queue. Backends:
//  - BullMQ + Redis when REDIS_URL is set
//  - Postgres-backed queue (Job table, SELECT ... FOR UPDATE SKIP LOCKED) otherwise — works on Render free, no Redis
//  - JOBS_MODE=inline runs jobs immediately (tests / scripts)
// Retries with exponential backoff; jobs must be idempotent (they are: conditional updates + ledger idempotency keys).
const env = require("../config");
const db = require("../lib/db");
const log = require("../lib/logger");
const handlers = {};
let bull = null, timers = [];
const register = (type, fn) => { handlers[type] = fn; };
const backoffMs = (attempt) => Math.min(5000 * 2 ** (attempt - 1), 15 * 60 * 1000);

async function run(type, payload) {
  const h = handlers[type]; if (!h) throw new Error("no handler for job " + type);
  return h(payload);
}
async function enqueue(type, payload = {}, { delayMs = 0, uniqueKey, maxAttempts = 5 } = {}) {
  if (env.JOBS_MODE === "inline") {
    if (delayMs > 0) return { id: null, skipped: "delayed jobs are not run inline" };
    let attempt = 0;
    for (;;) { try { attempt++; await run(type, payload); return { id: null, inline: true }; } catch (e) { if (attempt >= Math.min(maxAttempts, 3)) throw e; } }
  }
  if (bull) {
    const job = await bull.queue.add(type, payload, { delay: delayMs, attempts: maxAttempts, backoff: { type: "exponential", delay: 5000 }, jobId: uniqueKey, removeOnComplete: 1000, removeOnFail: 5000 });
    return { id: job.id };
  }
  try {
    const j = await db.job.create({ data: { type, payload, runAt: new Date(Date.now() + delayMs), maxAttempts, uniqueKey } });
    return { id: j.id };
  } catch (e) { if (e.code === "P2002") return { id: null, duplicate: true }; throw e; }
}

async function pollOnce() {
  const claimed = await db.$queryRaw`UPDATE "Job" SET status='running', attempts=attempts+1, "updatedAt"=now()
    WHERE id = (SELECT id FROM "Job" WHERE status='queued' AND "runAt" <= now() ORDER BY "runAt" FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id, type, payload, attempts, "maxAttempts"`;
  if (!claimed.length) return false;
  const j = claimed[0];
  try {
    await run(j.type, j.payload);
    await db.job.update({ where: { id: j.id }, data: { status: "done", lastError: null } });
  } catch (e) {
    const dead = j.attempts >= j.maxAttempts;
    log.warn({ job: j.id, type: j.type, attempt: j.attempts, err: e.message }, dead ? "job failed permanently" : "job failed; will retry");
    await db.job.update({ where: { id: j.id }, data: { status: dead ? "failed" : "queued", lastError: String(e.message).slice(0, 1000), runAt: new Date(Date.now() + backoffMs(j.attempts)) } });
  }
  return true;
}

function schedule(type, everyMs) {
  // cluster-safe: uniqueKey per time slot so only one instance enqueues each tick
  const tick = () => enqueue(type, {}, { uniqueKey: `sched:${type}:${Math.floor(Date.now() / everyMs)}`, maxAttempts: 1 }).catch((e) => log.warn({ err: e.message }, "schedule failed"));
  timers.push(setInterval(tick, everyMs)); tick();
}

async function start() {
  if (env.JOBS_MODE !== "worker") return;
  if (env.REDIS_URL) {
    const { Queue, Worker } = require("bullmq");
    const IORedis = require("ioredis");
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    bull = { queue: new Queue("sharik", { connection }) };
    bull.worker = new Worker("sharik", (job) => run(job.name, job.data), { connection, concurrency: 4 });
    bull.worker.on("failed", (job, err) => log.warn({ job: job?.id, type: job?.name, err: err.message }, "bull job failed"));
    log.info("job queue: BullMQ (Redis)");
  } else {
    let busy = false;
    timers.push(setInterval(async () => { if (busy) return; busy = true; try { while (await pollOnce()); } catch (e) { log.error({ err: e.message }, "job poll error"); } busy = false; }, env.JOB_POLL_MS));
    log.info("job queue: Postgres-backed worker");
  }
  schedule("closeDueCampaigns", 60_000);
  schedule("expireStalePayments", 60_000);
  schedule("cleanupJobs", 6 * 3600_000);
}
async function stop() { timers.forEach(clearInterval); timers = []; if (bull) { await bull.worker.close(); await bull.queue.close(); } }
register("cleanupJobs", async () => { await db.job.deleteMany({ where: { status: "done", updatedAt: { lt: new Date(Date.now() - 7 * 864e5) } } }); });
module.exports = { register, enqueue, start, stop, pollOnce, kind: () => (env.JOBS_MODE !== "worker" ? env.JOBS_MODE : env.REDIS_URL ? "bullmq" : "postgres") };
