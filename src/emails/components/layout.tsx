import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { CSSProperties, ReactNode } from "react";

/**
 * Render data shared by every dunning template (phase-1 spec "Email layer").
 * All fields are required-but-nullable so the renderer is forced to be
 * explicit about what it knows (exactOptionalPropertyTypes-friendly).
 *
 * Visual language: /DESIGN.md (email component) — paper canvas, white card,
 * ink neutrals, brand green default, monospace amounts.
 */
export interface DunningEmailProps {
  customerName: string | null;
  companyName: string;
  planName: string | null;
  /** Pre-formatted, e.g. "$29.00" (src/lib/email.ts formatAmount). */
  amountFormatted: string;
  brandColor: string | null;
  logoUrl: string | null;
  /** Stripe hosted invoice page — the primary pay / fix-card CTA. */
  payUrl: string;
  /** Dunly redirect that mints a fresh Stripe portal session on click. */
  portalUrl: string;
  unsubscribeUrl: string;
}

/** DESIGN.md colors.brand.DEFAULT — deep "money + safety" green. */
export const DEFAULT_BRAND_COLOR = "#13714c";

// DESIGN.md ink/paper/line tokens (email-safe subset).
const INK = "#1a1a1a";
const INK_SOFT = "#3f3f46";
const INK_MUTE = "#71717a";
const INK_FAINT = "#a1a1aa";
const PAPER = "#fbfbfa";
const LINE = "#e8e8e6";

// Web-safe stacks only — never webfonts in HTML email (DESIGN.md don'ts).
const FONT_SANS = "Helvetica, Arial, sans-serif";
const FONT_MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Courier New', monospace";

/** Used by the react-email preview server and the test-send script. */
export const SAMPLE_PROPS: DunningEmailProps = {
  customerName: "Jamie",
  companyName: "Acme Analytics",
  planName: "Growth",
  amountFormatted: "$29.00",
  brandColor: DEFAULT_BRAND_COLOR,
  logoUrl: null,
  payUrl: "https://invoice.stripe.com/i/example",
  portalUrl: "http://localhost:4000/r/portal/sample-token",
  unsubscribeUrl: "http://localhost:4000/r/unsubscribe/sample-token",
};

/**
 * Render data for the pre-dunning (card-expiry) templates — phase-4 spec,
 * locked decision #7. No amounts, no invoice: there's nothing owed yet, and
 * the copy must stay service-continuity, never charge-reminder.
 */
export interface ExpiryEmailProps {
  customerName: string | null;
  companyName: string;
  planName: string | null;
  /** Display-ready, e.g. "Visa" (src/lib/predunning.ts formatCardBrand). */
  cardBrand: string | null;
  cardLast4: string | null;
  /** Display-ready, e.g. "June 2026" (formatCardExpiry). */
  cardExpiry: string;
  brandColor: string | null;
  logoUrl: string | null;
  /** Dunly redirect that mints a fresh Stripe portal session on click. */
  updateUrl: string;
  unsubscribeUrl: string;
}

/** Used by the react-email preview server and the preview script. */
export const SAMPLE_EXPIRY_PROPS: ExpiryEmailProps = {
  customerName: "Jamie",
  companyName: "Acme Analytics",
  planName: "Growth",
  cardBrand: "Visa",
  cardLast4: "4242",
  cardExpiry: "June 2026",
  brandColor: DEFAULT_BRAND_COLOR,
  logoUrl: null,
  updateUrl: "http://localhost:4000/r/expiry/portal/sample-token",
  unsubscribeUrl: "http://localhost:4000/r/expiry/unsubscribe/sample-token",
};

export function greet(name: string | null) {
  return name ? `Hi ${name},` : "Hi,";
}

export const h1: CSSProperties = {
  fontSize: "20px",
  fontWeight: 700,
  color: INK,
  letterSpacing: "-0.01em",
  margin: "0 0 16px",
};

export const p: CSSProperties = {
  color: INK_SOFT,
  fontSize: "15px",
  lineHeight: "24px",
  margin: "0 0 16px",
};

export const muted: CSSProperties = {
  color: INK_FAINT,
  fontSize: "13px",
  lineHeight: "20px",
  margin: "0",
};

/** Numbers are sacred (DESIGN.md): amounts render in monospace. */
export function Amt({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: FONT_MONO, fontSize: "14px", color: INK }}>{children}</span>;
}

interface LayoutProps {
  preview: string;
  companyName: string;
  brandColor: string | null;
  logoUrl: string | null;
  portalUrl: string;
  unsubscribeUrl: string;
  /** "You're receiving this because…" line; defaults to the failed-payment reason. */
  footerReason?: string;
  children: ReactNode;
}

/**
 * Shared shell: brand header + content + the NON-REMOVABLE footer
 * (receiving-reason line, unsubscribe + "manage or cancel" portal link —
 * product plan §5.4, deliverability/dispute protection). Templates must
 * never bypass this.
 */
export function DunningLayout({
  preview,
  companyName,
  brandColor,
  logoUrl,
  portalUrl,
  unsubscribeUrl,
  footerReason,
  children,
}: LayoutProps) {
  const accent = brandColor ?? DEFAULT_BRAND_COLOR;
  const reason =
    footerReason ?? `You're receiving this because your payment to ${companyName} didn't go through.`;
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: PAPER, fontFamily: FONT_SANS, margin: 0 }}>
        <Container
          style={{
            backgroundColor: "#ffffff",
            border: `1px solid ${LINE}`,
            borderRadius: "12px",
            margin: "40px auto",
            padding: "40px",
            maxWidth: "520px",
          }}
        >
          {logoUrl ? (
            <Img src={logoUrl} alt={companyName} height="36" style={{ marginBottom: "28px" }} />
          ) : (
            <Text
              style={{
                color: accent,
                fontSize: "16px",
                fontWeight: 700,
                letterSpacing: "0.01em",
                margin: "0 0 28px",
              }}
            >
              {companyName}
            </Text>
          )}
          {children}
          <Hr style={{ borderColor: LINE, margin: "32px 0 20px" }} />
          <Text style={{ ...muted, margin: "0 0 10px" }}>{reason}</Text>
          <Text style={{ ...muted, margin: "0 0 10px" }}>
            <Link href={unsubscribeUrl} style={{ color: INK_MUTE, textDecoration: "underline" }}>
              Unsubscribe
            </Link>
            {"   ·   "}
            <Link href={portalUrl} style={{ color: INK_MUTE, textDecoration: "underline" }}>
              Manage or cancel your subscription
            </Link>
          </Text>
          <Text style={muted}>
            Sent by{" "}
            <Link href="https://dunly.com" style={{ color: INK_FAINT, textDecoration: "underline" }}>
              Dunly
            </Link>{" "}
            on behalf of {companyName}.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export function CtaButton({
  href,
  brandColor,
  children,
}: {
  href: string;
  brandColor: string | null;
  children: ReactNode;
}) {
  return (
    <Section style={{ textAlign: "center" as const, margin: "32px 0" }}>
      <Button
        href={href}
        style={{
          backgroundColor: brandColor ?? DEFAULT_BRAND_COLOR,
          borderRadius: "8px",
          color: "#ffffff",
          fontSize: "15px",
          fontWeight: 600,
          padding: "12px 24px",
        }}
      >
        {children}
      </Button>
    </Section>
  );
}
