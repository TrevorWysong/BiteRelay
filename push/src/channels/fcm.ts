// Firebase Cloud Messaging (HTTP v1), for the Android app. A wake is a
// data-only, high-priority message -- `{"wake": "1"}` and nothing else --
// which wakes the app to build a local notification itself. Authorised by
// a service account: a signed JWT traded for an access token, kept until
// shortly before it expires.
import { jwt, type Fetch, type Outcome, type Sender } from "./channel.ts";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  /// PEM (RSA).
  private_key: string;
}

export function fcmSender(account: ServiceAccount, fetch: Fetch): Sender {
  let access: { token: string; until: number } | null = null;

  async function accessToken(): Promise<string> {
    if (access && Date.now() < access.until) return access.token;
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt("RS256", {}, { iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }, account.private_key);
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    if (response.status !== 200) throw new Error(`FCM sign-in failed (${response.status})`);
    const { access_token, expires_in } = JSON.parse(await response.text()) as { access_token: string; expires_in: number };
    // A minute's margin, so a token never expires mid-request.
    access = { token: access_token, until: Date.now() + (expires_in - 60) * 1000 };
    return access_token;
  }

  return {
    async send(registrationToken: string): Promise<Outcome> {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { token: registrationToken, data: { wake: "1" }, android: { priority: "HIGH", ttl: "3600s" } } }),
      });
      if (response.status === 200) return "sent";
      // UNREGISTERED (404), or a token FCM never issued (400 INVALID_ARGUMENT).
      if (response.status === 404) return "gone";
      if (response.status === 400 && /registration token|INVALID_ARGUMENT/i.test(await response.text())) return "gone";
      return "failed";
    },
  };
}
