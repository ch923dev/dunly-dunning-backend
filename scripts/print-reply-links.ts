/**
 * Dev utility (phase 5): print the stop-on-reply artifacts for a case —
 * the rerouted Reply-To address and the one-tap Resume / Stop links from
 * the forward email.
 *
 * Usage: npx tsx scripts/print-reply-links.ts <dunningCaseId>
 */
import "dotenv/config";
import { makeReplyAddress } from "../src/lib/replies.js";
import { makeCaseToken } from "../src/lib/tokens.js";
import { env } from "../src/env.js";

const caseId = process.argv[2];
if (!caseId) {
  console.error("Usage: npx tsx scripts/print-reply-links.ts <dunningCaseId>");
  process.exit(1);
}

console.log(`reply-to:  ${makeReplyAddress(caseId) ?? "(INBOUND_REPLY_DOMAIN unset)"}`);
console.log(`resume:    ${env.API_URL}/r/case/resume/${makeCaseToken(caseId, "case-resume")}`);
console.log(`stop:      ${env.API_URL}/r/case/stop/${makeCaseToken(caseId, "case-stop")}`);
