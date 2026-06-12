/**
 * Dev utility (phase 4): print the token-authenticated public links for a
 * CardExpiryCase — the same URLs the emails embed.
 *
 *   npx tsx scripts/print-expiry-links.ts <cardExpiryCaseId>
 */
import "dotenv/config";
import { makeCaseToken } from "../src/lib/tokens.js";
import { env } from "../src/env.js";

const caseId = process.argv[2];
if (!caseId) {
  console.error("Usage: npx tsx scripts/print-expiry-links.ts <cardExpiryCaseId>");
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      portal: `${env.API_URL}/r/expiry/portal/${makeCaseToken(caseId, "expiry-portal")}`,
      unsubscribe: `${env.API_URL}/r/expiry/unsubscribe/${makeCaseToken(caseId, "expiry-unsubscribe")}`,
    },
    null,
    2,
  ),
);
process.exit(0);
