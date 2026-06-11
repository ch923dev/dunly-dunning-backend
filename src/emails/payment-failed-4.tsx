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

/** Stage 4 — Day 12. Final notice before cancellation per Stripe settings. */
export default function PaymentFailed4(props: DunningEmailProps) {
  return (
    <DunningLayout
      preview="Last reminder — complete payment now to keep your subscription."
      companyName={props.companyName}
      brandColor={props.brandColor}
      logoUrl={props.logoUrl}
      portalUrl={props.portalUrl}
      unsubscribeUrl={props.unsubscribeUrl}
    >
      <Heading style={h1}>Final notice: your subscription will be canceled</Heading>
      <Text style={p}>{greet(props.customerName)}</Text>
      <Text style={p}>
        This is our last reminder. The <Amt>{props.amountFormatted}</Amt> payment for your{" "}
        {props.companyName} subscription remains unpaid, and the subscription will be
        canceled shortly.
      </Text>
      <Text style={p}>You can still keep your access by completing the payment now:</Text>
      <CtaButton href={props.payUrl} brandColor={props.brandColor}>
        Complete payment
      </CtaButton>
      <Text style={muted}>
        If you meant to cancel, no action is needed — and we&rsquo;re sorry to see you go.
      </Text>
    </DunningLayout>
  );
}

PaymentFailed4.PreviewProps = SAMPLE_PROPS;
