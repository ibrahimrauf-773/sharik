-- CreateTable
CREATE TABLE "AnalyticsEvent" (
    "id" SERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "referrer" TEXT,
    "visitorHash" TEXT NOT NULL,
    "device" TEXT NOT NULL DEFAULT 'desktop',
    "role" TEXT,
    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AnalyticsEvent_at_idx" ON "AnalyticsEvent"("at");
CREATE INDEX "AnalyticsEvent_name_at_idx" ON "AnalyticsEvent"("name", "at");

-- Sessions remember whether login passed TOTP (owner endpoints require it)
ALTER TABLE "Session" ADD COLUMN "mfa" BOOLEAN NOT NULL DEFAULT false;
