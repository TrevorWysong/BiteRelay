// The service's settings, from the environment (see .env.example). Read
// once at start; a missing secret stops it there rather than mid-payment.
import { parseTiers, type RiskPolicy } from "./risk.ts";

export interface Config {
  stripeSecretKey: string;
  stripePublishableKey: string;
  stripeWebhookSecret: string;
  publicUrl: string;
  port: number;
  /// The origins the app runs at, allowed to call this from inside it: a
  /// browser dev server, or the Relay app's own (Kangaroo, Tauri).
  appOrigins: string[];
  conductorAdminUrl: string;
  issuerAppId: string;
  /// The issuer's app on the previous version of the network, while people
  /// are still moving from it (MIGRATION.md) -- unset otherwise.
  previousIssuerAppId: string | null;
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
  /// How long a recovered account's old key must be quiet before its
  /// balance is reissued to the new one.
  recoveryWaitMs: number;
  /// A recovered balance above this is left for a person to approve.
  recoveryReviewAboveCents: number;
  risk: RiskPolicy;
  /// Card forms one address may open an hour -- against card testing.
  topUpsPerIpPerHour: number;
  noncesPerIpPerHour: number;
  /// Whether the service is behind a proxy that sets X-Forwarded-For.
  trustProxy: boolean;
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
    // APP_URL, its older name, still works.
    appOrigins: (process.env.APP_ORIGINS || process.env.APP_URL || required("APP_ORIGINS"))
      .split(",")
      .map((origin) => (origin.trim() ? new URL(origin.trim()).origin : ""))
      .filter(Boolean),
    conductorAdminUrl: process.env.CONDUCTOR_ADMIN_URL ?? "ws://localhost:8870",
    issuerAppId: process.env.ISSUER_APP_ID ?? "dev-issuer",
    previousIssuerAppId: process.env.PREVIOUS_ISSUER_APP_ID || null,
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
    recoveryWaitMs: number("RECOVERY_WAIT_DAYS", 7) * 24 * 60 * 60 * 1000,
    recoveryReviewAboveCents: number("RECOVERY_REVIEW_ABOVE_CENTS", 50_000),
    risk: { tiers: parseTiers(process.env.TOPUP_TIERS), payoutHoldMs: number("PAYOUT_HOLD_DAYS", 7) * 24 * 60 * 60 * 1000 },
    topUpsPerIpPerHour: number("TOPUPS_PER_IP_PER_HOUR", 20),
    noncesPerIpPerHour: number("NONCES_PER_IP_PER_HOUR", 120),
    trustProxy: process.env.TRUST_PROXY === "1",
  };
}
