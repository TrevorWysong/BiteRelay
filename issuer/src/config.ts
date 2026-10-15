// The service's settings, from the environment (see .env.example). Read
// once at start; a missing secret stops it there rather than mid-payment.
export interface Config {
  stripeSecretKey: string;
  stripePublishableKey: string;
  stripeWebhookSecret: string;
  publicUrl: string;
  port: number;
  appUrl: string;
  conductorAdminUrl: string;
  issuerAppId: string;
  profile: {
    name: string;
    contact: string;
    payoutFeeCents: number;
    payoutFeeBasisPoints: number;
    minPayoutCents: number;
    payoutDays: number;
  };
  dbPath: string;
  sweepSeconds: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} isn't set -- see .env.example`);
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number, not "${raw}"`);
  return value;
}

export function loadConfig(): Config {
  const stripeSecretKey = required("STRIPE_SECRET_KEY");
  if (stripeSecretKey.startsWith("sk_live_") && process.env.ALLOW_LIVE_STRIPE !== "1") {
    throw new Error("STRIPE_SECRET_KEY is a live key. Use a test key, or set ALLOW_LIVE_STRIPE=1 once this issuer is cleared to handle real money.");
  }
  return {
    stripeSecretKey,
    stripePublishableKey: required("STRIPE_PUBLISHABLE_KEY"),
    stripeWebhookSecret: required("STRIPE_WEBHOOK_SECRET"),
    publicUrl: required("PUBLIC_URL").replace(/\/$/, ""),
    port: number("PORT", 8890),
    appUrl: required("APP_URL").replace(/\/$/, ""),
    conductorAdminUrl: process.env.CONDUCTOR_ADMIN_URL ?? "ws://localhost:8870",
    issuerAppId: process.env.ISSUER_APP_ID ?? "dev-issuer",
    profile: {
      name: process.env.ISSUER_NAME ?? "Relay Credits",
      contact: process.env.ISSUER_CONTACT ?? "",
      payoutFeeCents: number("PAYOUT_FEE_CENTS", 55),
      payoutFeeBasisPoints: number("PAYOUT_FEE_BASIS_POINTS", 325),
      minPayoutCents: number("MIN_PAYOUT_CENTS", 1000),
      payoutDays: number("PAYOUT_DAYS", 2),
    },
    dbPath: process.env.DB_PATH ?? "./issuer.db",
    sweepSeconds: number("SWEEP_SECONDS", 30),
  };
}
