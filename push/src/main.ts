// The push relay: wakes a closed Relay app when something changes on one
// of its orders, without learning who asked or about what (MOBILE.md,
// "Waking a closed app"). Configured from the environment (.env.example).
import { apnsSender } from "./channels/apns.ts";
import type { Fetch, Sender } from "./channels/channel.ts";
import { fcmSender } from "./channels/fcm.ts";
import { vapidPublicKey, webPushSender } from "./channels/webpush.ts";
import { loadConfig } from "./config.ts";
import { serve } from "./server.ts";
import { Store, type Channel } from "./store.ts";

const config = loadConfig();
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const fetcher: Fetch = (url, init) => fetch(url, init);

const senders: Partial<Record<Channel, Sender>> = {};
if (config.webPush) senders.webpush = webPushSender(config.webPush, fetcher);
if (config.apns) senders.apns = apnsSender(config.apns);
if (config.fcm) senders.fcm = fcmSender(config.fcm, fetcher);

serve(
  {
    store: new Store(config.dbPath),
    tokenKey: config.tokenKey,
    senders,
    vapidPublicKey: config.webPush ? vapidPublicKey(config.webPush.privateKey) : null,
    tokenTtlMs: config.tokenTtlMs,
    wakesPerMinute: config.wakesPerMinute,
    wakesPerDay: config.wakesPerDay,
    requestsPerIpPerHour: config.requestsPerIpPerHour,
    appOrigins: config.appOrigins,
    trustProxy: config.trustProxy,
    log,
  },
  config.port,
);
log(`waking over ${Object.keys(senders).join(", ")}; listening on :${config.port}`);
