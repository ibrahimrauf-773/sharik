# Sharik — Shariah-compliant equity crowdfunding (production-hardened MVP)

Pakistani startups raise PKR from investors through **Musharakah / Mudarabah**, with Shariah-board screening, escrow, profit/loss distributions and purification.

> ⚠ **Demo only.** Every company, number, approval and Shariah ref is fictional. Payments are **mocked** (no real money moves). Not an offer of securities and not legal/Shariah advice. A real launch needs SECP crowdfunding licensing, a licensed escrow/payment partner and a real Shariah board.

## Architecture
| Layer | What |
|---|---|
| API | Node 20, Express 5, versioned under **`/api/v1`**, Zod validation on every body/query/param, one error shape `{ error: { code, message, details?, requestId } }`, OpenAPI 3 at **`/api/docs`** (JSON at `/api/openapi.json`) |
| Auth | 15-min JWT access token (memory only in the browser) + rotating refresh token in an **httpOnly cookie** (`sharik_rt`, path `/api/v1/auth`) with reuse detection; CSRF double-submit header `X-CSRF-Token` on refresh/logout; real logout / logout-everywhere (server-side session revocation); email verification + password reset via tokens; optional TOTP 2FA (otplib, QR code); role guards on every route (`public` / `user` / `investor` / `founder` / `admin`) |
| DB | Postgres via Prisma **migrations** (`prisma/migrations`), indexes, soft deletes (`deletedAt`), DB triggers making `AuditLog`/`JournalEntry`/`LedgerLine` append-only, deferred trigger enforcing balanced journal entries, CHECK constraint so a campaign can **never be overfilled** (plus an atomic conditional UPDATE) |
| Money | Integer **paisa** (BigInt columns). Double-entry ledger: gateway clearing, investor wallets, escrow per campaign, founder payout, platform fee, purification. Every entry is balanced and has an idempotency key; balances are derived from the ledger. Splits use largest-remainder (Hamilton) allocation |
| Jobs | **BullMQ** when `REDIS_URL` is set; otherwise a Postgres queue (`FOR UPDATE SKIP LOCKED`, exponential backoff). Jobs: deadline close, payment expiry, refunds, distributions, notification delivery, webhook delivery |
| Payments | Mock provider "mockpay" → Stripe-style **HMAC-signed webhooks** (`X-Mockpay-Signature: t=…,v1=…`, 5-min tolerance), idempotent on event id, delivery retried up to 8× |
| Uploads | Storage adapter: **Supabase Storage** if `SUPABASE_URL` + key set, else local disk; downloads only through short-lived **signed URLs**; magic-byte type sniffing, 10 MB cap; private docs visible to owner/admin only |
| Notifications | Email templates (verify, reset, investment confirmed, funded, refunded, reviewed, distribution, security alert) via **Resend** if `RESEND_API_KEY` set, else logged + kept in the dev outbox (`GET /api/v1/dev/outbox`, disabled in production); SMS stub |
| PDFs | Contract summary per investment and portfolio statement (pdfkit) |
| Audit | Append-only audit log (logins, 2FA, KYC, reviews, investments, payments, closes, distributions, withdrawals, deletes) — admin UI at `#/audit` |
| Security | helmet + CSP, strict CORS allow-list, bad-Origin rejection on unsafe methods, rate limits (auth 10/min/IP, API 300/min/IP), **AES-256-GCM** encryption of CNIC (only last 4 stored in clear), secrets required from env in production (process refuses to boot without them) |
| Ops | pino JSON logs with request ids, `GET /health` (+ `/api/v1/health` with component status), Sentry if `SENTRY_DSN` set, graceful shutdown, Redis/in-memory cache for the campaign listing |
| Front end | Original green/gold demo UI in `public/` (static, plain JS). Pages: browse, campaign (with documents), invest flow (reserve → mock pay → webhook → escrow), portfolio (statement PDF, withdraw), contract (PDF), founder (submit + upload), Shariah board console, audit log, ledger, account & security (2FA, KYC, sessions), forgot/reset/verify |

