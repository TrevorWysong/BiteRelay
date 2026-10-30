// Apple Push Notification service, for the iPhone app. A wake is an alert
// whose words are keys into the app's own strings (`loc-key`), so it shows
// in the person's language and says nothing the relay knows; the app's
// notification extension may replace it with what actually changed
// (`mutable-content`). Authorised by the relay's token key (a .p8), whose
// JWT Apple accepts for up to an hour.
import { connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, type KeyObject } from "node:crypto";
import { jwt, type Outcome, type Sender } from "./channel.ts";

const TOKEN_LIFETIME_MS = 50 * 60_000;
const EXPIRY_SECS = 60 * 60;

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /// The .p8 token key, PEM.
  privateKey: string;
  /// The app's bundle id -- the push topic.
  bundleId: string;
  /// Apple's development environment, for builds signed for development.
  sandbox: boolean;
}

/// One request to Apple, injectable so tests needn't reach it.
export type ApnsRequest = (path: string, headers: Record<string, string>, body: string) => Promise<{ status: number; reason?: string }>;

export const WAKE_PAYLOAD = JSON.stringify({
  aps: { alert: { "title-loc-key": "WAKE_TITLE", "loc-key": "WAKE_BODY" }, sound: "default", "mutable-content": 1, "content-available": 1 },
});

export function apnsSender(config: ApnsConfig, request: ApnsRequest = http2Request(config.sandbox)): Sender {
  const key: KeyObject = createPrivateKey(config.privateKey);
  let token: { value: string; madeAt: number } | null = null;
  const bearer = () => {
    if (!token || Date.now() - token.madeAt > TOKEN_LIFETIME_MS) {
      token = { value: jwt("ES256", { kid: config.keyId }, { iss: config.teamId, iat: Math.floor(Date.now() / 1000) }, key), madeAt: Date.now() };
    }
    return token.value;
  };
  return {
    async send(deviceToken: string): Promise<Outcome> {
      if (!/^[0-9a-f]{32,200}$/i.test(deviceToken)) return "gone";
      const { status, reason } = await request(
        `/3/device/${deviceToken}`,
        {
          authorization: `bearer ${bearer()}`,
          "apns-topic": config.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(Date.now() / 1000) + EXPIRY_SECS),
        },
        WAKE_PAYLOAD,
      );
      if (status === 200) return "sent";
      // 410: the token is no longer active; 400 BadDeviceToken: never was.
      if (status === 410 || (status === 400 && reason === "BadDeviceToken")) return "gone";
      return "failed";
    },
  };
}

/// Requests over one HTTP/2 connection to Apple, opened as needed.
function http2Request(sandbox: boolean): ApnsRequest {
  const origin = sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  let session: ClientHttp2Session | null = null;
  return (path, headers, body) =>
    new Promise((resolve, reject) => {
      if (!session || session.closed || session.destroyed) {
        session = connect(origin);
        session.on("error", () => (session = null));
      }
      const stream = session.request({ ":method": "POST", ":path": path, ...headers });
      let status = 0;
      let text = "";
      stream.on("response", (head) => (status = Number(head[":status"])));
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => (text += chunk));
      stream.on("end", () => {
        let reason: string | undefined;
        try {
          reason = text ? (JSON.parse(text) as { reason?: string }).reason : undefined;
        } catch {
          // No reason given.
        }
        resolve({ status, reason });
      });
      stream.on("error", reject);
      stream.end(body);
    });
}
