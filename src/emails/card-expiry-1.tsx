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
 * Pre-dunning touch 1 — ~21 days before the card's expiry month ends.
 * Friendly heads-up. Framing rule (product plan §5.3, locked): service
 * continuity ("keep your access running"), never "you will be billed".
 */
export default function CardExpiry1(props: ExpiryEmailProps) {
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
      preview="A one-minute update keeps your access running without interruption."
      companyName={props.companyName}
      brandColor={props.brandColor}
      logoUrl={props.logoUrl}
      portalUrl={props.updateUrl}
      unsubscribeUrl={props.unsubscribeUrl}
      footerReason={`You're receiving this because the card on file for your ${props.companyName} subscription expires soon.`}
    >
      <Heading style={h1}>Your card expires soon</Heading>
      <Text style={p}>{greet(props.customerName)}</Text>
      <Text style={p}>
        The {card} that {props.companyName} has on file expires in{" "}
        <Amt>{props.cardExpiry}</Amt>. Updating it now takes under a minute and keeps {plan}{" "}
        running without any interruption.
      </Text>
      <CtaButton href={props.updateUrl} brandColor={props.brandColor}>
        Update your card
      </CtaButton>
      <Text style={muted}>
        If you&rsquo;ve already updated your card, you can safely ignore this email.
      </Text>
    </DunningLayout>
  );
}

CardExpiry1.PreviewProps = SAMPLE_EXPIRY_PROPS;
