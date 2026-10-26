require("dotenv").config({ path: process.env.DOTENV_PATH || ".env", quiet: true });
const { z } = require("zod");
const isProd = process.env.NODE_ENV === "production";
const devDefault = (v) => (isProd ? undefined : v);
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().url().default("http://localhost:3000"), // public URL of the front end (links in emails)
  API_URL: z.string().url().optional(), // public URL of this API (webhooks / signed file URLs); defaults to APP_URL
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32).default(devDefault("dev-access-secret-change-me-0123456789abcdef")),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_DAYS: z.coerce.number().default(30),
  REFRESH_TOKEN_PEPPER: z.string().min(16).default(devDefault("dev-refresh-pepper-change-me")),
  FIELD_ENCRYPTION_KEY: z.string().refine((s) => Buffer.from(s, "base64").length === 32, "must be 32 bytes base64").default(devDefault("ZGV2LW9ubHktMzItYnl0ZS1rZXktZm9yLXNoYXJpayE=")),
  WEBHOOK_SECRET: z.string().min(16).default(devDefault("dev-mockpay-webhook-secret")),
  FILE_URL_SECRET: z.string().min(16).default(devDefault("dev-file-url-secret")),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).optional(),
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(2000).default(250),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().default(10),
  RATE_LIMIT_API_PER_MIN: z.coerce.number().default(300),
  JOBS_MODE: z.enum(["worker", "inline", "off"]).default("worker"),
  JOB_POLL_MS: z.coerce.number().default(1000),
  REDIS_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default("Sharik <onboarding@resend.dev>"),
  SMS_PROVIDER: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_BUCKET: z.string().default("sharik-docs"),
  UPLOAD_DIR: z.string().default("./uploads"),
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.string().default(isProd ? "info" : "debug"),
  ENABLE_DEV_OUTBOX: z.string().optional(),
});
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:\n" + parsed.error.issues.map((i) => ` - ${i.path.join(".")}: ${i.message}`).join("\n"));
  process.exit(1);
}
const env = parsed.data;
env.API_URL = env.API_URL || env.APP_URL;
env.isProd = env.NODE_ENV === "production";
env.isTest = env.NODE_ENV === "test";
env.corsOrigins = env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
if (env.isProd && env.corsOrigins.includes("*")) { console.error("CORS_ORIGIN must not be * in production"); process.exit(1); }
env.cookieSameSite = env.COOKIE_SAMESITE || (env.isProd ? "none" : "lax");
env.devOutbox = !env.isProd || env.ENABLE_DEV_OUTBOX === "true";
module.exports = env;
