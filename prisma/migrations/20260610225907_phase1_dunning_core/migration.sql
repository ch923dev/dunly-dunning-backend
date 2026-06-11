-- CreateEnum
CREATE TYPE "EmailSendKind" AS ENUM ('SEQUENCE', 'REACTIVATION');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBED', 'BOUNCED', 'MANUAL');

-- AlterTable
ALTER TABLE "DunningCase" ADD COLUMN     "campaignId" TEXT;

-- AlterTable
ALTER TABLE "DunningStep" ADD COLUMN     "isEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sendWindowEnd" INTEGER,
ADD COLUMN     "sendWindowStart" INTEGER,
ADD COLUMN     "skipIfAmountBelow" INTEGER;

-- AlterTable
ALTER TABLE "EmailSend" ADD COLUMN     "error" TEXT,
ADD COLUMN     "kind" "EmailSendKind" NOT NULL DEFAULT 'SEQUENCE',
ADD COLUMN     "subject" TEXT,
ADD COLUMN     "toEmail" TEXT;

-- CreateTable
CREATE TABLE "SuppressionEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SuppressionEntry_organizationId_email_key" ON "SuppressionEntry"("organizationId", "email");

-- AddForeignKey
ALTER TABLE "DunningCase" ADD CONSTRAINT "DunningCase_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "DunningCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