## Run locally
```bash
npm install
cp .env.example .env
npm run db:local &        # embedded Postgres on localhost:5433 (dbs: sharik, sharik_test, sharik_shadow) — or point DATABASE_URL at any Postgres
npm run setup             # prisma migrate deploy + seed
npm start                 # http://localhost:3000  ·  API docs: http://localhost:3000/api/docs
npm run seed              # reset to the clean demo state at any time
```
Demo logins: `investor@sharik.demo / Investor@123` · `founder@sharik.demo / Founder@123` · `admin@sharik.demo / Admin@123` · `crowd1…6@sharik.demo / Crowd@1234`.

## Tests
```bash
npm run test:unit         # vitest — money math (allocation, rounding, loss sharing)
npx vitest run            # unit + supertest integration against sharik_test (migrate deploy + seed in globalSetup)
npm run test:e2e          # Playwright (system Chrome or CHROME_PATH) — boots the app on :3100 against sharik_test
npm run test:smoke        # curl smoke test against a running server (re-seed afterwards)
```
Set `TEST_DATABASE_URL` to use another test database. Tests **never** touch the dev DB.

## Deploy (free tiers): Supabase + Render + Vercel
Recommended topology: Vercel serves `public/` and **rewrites `/api/*` to Render**, so the browser sees one site — the refresh cookie is first-party (works in Safari) and `COOKIE_SAMESITE=lax`.

### 1. Supabase (Postgres + Storage) — supabase.com → New project (Free)
1. Pick region (e.g. Singapore / Mumbai), set a DB password — save it.
2. **Connect** button (top bar) → *ORMs → Prisma* or *Connection string*:
   - `DATABASE_URL` = **Transaction pooler** string (port **6543**) + `?pgbouncer=true&connection_limit=5`
   - `DIRECT_URL` = **Session pooler** string (port **5432**) — used by `prisma migrate deploy`
