-- CreateEnum
CREATE TYPE "ReplyClassification" AS ENUM ('HUMAN', 'AUTO');

-- AlterEnum
ALTER TYPE "EmailSendKind" ADD VALUE 'REPLY_FORWARD';

-- AlterTable
ALTER TABLE "EmailSend" ADD COLUMN     "caseReplyId" TEXT;

-- AlterTable
ALTER TABLE "WorkspaceSettings" ADD COLUMN     "stopOnReplyEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CaseReply" (
    "id" TEXT NOT NULL,
    "dunningCaseId" TEXT NOT NULL,
    "resendInboundId" TEXT NOT NULL,
    "fromEmail" TEXT,
    "subject" TEXT,
    "textBody" TEXT,
    "classification" "ReplyClassification" NOT NULL,
    "autoReason" TEXT,
    "pausedCase" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CaseReply_resendInboundId_key" ON "CaseReply"("resendInboundId");

-- CreateIndex
CREATE INDEX "CaseReply_dunningCaseId_receivedAt_idx" ON "CaseReply"("dunningCaseId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSend_caseReplyId_key" ON "EmailSend"("caseReplyId");

-- AddForeignKey
ALTER TABLE "EmailSend" ADD CONSTRAINT "EmailSend_caseReplyId_fkey" FOREIGN KEY ("caseReplyId") REFERENCES "CaseReply"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseReply" ADD CONSTRAINT "CaseReply_dunningCaseId_fkey" FOREIGN KEY ("dunningCaseId") REFERENCES "DunningCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

