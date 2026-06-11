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

/** Stage 2 — Day 3. Short nudge; restate the link, nothing more. */
export default function PaymentFailed2(props: DunningEmailProps) {
  return (
    <DunningLayout
      preview={`The ${props.amountFormatted} payment for your subscription is still outstanding.`}
      companyName={props.companyName}
      brandColor={props.brandColor}
      logoUrl={props.logoUrl}
      portalUrl={props.portalUrl}
      unsubscribeUrl={props.unsubscribeUrl}
    >
      <Heading style={h1}>Quick reminder about your payment</Heading>
      <Text style={p}>{greet(props.customerName)}</Text>
      <Text style={p}>
        Just a quick nudge — the <Amt>{props.amountFormatted}</Amt> payment for your {props.companyName}{" "}
        subscription is still outstanding. Fixing it usually takes less than a minute.
      </Text>
      <CtaButton href={props.payUrl} brandColor={props.brandColor}>
        Update payment details
      </CtaButton>
      <Text style={muted}>
        Already taken care of it? Things can take a little while to sync up — feel free to
        ignore this email.
      </Text>
    </DunningLayout>
  );
}

PaymentFailed2.PreviewProps = SAMPLE_PROPS;
