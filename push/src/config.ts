// The relay's settings, from the environment (see .env.example). Each
// channel is on when its credentials are set; a relay needs at least one.
import { readFileSync } from "node:fs";
import type { ApnsConfig } from "./channels/apns.ts";
import type { ServiceAccount } from "./channels/fcm.ts";
import type { Vapid } from "./channels/webpush.ts";

export interface Config {
  port: number;
  dbPath: string;
  tokenKey: Buffer;
  tokenTtlMs: number;
  webPush: Vapid | null;
  apns: ApnsConfig | null;
  fcm: ServiceAccount | null;
  wakesPerMinute: number;
  wakesPerDay: number;
  requestsPerIpPerHour: number;
  appOrigins: string[];
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

/// A PEM from the environment: inline (with `\n` for newlines), or `@path`.
function pem(name: string): string | null {
  const value = process.env[name];
  if (!value) return null;
  return value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value.replace(/\\n/g, "\n");
}

export function loadConfig(): Config {
  const tokenKey = Buffer.from(required("TOKEN_KEY"), "base64");
  if (tokenKey.length !== 32) throw new Error("TOKEN_KEY must be 32 bytes, base64 -- `npm run keys` makes one");
  const vapidKey = pem("VAPID_PRIVATE_KEY");
  const apnsKey = pem("APNS_PRIVATE_KEY");
  const fcmAccount = process.env.FCM_SERVICE_ACCOUNT;
  const config: Config = {
    port: number("PORT", 8892),
    dbPath: process.env.DB_PATH ?? "./push.db",
    tokenKey,
    tokenTtlMs: number("TOKEN_TTL_DAYS", 30) * 24 * 60 * 60 * 1000,
    webPush: vapidKey ? { privateKey: vapidKey, subject: required("VAPID_SUBJECT") } : null,
    apns: apnsKey ? { privateKey: apnsKey, teamId: required("APNS_TEAM_ID"), keyId: required("APNS_KEY_ID"), bundleId: required("APNS_BUNDLE_ID"), sandbox: process.env.APNS_SANDBOX === "1" } : null,
    fcm: fcmAccount ? (JSON.parse(fcmAccount.startsWith("@") ? readFileSync(fcmAccount.slice(1), "utf8") : fcmAccount) as ServiceAccount) : null,
    wakesPerMinute: number("WAKES_PER_MINUTE", 4),
    wakesPerDay: number("WAKES_PER_DAY", 150),
    requestsPerIpPerHour: number("REQUESTS_PER_IP_PER_HOUR", 60),
    appOrigins: required("APP_ORIGINS")
      .split(",")
      .map((origin) => (origin.trim() ? new URL(origin.trim()).origin : ""))
      .filter(Boolean),
    trustProxy: process.env.TRUST_PROXY === "1",
  };
  if (!config.webPush && !config.apns && !config.fcm) throw new Error("No channel is set up: set VAPID_PRIVATE_KEY, APNS_PRIVATE_KEY or FCM_SERVICE_ACCOUNT");
  return config;
}
