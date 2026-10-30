// Web Push (RFC 8030), for the app in a browser: an installed web app, or
// Chrome on Android, or Safari from iOS 16.4. A wake is a push with no
// payload -- so nothing to encrypt (RFC 8291) -- authorised by the relay's
// VAPID key (RFC 8292). The service worker shows the notification.
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { jwt, type Fetch, type Outcome, type Sender } from "./channel.ts";

/// How long a push service keeps a wake for a device that's offline: past
/// this, the moment it was about has gone.
const TTL_SECS = 60 * 60;
const VAPID_LIFETIME_SECS = 12 * 60 * 60;

export interface Vapid {
  /// The private key, PKCS#8 PEM (P-256).
  privateKey: string;
  /// Who to contact about this relay's pushes: a `mailto:` or `https:` URL.
  subject: string;
}

/// The VAPID public key a browser subscribes with: the raw uncompressed
/// P-256 point, base64url.
export function vapidPublicKey(privateKey: string): string {
  const jwk = createPublicKey(createPrivateKey(privateKey)).export({ format: "jwk" });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
}

export function webPushSender(vapid: Vapid, fetch: Fetch): Sender {
  const key: KeyObject = createPrivateKey(vapid.privateKey);
  const publicKey = vapidPublicKey(vapid.privateKey);
  return {
    async send(address: string): Promise<Outcome> {
      let endpoint: URL;
      try {
        endpoint = new URL((JSON.parse(address) as { endpoint: string }).endpoint);
      } catch {
        return "gone";
      }
      const token = jwt("ES256", {}, { aud: endpoint.origin, exp: Math.floor(Date.now() / 1000) + VAPID_LIFETIME_SECS, sub: vapid.subject }, key);
      const response = await fetch(endpoint.href, {
        method: "POST",
        headers: { Authorization: `vapid t=${token}, k=${publicKey}`, TTL: String(TTL_SECS), Urgency: "high", "Content-Length": "0" },
      });
      // 404 and 410: the subscription is gone (unsubscribed, expired).
      if (response.status === 404 || response.status === 410) return "gone";
      return response.status >= 200 && response.status < 300 ? "sent" : "failed";
    },
  };
}
