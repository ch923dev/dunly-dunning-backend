import { Heading, Text } from "@react-email/components";
import {
  Amt,
  CtaButton,
  DunningLayout,
  greet,
  h1,
  muted,
  p,
  SAMPLE_PROPS,
  type DunningEmailProps,
} from "./components/layout.js";

/** Stage 3 — Day 7. Urgency: name the interruption risk plainly. */
export default function PaymentFailed3(props: DunningEmailProps) {
  const plan = props.planName ? `your ${props.planName} subscription` : "your subscription";
  return (
    <DunningLayout
      preview="Your access may be interrupted soon — please update your payment details."
      companyName={props.companyName}
      brandColor={props.brandColor}
      logoUrl={props.logoUrl}
      portalUrl={props.portalUrl}
      unsubscribeUrl={props.unsubscribeUrl}
    >
      <Heading style={h1}>Action needed to keep your service running</Heading>
      <Text style={p}>{greet(props.customerName)}</Text>
      <Text style={p}>
        We still haven&rsquo;t been able to collect the <Amt>{props.amountFormatted}</Amt> payment for{" "}
        {plan} to {props.companyName}. If it stays unpaid, your access may be interrupted
        soon.
      </Text>
      <Text style={p}>
        It only takes a minute to pay the invoice or switch to a different card:
      </Text>
      <CtaButton href={props.payUrl} brandColor={props.brandColor}>
        Fix payment now
      </CtaButton>
      <Text style={muted}>
        Having trouble, or think this is a mistake? Just reply to this email.
      </Text>
    </DunningLayout>
  );
}

PaymentFailed3.PreviewProps = SAMPLE_PROPS;
