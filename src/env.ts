import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.url().default("http://localhost:5173"),
  API_URL: z.url().default("http://localhost:4000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  BETTER_AUTH_SECRET: z.string().min(16, "BETTER_AUTH_SECRET must be at least 16 chars"),
  BETTER_AUTH_URL: z.url().default("http://localhost:4000"),

  // sk_ or rk_ — Stripe recommends restricted keys (least privilege).
  STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_/, "must be a Stripe secret or restricted key"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  STRIPE_CLIENT_ID: z.string().startsWith("ca_"),
  CONNECT_REDIRECT_URL: z.url().default("http://localhost:4000/api/stripe/callback"),

  RESEND_API_KEY: z.string().startsWith("re_"),
  EMAIL_FROM: z.string().min(1),
  /** Svix signing secret for POST /webhooks/resend (optional until configured). */
  RESEND_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