3. *(optional, recommended — Render's free disk is wiped on every deploy)* **Storage** → New bucket `sharik-docs`, **Private**. Then **Project Settings → API**: `SUPABASE_URL` = Project URL, `SUPABASE_SERVICE_ROLE_KEY` = `service_role` secret key (server-side only, never in the front end).
4. Free projects pause after ~1 week of inactivity — restore from the dashboard.

### 2. Render (API) — render.com → New → **Blueprint** → connect the GitHub repo
`render.yaml` creates `sharik-api` (free plan, Node 20, build `npm run render-build` = `npm ci && prisma generate && prisma migrate deploy`, health `/health`). Render auto-generates `JWT_ACCESS_SECRET`, `REFRESH_TOKEN_PEPPER`, `WEBHOOK_SECRET`, `FILE_URL_SECRET`. Paste the rest in **sharik-api → Environment**:

| Variable | Required | Where the value comes from |
|---|---|---|
| `DATABASE_URL` | ✅ | Supabase → Connect → Transaction pooler (6543) + `?pgbouncer=true&connection_limit=5` |
| `DIRECT_URL` | ✅ | Supabase → Connect → Session pooler (5432) |
| `FIELD_ENCRYPTION_KEY` | ✅ | run `openssl rand -base64 32` locally. **Back it up** — losing it makes stored CNICs unreadable |
| `APP_URL` | ✅ | your Vercel URL, e.g. `https://sharik.vercel.app` |
| `API_URL` | ✅ | your Render URL, e.g. `https://sharik-api.onrender.com` (Render → service page, top) |
| `CORS_ORIGIN` | ✅ | same as `APP_URL` (comma-separate several; never `*`) |
| `COOKIE_SAMESITE` | preset `lax` | `none` only if the browser calls Render directly cross-site |
| `JWT_ACCESS_SECRET`, `REFRESH_TOKEN_PEPPER`, `WEBHOOK_SECRET`, `FILE_URL_SECRET` | auto | generated by Render (or `openssl rand -hex 32`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET` | optional | Supabase → Project Settings → API; bucket name from Storage |
| `RESEND_API_KEY`, `MAIL_FROM` | optional | resend.com → API Keys. `onboarding@resend.dev` only delivers to your own address; verify a domain (Resend → Domains) to email anyone |
| `REDIS_URL` | optional | upstash.com → Create Redis DB (free) → `rediss://…` URL. Enables BullMQ + Redis cache; blank = Postgres queue |
| `SENTRY_DSN` | optional | sentry.io → Project → Settings → Client Keys (DSN) |
| `PLATFORM_FEE_BPS`, `LOG_LEVEL`, `JOBS_MODE`, `RATE_LIMIT_*`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_DAYS` | defaults | tune as needed |

First deploy: the build runs migrations. To load demo data once, open Render → sharik-api → **Shell** and run `ALLOW_PROD_SEED=true npm run seed` (this **wipes** the database; never on real data). Free instances sleep after 15 min idle (first request ~30–60 s); the job worker runs inside the web process, so deadline closes run when it is awake (call `/health` from a free uptime pinger such as UptimeRobot to keep it warm).

### 3. Vercel (front end) — vercel.com → Add New → Project → import the same repo
1. Edit `vercel.json` → replace `https://sharik-api.onrender.com` in both rewrites with your Render URL; commit.
2. Framework preset **Other**; build/output come from `vercel.json` (`public/`). Leave `SHARIK_API_BASE` **unset** (same-origin via rewrite). Only set it to the Render URL if you skip the rewrite (then use `COOKIE_SAMESITE=none`).
3. Deploy → copy the URL into Render's `APP_URL` and `CORS_ORIGIN` → redeploy Render.

### 4. GitHub Actions (`.github/workflows/ci.yml`)
Runs unit + integration + Playwright against a Postgres service on every push/PR; on push to `main` (production) or `staging` it calls deploy hooks. Add repository/environment secrets:
- `RENDER_DEPLOY_HOOK_URL` — Render → sharik-api → Settings → **Deploy Hook**
- `VERCEL_DEPLOY_HOOK_URL` — Vercel → Project → Settings → Git → **Deploy Hooks** (branch `main`)

`render.yaml` sets `autoDeploy: false` so deploys happen only after tests pass.

### Staging vs production
- Create a second Supabase project + a second Render service (`sharik-api-staging`, branch `staging`) + a Vercel preview/branch domain; give each its **own secrets** and DB. Put hooks in GitHub *environments* `staging` and `production` (with required reviewers on production).
- Staging may set `ENABLE_DEV_OUTBOX=true` to read emails at `/api/v1/dev/outbox`; **never** in production.
- Migrations: `prisma migrate deploy` only (never `migrate reset`/`db push` in prod). Back up Supabase before risky migrations.
- Rotate secrets by changing them in Render (rotating `JWT_ACCESS_SECRET` logs everyone out; rotating `FIELD_ENCRYPTION_KEY` needs a re-encryption script — not included).

## Key API flows
- `POST /api/v1/auth/login` → `{accessToken, csrfToken, user}` + cookie. `POST /auth/refresh` with `X-CSRF-Token` → new access token, rotated cookie.
- `POST /campaigns/:slug/invest` (`Idempotency-Key` header) reserves capacity atomically → `payment.id` → `POST /payments/:id/mock-pay` → signed webhook → status `escrow`. Unpaid reservations expire after 30 min.
- `POST /admin/campaigns/:id/close` (or the deadline job) → **funded**: escrow → founder payout minus 2.5% fee; **failed**: refund jobs → wallets.
- `POST /admin/campaigns/:id/distributions` → job posts payouts (profit by ratio, Musharakah losses by capital share, Mudarabah losses to capital), purification tracked per payout.

## Not production-complete (by design for the demo)
Real payment gateway/escrow bank (JazzCash/Easypaisa/1LINK), SECP/NADRA KYC verification, real SMS provider, key-rotation tooling, malware scanning of uploads, and a separate worker service (Render free tier has no background workers).
