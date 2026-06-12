-- CreateEnum
CREATE TYPE "CardExpiryStatus" AS ENUM ('OPEN', 'RESOLVED', 'LAPSED', 'CANCELED');

-- AlterEnum
ALTER TYPE "EmailSendKind" ADD VALUE 'PRE_DUNNING';

-- AlterTable
ALTER TABLE "EmailSend" ADD COLUMN     "cardExpiryCaseId" TEXT,
ALTER COLUMN "dunningCaseId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "WorkspaceSettings" ADD COLUMN     "expiryTouch1Enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "expiryTouch2Enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CardExpiryCase" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "stripePaymentMethodId" TEXT NOT NULL,
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "expMonth" INTEGER NOT NULL,
    "expYear" INTEGER NOT NULL,
    "status" "CardExpiryStatus" NOT NULL DEFAULT 'OPEN',
    "protectedAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardExpiryCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CardExpiryCase_connectionId_status_idx" ON "CardExpiryCase"("connectionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CardExpiryCase_customerId_stripePaymentMethodId_expYear_exp_key" ON "CardExpiryCase"("customerId", "stripePaymentMethodId", "expYear", "expMonth");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSend_cardExpiryCaseId_stageOrder_key" ON "EmailSend"("cardExpiryCaseId", "stageOrder");

-- AddForeignKey
ALTER TABLE "EmailSend" ADD CONSTRAINT "EmailSend_cardExpiryCaseId_fkey" FOREIGN KEY ("cardExpiryCaseId") REFERENCES "CardExpiryCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardExpiryCase" ADD CONSTRAINT "CardExpiryCase_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "StripeConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardExpiryCase" ADD CONSTRAINT "CardExpiryCase_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
