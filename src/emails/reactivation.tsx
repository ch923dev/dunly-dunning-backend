import { Heading, Text } from "@react-email/components";
import {
  CtaButton,
  DunningLayout,
  greet,
  h1,
  muted,
  p,
  SAMPLE_PROPS,
  type DunningEmailProps,
} from "./components/layout.js";

/**
 * Stage 5 — one-shot reactivation, sent ONLY on involuntary cancellation
 * (phase-1 spec, locked decision #1). Never sent to voluntary cancels, never
 * a drip. CTA is the portal (the old invoice may be void/uncollectible after
 * cancellation, so hostedInvoiceUrl is not a reliable reactivation path).
 */
export default function Reactivation(props: DunningEmailProps) {
  const plan = props.planName ? `${props.planName} subscription` : "subscription";
  return (
    <DunningLayout
      preview="Your subscription ended over a payment issue — you can pick up right where you left off."
      companyName={props.companyName}
      brandColor={props.brandColor}
      logoUrl={props.logoUrl}
      portalUrl={props.portalUrl}
      unsubscribeUrl={props.unsubscribeUrl}
      footerReason={`You're receiving this because your subscription to ${props.companyName} ended over a payment issue.`}
    >
      <Heading style={h1}>Your subscription has ended</Heading>
      <Text style={p}>{greet(props.customerName)}</Text>
      <Text style={p}>
        Your {plan} to {props.companyName} was canceled because we couldn&rsquo;t process your
        payment. Cards expire and banks hiccup — it happens.
      </Text>
      <Text style={p}>
        The good news: you can pick up right where you left off. Update your payment method
        and reactivate in about a minute.
      </Text>
      <CtaButton href={props.portalUrl} brandColor={props.brandColor}>
        Restart my subscription
      </CtaButton>
      <Text style={muted}>If you intended to cancel, no action is needed.</Text>
    </DunningLayout>
  );
}

Reactivation.PreviewProps = SAMPLE_PROPS;
