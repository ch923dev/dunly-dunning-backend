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

/** Stage 1 — Day 0. Friendly heads-up: no blame, no urgency. */
export default function PaymentFailed1(props: DunningEmailProps) {
  const plan = props.planName ? `your ${props.planName} subscription` : "your subscription";
  return (
    <DunningLayout
      preview="It takes under a minute to fix — your service isn't interrupted."
      companyName={props.companyName}
      brandColor={props.brandColor}
      logoUrl={props.logoUrl}
      portalUrl={props.portalUrl}
      unsubscribeUrl={props.unsubscribeUrl}
    >
      <Heading style={h1}>Your payment didn&rsquo;t go through</Heading>
      <Text style={p}>{greet(props.customerName)}</Text>
      <Text style={p}>
        We tried to charge <Amt>{props.amountFormatted}</Amt> for {plan} to {props.companyName}, but the
        payment didn&rsquo;t go through. This is usually an expired card or a temporary bank
        issue — nothing to worry about.
      </Text>
      <Text style={p}>
        Your service is still active, and we&rsquo;ll retry the payment automatically. To sort
        it out right away, you can pay the invoice or update your card below.
      </Text>
      <CtaButton href={props.payUrl} brandColor={props.brandColor}>
        Pay invoice or update card
      </CtaButton>
      <Text style={muted}>If you&rsquo;ve already fixed this, you can safely ignore this email.</Text>
    </DunningLayout>
  );
}

PaymentFailed1.PreviewProps = SAMPLE_PROPS;
