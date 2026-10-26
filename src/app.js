const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const pinoHttp = require("pino-http");
const path = require("path");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const swaggerUi = require("swagger-ui-express");
const { ZodError } = require("zod");
const env = require("./config");
const log = require("./lib/logger");
const db = require("./lib/db");
const { AppError } = require("./lib/errors");
const { router, def, openapi, z } = require("./http/registry");
require("./http/routes");
const payments = require("./services/payments");

let Sentry = null;
if (env.SENTRY_DSN) { Sentry = require("@sentry/node"); Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV, tracesSampleRate: 0.1 }); }

// webhook documented in OpenAPI; handled below with raw body
def("post", "/webhooks/mockpay", { tag: "webhooks", summary: "Mockpay webhook. Header X-Mockpay-Signature: t=<unix>,v1=<hmac_sha256(WEBHOOK_SECRET, t + '.' + rawBody)>. Idempotent on event id.", headers: ["X-Mockpay-Signature"] }, () => { throw new Error("unreachable"); });

function createApp() {
  const app = express();
  app.set("trust proxy", 1); // Render / Vercel sit behind one proxy hop
  app.disable("x-powered-by");
  app.use((req, res, next) => { req.id = req.get("x-request-id") || crypto.randomUUID(); res.set("X-Request-Id", req.id); next(); });
  app.use(pinoHttp({ logger: log, serializers: { req: (r) => ({ id: r.id, method: r.method, url: r.url }), res: (r) => ({ statusCode: r.statusCode }) }, genReqId: (req) => req.id, autoLogging: { ignore: (req) => req.url === "/health" }, customLogLevel: (_q, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info") }));
  app.use(helmet({
    contentSecurityPolicy: { directives: { "default-src": ["'self'"], "script-src": ["'self'"], "script-src-attr": ["'unsafe-inline'"], "style-src": ["'self'", "'unsafe-inline'"], "img-src": ["'self'", "data:", "blob:"], "connect-src": ["'self'", ...env.corsOrigins.filter((o) => o !== "*")], "frame-ancestors": ["'none'"], "object-src": ["'none'"], "upgrade-insecure-requests": env.isProd ? [] : null } },
    crossOriginResourcePolicy: { policy: "same-site" },
    hsts: env.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
  }));
  const corsMw = cors({
    origin: (origin, cb) => (!origin || env.corsOrigins.includes(origin) ? cb(null, true) : cb(null, false)),
    credentials: true, methods: ["GET", "POST", "DELETE", "PATCH", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "Idempotency-Key", "X-Request-Id"], exposedHeaders: ["X-Request-Id"], maxAge: 600,
  });
  app.use("/api", corsMw);
  // Raw-body webhook BEFORE json parser (HMAC is computed over exact bytes)
  app.post("/api/v1/webhooks/mockpay", express.raw({ type: "*/*", limit: "100kb" }), async (req, res) => {
    const out = await payments.handleWebhook(req.body?.toString("utf8") || "", req.get("x-mockpay-signature"));
    res.json(out);
  });
  app.use(express.json({ limit: "200kb" }));
  app.use(cookieParser());
  // Cross-origin state-changing requests from unknown origins are refused (CSRF defence-in-depth alongside Bearer + X-CSRF-Token).
  app.use("/api", (req, _res, next) => {
    const o = req.get("origin");
    if (o && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !env.corsOrigins.includes(o) && o !== `${req.protocol}://${req.get("host")}`) return next(new AppError(403, "bad_origin", "Origin not allowed"));
    next();
  });
  app.use("/api/v1", rateLimit({ windowMs: 60_000, limit: env.RATE_LIMIT_API_PER_MIN, standardHeaders: "draft-7", legacyHeaders: false, skip: () => env.isTest && !process.env.TEST_RATE_LIMIT, handler: (_q, res) => res.status(429).json({ error: { code: "rate_limited", message: "Too many requests" } }) }));

  app.get("/health", async (_req, res) => { try { await db.$queryRaw`SELECT 1`; res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });
  app.get("/api/openapi.json", (req, res) => res.json(openapi(env.API_URL)));
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(null, { swaggerOptions: { url: "/api/openapi.json" }, customSiteTitle: "Sharik API docs" }));
  app.use("/api/v1", router);
  app.use("/api", (req, _res, next) => next(new AppError(404, "not_found", `No route ${req.method} ${req.originalUrl}${req.originalUrl.startsWith("/api/v1") ? "" : " (API is versioned: use /api/v1)"}`)));

  // Front end (same-origin when served by Render; Vercel serves /public separately)
  app.use(express.static(path.join(__dirname, "..", "public"), { index: "index.html", maxAge: env.isProd ? "1h" : 0 }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = 500, body = { code: "internal", message: "Something went wrong" };
    if (err instanceof ZodError) { status = 400; body = { code: "validation_failed", message: err.issues.map((i) => (i.path.length ? i.path.join(".") + ": " : "") + i.message).join("; "), details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }; }
    else if (err instanceof AppError) { status = err.status; body = { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }; }
    else if (err?.name === "MulterError") { status = 400; body = { code: "upload_error", message: err.code === "LIMIT_FILE_SIZE" ? "File too large (max 10 MB)" : err.message }; }
    else if (err?.type === "entity.parse.failed") { status = 400; body = { code: "invalid_json", message: "Malformed JSON body" }; }
    else if (err?.type === "entity.too.large") { status = 413; body = { code: "too_large", message: "Request body too large" }; }
    else if (err?.code === "P2002") { status = 409; body = { code: "conflict", message: "Duplicate value" }; }
    else if (err?.code === "P2025") { status = 404; body = { code: "not_found", message: "Not found" }; }
    else if (/campaign_not_overfilled/.test(err?.message || "")) { status = 409; body = { code: "overfill", message: "Campaign capacity exceeded" }; }
    if (status >= 500) { req.log?.error({ err }, "unhandled error"); Sentry?.captureException(err); }
    res.status(status).json({ error: { ...body, requestId: req.id } });
  });
  return app;
}
module.exports = { createApp };
