/** Dev utility (phase 4): render the two pre-dunning templates to HTML files. */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { renderExpiryEmail } from "../src/lib/email.js";
import { SAMPLE_EXPIRY_PROPS } from "../src/emails/components/layout.js";

for (const key of ["card-expiry-1", "card-expiry-2"]) {
  const { html } = await renderExpiryEmail(key, SAMPLE_EXPIRY_PROPS);
  const path = `${process.env.TEMP ?? "/tmp"}\\${key}.html`;
  writeFileSync(path, html);
  console.log(`${key} → ${path}`);
}
process.exit(0);
