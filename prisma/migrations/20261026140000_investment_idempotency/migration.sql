-- AlterTable
ALTER TABLE "Investment" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Investment_idempotencyKey_key" ON "Investment"("idempotencyKey");

