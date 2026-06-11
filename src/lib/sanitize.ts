import sanitizeHtml from "sanitize-html";

/**
 * Server-side sanitizer for user-edited email bodies (phase-2 spec, locked
 * decision #4). Runs on SAVE and on PREVIEW drafts — stored bodyHtml is
 * always already-sanitized. The allowlist is deliberately tiny: dunning
 * emails are short transactional text, not designed layouts.
 *
 * The locked footer needs no defense here — it lives in the React layout
 * (chrome), outside the editable content entirely.
 */
export function sanitizeEmailBody(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "a", "ul", "ol", "li"],
    allowedAttributes: { a: ["href"] },
    // http(s) links only; merge-var hrefs like {{update_payment_link}} pass
    // because they parse as relative URLs (substituted at send time).
    allowedSchemes: ["http", "https"],
    disallowedTagsMode: "discard",
  }).trim();
}
