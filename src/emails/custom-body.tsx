import {
  CtaButton,
  DunningLayout,
  SAMPLE_PROPS,
  type DunningEmailProps,
} from "./components/layout.js";

export interface CustomBodyProps extends DunningEmailProps {
  /** Sanitized (sanitizeEmailBody) + merge-var-substituted HTML. */
  bodyHtml: string;
}

/**
 * Renders a user-edited body inside the locked layout: same header, CTA
 * button, and non-removable footer as the built-in templates — only the
 * prose between them is the user's.
 *
 * The injected HTML is styled via inline rules on a wrapper (email clients
 * ignore <style> blocks); tag-level spacing is normalized by the sanitizer's
 * tight allowlist plus the styles below.
 */
export default function CustomBody(props: CustomBodyProps) {
  return (
    <DunningLayout
      preview={`About your payment to ${props.companyName}`}
      companyName={props.companyName}
      brandColor={props.brandColor}
      logoUrl={props.logoUrl}
      portalUrl={props.portalUrl}
      unsubscribeUrl={props.unsubscribeUrl}
    >
      <div
        style={{
          fontSize: "15px",
          lineHeight: "1.65",
          color: "#3f3f46",
        }}
        dangerouslySetInnerHTML={{ __html: props.bodyHtml }}
      />
      <CtaButton href={props.payUrl} brandColor={props.brandColor}>
        Pay invoice or update card
      </CtaButton>
    </DunningLayout>
  );
}

CustomBody.PreviewProps = {
  ...SAMPLE_PROPS,
  bodyHtml:
    "<p>Hi Alex,</p><p>This is what a <strong>custom-edited</strong> stage body looks like inside the locked layout.</p>",
} satisfies CustomBodyProps;
