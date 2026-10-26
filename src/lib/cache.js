// Cache: Redis when REDIS_URL is set, else in-process memory (fine for a single Render instance).
const env = require("../config");
const log = require("./logger");
let redis = null;
if (env.REDIS_URL && !env.isTest) {
  const Redis = require("ioredis");
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  redis.on("error", (e) => log.warn({ err: e.message }, "redis cache error"));
}
const mem = new Map();
module.exports = {
  kind: redis ? "redis" : "memory",
  async get(k) {
    if (redis) { const v = await redis.get("cache:" + k).catch(() => null); return v ? JSON.parse(v) : null; }
    const e = mem.get(k); if (!e || e.exp < Date.now()) { mem.delete(k); return null; } return e.v;
  },
  async set(k, v, ttlSec = 30) {
    if (redis) return redis.set("cache:" + k, JSON.stringify(v), "EX", ttlSec).catch(() => {});
    mem.set(k, { v, exp: Date.now() + ttlSec * 1000 });
  },
  async delPrefix(p) {
    if (redis) { const keys = await redis.keys("cache:" + p + "*").catch(() => []); if (keys.length) await redis.del(keys); return; }
    for (const k of mem.keys()) if (k.startsWith(p)) mem.delete(k);
  },
};
