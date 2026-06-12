import { Heading, Text } from "@react-email/components";
import {
  Amt,
  CtaButton,
  DunningLayout,
  greet,
  h1,
  muted,
  p,
  SAMPLE_EXPIRY_PROPS,
  type ExpiryEmailProps,
} from "./components/layout.js";

/**
 * Pre-dunning touch 2 — ~7 days before the card's expiry month ends.
 * Last call: more urgency, still service-continuity framing (never
 * "you will be billed") — the risk named is interruption, not a charge.
 */
export default function CardExpiry2(props: ExpiryEmailProps) {
  const plan = props.planName ? `your ${props.planName} subscription` : "your subscription";
  const card = props.cardLast4 ? (
    <>
      {props.cardBrand ?? "card"} ending <Amt>•••• {props.cardLast4}</Amt>
    </>
  ) : (
    "card on file"
  );
  return (
    <DunningLayout
      preview="One minute now avoids any interruption to your access."
      companyName={props.companyName}
      brandColor={props.brandColor}
      logoUrl={props.logoUrl}
      portalUrl={props.updateUrl}
      unsubscribeUrl={props.unsubscribeUrl}
      footerReason={`You're receiving this because the card on file for your ${props.companyName} subscription expires this month.`}
    >
      <Heading style={h1}>Last call — your card expires this month</Heading>
      <Text style={p}>{greet(props.customerName)}</Text>
      <Text style={p}>
        The {card} on file with {props.companyName} expires at the end of{" "}
        <Amt>{props.cardExpiry}</Amt>. Once it does, {plan} can&rsquo;t renew and your access
        may be interrupted.
      </Text>
      <Text style={p}>Updating your card takes under a minute and keeps everything running.</Text>
      <CtaButton href={props.updateUrl} brandColor={props.brandColor}>
        Update your card
      </CtaButton>
      <Text style={muted}>
        If you&rsquo;ve already updated your card, you can safely ignore this email.
      </Text>
    </DunningLayout>
  );
}

CardExpiry2.PreviewProps = SAMPLE_EXPIRY_PROPS;
