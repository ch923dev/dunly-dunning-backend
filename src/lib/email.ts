import { createElement, type ReactElement } from "react";
import { render } from "@react-email/components";
import { resend } from "./resend.js";
import { env } from "../env.js";
import type { DunningEmailProps } from "../emails/components/layout.js";
import PaymentFailed1 from "../emails/payment-failed-1.js";
import PaymentFailed2 from "../emails/payment-failed-2.js";
import PaymentFailed3 from "../emails/payment-failed-3.js";
import PaymentFailed4 from "../emails/payment-failed-4.js";
import Reactivation from "../emails/reactivation.js";
import CustomBody from "../emails/custom-body.js";

/** templateKey (DunningStep / campaigns.ts) → React Email component. */
const TEMPLATES: Record<string, (props: DunningEmailProps) => ReactElement> = {
  "payment-failed-1": PaymentFailed1,
  "payment-failed-2": PaymentFailed2,
  "payment-failed-3": PaymentFailed3,
  "payment-failed-4": PaymentFailed4,
  reactivation: Reactivation,
};

export function isKnownTemplate(templateKey: string): boolean {
  return templateKey in TEMPLATES;
}

// Stripe zero-decimal currencies: amounts arrive in whole units, not cents.
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

/** Minor units + ISO currency → display string, e.g. (2900, "usd") → "$29.00". */
export function formatAmount(minorUnits: number, currency: string): string {
  const divisor = ZERO_DECIMAL.has(currency.toLowerCase()) ? 1 : 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(minorUnits / divisor);
}

/**
 * Fill {{merge_vars}} in subject lines (product plan §5.4). Unknown variables
 * are left intact rather than blanked — a visible bug beats a silent one.
 */
export function applyMergeVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Merge-var substitution into an HTML context (custom bodyHtml). The stored
 * body is sanitized, but the VALUES arrive at send time and include
 * Stripe-sourced data a hostile end-customer controls (e.g. customer name) —
 * they must be escaped, never trusted. JSX templates get this for free;
 * dangerouslySetInnerHTML does not.
 */
export function applyMergeVarsHtml(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = vars[key];
    if (value === undefined) return match;
    return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
  });
}

export interface RenderedEmail {
  html: string;
  text: string;
}

export async function renderDunningEmail(
  templateKey: string,
  props: DunningEmailProps,
  /**
   * Sanitized + merge-var-escaped custom body. When set, it replaces the
   * templateKey component's prose inside the same locked layout.
   */
  bodyHtml?: string | null,
): Promise<RenderedEmail> {
  let element: ReactElement;
  if (bodyHtml) {
    element = createElement(CustomBody, { ...props, bodyHtml });
  } else {
    const Template = TEMPLATES[templateKey];
    if (!Template) throw new Error(`Unknown email template: ${templateKey}`);
    element = createElement(Template, props);
  }
  return {
    html: await render(element),
    text: await render(element, { plainText: true }),
  };
}

export interface SendDunningEmailInput {
  to: string;
  /** Merchant's workspace name — becomes the friendly-from display name. */
  fromName: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
  /** Provider-side dedupe (4th idempotency layer) — use the EmailSend id. */
  idempotencyKey: string;
}

/**
 * Sends via Resend from the shared domain (EMAIL_FROM) with the merchant as
 * friendly-from + reply-to (phase-1 spec, locked decision #4), plus the
 * RFC 8058 one-click unsubscribe headers Gmail/Yahoo require.
 */
export async function sendDunningEmail(input: SendDunningEmailInput): Promise<string> {
  const displayName = input.fromName.replace(/["\r\n<>]/g, "").trim() || "Billing";
  const { data, error } = await resend.emails.send(
    {
      from: `"${displayName}" <${env.EMAIL_FROM}>`,
      to: [input.to],
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      subject: input.subject,
      html: input.html,
      text: input.text,
      headers: {
        "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    },
    { idempotencyKey: input.idempotencyKey },
  );

  if (error) throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
  if (!data) throw new Error("Resend send returned neither data nor error");
  return data.id;
}
