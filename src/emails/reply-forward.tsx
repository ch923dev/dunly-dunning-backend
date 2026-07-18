import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

/**
 * Reply-forward — the stop-on-reply notification (phase-5, locked decision
 * #7). MERCHANT-facing, not customer-facing: design tokens apply, but the
 * locked unsubscribe footer does not (operational mail about their own
 * product). The forwarded reply IS the notification; Resume / Stop are
 * one-tap HMAC links, no login.
 */
export interface ReplyForwardProps {
  customerName: string | null;
  customerEmail: string | null;
  companyName: string;
  /** Pre-formatted, e.g. "$29.00". */
  amountFormatted: string;
  /** e.g. "Email 2" | "Reactivation email" | null when nothing sent yet. */
  stageLabel: string | null;
  /** True when THIS reply flipped the case to PAUSED. */
  pausedCase: boolean;
  /** Case status to report when pausedCase is false, e.g. "RECOVERED". */
  caseStatus: string;
  replySubject: string | null;
  replyText: string | null;
  resumeUrl: string;
  stopUrl: string;
  /** Case detail in the Dunly app. */
  caseUrl: string;
}

// DESIGN.md ink/paper/line tokens (email-safe subset) — same constants as
// the locked dunning layout.
const BRAND = "#13714c";
const INK = "#1a1a1a";
const INK_SOFT = "#3f3f46";
const INK_MUTE = "#71717a";
const PAPER = "#fbfbfa";
const LINE = "#e8e8e6";
const ROSE = "#9f1239";
const FONT_SANS = "Helvetica, Arial, sans-serif";
const FONT_MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Courier New', monospace";

export const SAMPLE_REPLY_FORWARD_PROPS: ReplyForwardProps = {
  customerName: "Jamie",
  customerEmail: "jamie@acme.com",
  companyName: "Acme Analytics",
  amountFormatted: "$29.00",
  stageLabel: "Email 2",
  pausedCase: true,
  caseStatus: "PAUSED",
  replySubject: "Re: Your payment didn't go through",
  replyText: "Hey — I want a refund, please stop charging me.\n\nJamie",
  resumeUrl: "http://localhost:4000/r/case/resume/sample-token",
  stopUrl: "http://localhost:4000/r/case/stop/sample-token",
  caseUrl: "http://localhost:5173/app/cases/sample",
};

export default function ReplyForward(props: ReplyForwardProps) {
  const who = props.customerName ?? props.customerEmail ?? "A customer";
  const context = props.stageLabel ? ` to ${props.stageLabel.toLowerCase()}` : "";
  const headline = props.pausedCase
    ? `${who} replied${context} — sequence paused`
    : `${who} replied${context} — case is ${props.caseStatus.toLowerCase().replaceAll("_", " ")}`;

  return (
    <Html lang="en">
      <Head />
      <Preview>{headline}</Preview>
      <Body style={{ margin: 0, backgroundColor: PAPER, fontFamily: FONT_SANS, color: INK }}>
        <Container style={{ maxWidth: "560px", margin: "0 auto", padding: "32px 16px" }}>
          <Text style={{ color: BRAND, fontWeight: 700, fontSize: "15px", margin: "0 0 16px" }}>
            Dunly
          </Text>
          <Section
            style={{
              backgroundColor: "#ffffff",
              border: `1px solid ${LINE}`,
              borderRadius: "12px",
              padding: "32px",
            }}
          >
            <Text style={{ fontSize: "18px", fontWeight: 700, margin: "0 0 8px", color: INK }}>
              {headline}
            </Text>
            <Text style={{ fontSize: "14px", color: INK_SOFT, lineHeight: "1.6", margin: "0 0 4px" }}>
              {props.pausedCase
                ? "Recovery emails for this case are on hold until you decide. Reply to this email to answer them directly."
                : "No emails were pending for this case. Reply to this email to answer them directly."}
            </Text>
            <Text
              style={{
                fontFamily: FONT_MONO,
                fontSize: "13px",
                color: INK_MUTE,
                margin: "0 0 20px",
              }}
            >
              {props.customerEmail ?? "no email on file"} · {props.amountFormatted} outstanding
            </Text>

            <Section
              style={{
                backgroundColor: PAPER,
                border: `1px solid ${LINE}`,
                borderRadius: "8px",
                padding: "16px 20px",
              }}
            >
              {props.replySubject ? (
                <Text style={{ fontSize: "13px", fontWeight: 700, color: INK_SOFT, margin: "0 0 8px" }}>
                  {props.replySubject}
                </Text>
              ) : null}
              <Text
                style={{
                  fontSize: "14px",
                  color: INK,
                  lineHeight: "1.6",
                  margin: 0,
                  whiteSpace: "pre-wrap",
                }}
              >
                {props.replyText ?? "(no text content)"}
              </Text>
            </Section>

            <Section style={{ marginTop: "24px" }}>
              <Button
                href={props.resumeUrl}
                style={{
                  backgroundColor: BRAND,
                  color: "#ffffff",
                  fontWeight: 700,
                  fontSize: "14px",
                  padding: "11px 22px",
                  borderRadius: "8px",
                }}
              >
                Resume sequence
              </Button>
              <Button
                href={props.stopUrl}
                style={{
                  backgroundColor: "#ffffff",
                  color: ROSE,
                  fontWeight: 700,
                  fontSize: "14px",
                  padding: "10px 22px",
                  borderRadius: "8px",
                  border: `1px solid ${LINE}`,
                  marginLeft: "10px",
                }}
              >
                Stop &amp; mark lost
              </Button>
            </Section>

            <Hr style={{ borderColor: LINE, margin: "24px 0 16px" }} />
            <Text style={{ fontSize: "12px", color: INK_MUTE, margin: 0 }}>
              One-tap links act immediately, no login. You can also{" "}
              <Link href={props.caseUrl} style={{ color: BRAND }}>
                open the case in Dunly
              </Link>{" "}
              for the full timeline.
            </Text>
          </Section>
          <Text style={{ fontSize: "12px", color: INK_MUTE, margin: "16px 0 0" }}>
            Sent by Dunly for {props.companyName} — stop-on-reply is on for this workspace.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
