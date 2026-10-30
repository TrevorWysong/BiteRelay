// The relay's rules, with every push service faked: a token wakes only the
// device that made it, until it expires; nobody can make or read one; the
// relay answers every wake alike; a device is woken only so often; and a
// device its channel says is gone is forgotten, with all its tokens. Each
// channel sends a content-free wake, authorised as its service expects.
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { apnsSender, WAKE_PAYLOAD } from "../src/channels/apns.ts";
import type { Fetch, Outcome, Sender } from "../src/channels/channel.ts";
import { fcmSender } from "../src/channels/fcm.ts";
import { vapidPublicKey, webPushSender } from "../src/channels/webpush.ts";
import { serve, type Deps } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { mintToken, openToken } from "../src/tokens.ts";

const KEY = randomBytes(32);
const DAY_MS = 24 * 60 * 60 * 1000;

/// A JWT's parts, and whether `publicKey` signed it.
function readJwt(token: string, publicKey: ReturnType<typeof createPublicKey>, alg: "ES256" | "RS256") {
  const [header, claims, signature] = token.split(".");
  const signed = verify("sha256", Buffer.from(`${header}.${claims}`), alg === "ES256" ? { key: publicKey, dsaEncoding: "ieee-p1363" } : publicKey, Buffer.from(signature, "base64url"));
  return { header: JSON.parse(Buffer.from(header, "base64url").toString()), claims: JSON.parse(Buffer.from(claims, "base64url").toString()), signed };
}

test("a token is its device and expiry, readable only with the relay's key", () => {
  const wake = { device: "device-1", expiresAt: Date.now() + DAY_MS };
  const one = mintToken(KEY, wake);
  const two = mintToken(KEY, wake);
  assert.notEqual(one, two, "two tokens for one device look unrelated");
  assert.deepEqual(openToken(KEY, one), wake);
  assert.equal(openToken(randomBytes(32), one), null, "another relay can't read it");
  const tampered = Buffer.from(one, "base64url");
  tampered[14] ^= 1;
  assert.equal(openToken(KEY, tampered.toString("base64url")), null, "nobody can alter one");
  assert.equal(openToken(KEY, "not a token"), null);
});

/// A relay on a free port with a fake sender per channel, recording what
/// each was asked to deliver, and a promise for each wake's outcome.
async function relay(overrides: Partial<Deps> = {}, outcome: Outcome = "sent") {
  const sent: string[] = [];
  const sender: Sender = { send: async (address) => (sent.push(address), outcome) };
  const outcomes: (Outcome | "dropped")[] = [];
  const waiters: (() => void)[] = [];
  const store = new Store(":memory:");
  const server = serve(
    {
      store,
      tokenKey: KEY,
      senders: { webpush: sender, fcm: sender },
      vapidPublicKey: "vapid-public",
      tokenTtlMs: DAY_MS,
      wakesPerMinute: 2,
      wakesPerDay: 3,
      requestsPerIpPerHour: 100,
      appOrigins: ["http://app.test"],
      trustProxy: false,
      onWake: (result) => {
        outcomes.push(result);
        waiters.shift()?.();
      },
      ...overrides,
    },
    0,
  );
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Origin: "http://app.test" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, cors: response.headers.get("access-control-allow-origin") };
  };
  /// Asks for a wake and waits until the relay has dealt with it.
  const wake = async (token: string) => {
    const handled = new Promise<void>((resolve) => waiters.push(resolve));
    const answer = await call("POST", "/wake", { token });
    await handled;
    return answer;
  };
  return { call, wake, sent, outcomes, store, close: () => server.close() };
}

test("a device registers, hands out tokens, and is woken through any of them", async (t) => {
  const r = await relay();
  t.after(r.close);
  assert.deepEqual((await r.call("GET", "/config")).body, { channels: ["webpush", "fcm"], vapidPublicKey: "vapid-public" });
  const registered = await r.call("POST", "/devices", { channel: "webpush", address: "subscription-a" });
  assert.equal(registered.status, 200);
  assert.equal(registered.cors, "http://app.test", "the app may call it from inside itself");
  const tokens = registered.body.tokens as string[];
  assert.equal(tokens.length, 20);
  assert.equal(new Set(tokens).size, 20);

  assert.deepEqual((await r.wake(tokens[0])).body, {});
  assert.deepEqual(r.sent, ["subscription-a"]);
  await r.wake(tokens[7]);
  assert.deepEqual(r.sent, ["subscription-a", "subscription-a"], "any of its tokens wakes it");

  const more = await r.call("POST", "/devices/tokens", { device: registered.body.device, secret: registered.body.secret });
  assert.equal((more.body.tokens as string[]).length, 20, "a fresh batch, for its secret");
  const stranger = await r.call("POST", "/devices/tokens", { device: registered.body.device, secret: "guessed" });
  assert.equal(stranger.status, 404, "but nobody else's");
  assert.equal((await r.call("POST", "/devices", { channel: "apns", address: "x" })).status, 400, "only on a channel the relay delivers on");
});

test("every wake is answered alike, and only a live token from this relay wakes anyone", async (t) => {
  const r = await relay();
  t.after(r.close);
  const { device } = (await r.call("POST", "/devices", { channel: "fcm", address: "fcm-token" })).body as { device: string };
  const expired = mintToken(KEY, { device, expiresAt: Date.now() - 1 });
  const foreign = mintToken(randomBytes(32), { device, expiresAt: Date.now() + DAY_MS });
  const answers = [await r.wake(expired), await r.wake(foreign), await r.wake("garbage")];
  for (const answer of answers) assert.deepEqual(answer, { status: 200, body: {}, cors: "http://app.test" });
  assert.deepEqual(r.sent, [], "nothing was delivered");
  assert.deepEqual(r.outcomes, ["dropped", "dropped", "dropped"]);
});

test("a device is woken a few times a minute at most, and so often a day", async (t) => {
  const r = await relay();
  t.after(r.close);
  const { tokens } = (await r.call("POST", "/devices", { channel: "webpush", address: "s" })).body as { tokens: string[] };
  for (const token of tokens.slice(0, 3)) await r.wake(token);
  assert.deepEqual(r.outcomes, ["sent", "sent", "dropped"], "two a minute");
});

test("a device its channel says is gone is forgotten, with every token it handed out", async (t) => {
  const r = await relay({}, "gone");
  t.after(r.close);
  const registered = (await r.call("POST", "/devices", { channel: "webpush", address: "old" })).body as { device: string; secret: string; tokens: string[] };
  await r.wake(registered.tokens[0]);
  assert.equal(r.store.device(registered.device), null);
  await r.wake(registered.tokens[1]);
  assert.deepEqual(r.outcomes, ["gone", "dropped"]);
  assert.equal((await r.call("POST", "/devices/tokens", { device: registered.device, secret: registered.secret })).status, 404, "it registers again");
});

test("a device can have itself forgotten", async (t) => {
  const r = await relay();
  t.after(r.close);
  const registered = (await r.call("POST", "/devices", { channel: "webpush", address: "s" })).body as { device: string; secret: string; tokens: string[] };
  assert.equal((await r.call("DELETE", "/devices", { device: registered.device, secret: "wrong" })).status, 404);
  assert.equal((await r.call("DELETE", "/devices", { device: registered.device, secret: registered.secret })).status, 200);
  await r.wake(registered.tokens[0]);
  assert.deepEqual(r.sent, []);
});

/// A fake fetch that records requests and answers from `reply`.
function fakeFetch(reply: (url: string) => { status: number; body?: string }) {
  const requests: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({ url, ...init });
    const { status, body = "" } = reply(url);
    return { status, text: async () => body };
  };
  return { fetch, requests };
}

test("Web Push: an empty push, authorised by the relay's VAPID key for the push service it goes to", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const { fetch, requests } = fakeFetch((url) => ({ status: url.includes("gone") ? 410 : 201 }));
  const sender = webPushSender({ privateKey: pem, subject: "mailto:ops@relay.test" }, fetch);
  const subscription = JSON.stringify({ endpoint: "https://push.example.net/send/abc", keys: { p256dh: "x", auth: "y" } });

  assert.equal(await sender.send(subscription), "sent");
  const [request] = requests;
  assert.equal(request.url, "https://push.example.net/send/abc");
  assert.equal(request.body, undefined, "no payload: nothing for the push service to read");
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(request.headers.Authorization)!;
  assert.equal(key, vapidPublicKey(pem));
  const jwt = readJwt(token, publicKey, "ES256");
  assert.ok(jwt.signed);
  assert.equal(jwt.claims.aud, "https://push.example.net");
  assert.equal(jwt.claims.sub, "mailto:ops@relay.test");

  assert.equal(await sender.send(JSON.stringify({ endpoint: "https://push.example.net/gone" })), "gone");
  assert.equal(await sender.send("not json"), "gone");
});

test("APNs: a wake in the app's own words, authorised by the relay's token key", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const requests: { path: string; headers: Record<string, string>; body: string }[] = [];
  const sender = apnsSender(
    { teamId: "TEAM123", keyId: "KEY456", privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), bundleId: "app.relay", sandbox: true },
    async (path, headers, body) => (requests.push({ path, headers, body }), path.includes("dead") ? { status: 410 } : { status: 200 }),
  );
  const deviceToken = "a".repeat(64);
  assert.equal(await sender.send(deviceToken), "sent");
  const [request] = requests;
  assert.equal(request.path, `/3/device/${deviceToken}`);
  assert.equal(request.headers["apns-topic"], "app.relay");
  assert.equal(request.headers["apns-push-type"], "alert");
  assert.equal(request.body, WAKE_PAYLOAD);
  assert.doesNotMatch(request.body, /order|\$/i, "nothing about any order");
  const jwt = readJwt(request.headers.authorization.replace("bearer ", ""), publicKey, "ES256");
  assert.ok(jwt.signed);
  assert.equal(jwt.header.kid, "KEY456");
  assert.equal(jwt.claims.iss, "TEAM123");

  assert.equal(await sender.send("dead".padEnd(64, "0")), "gone", "a device Apple no longer has");
  assert.equal(await sender.send("not-hex"), "gone");
});

test("FCM: a data-only wake, with an access token traded once for the service account's", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { fetch, requests } = fakeFetch((url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return { status: 200, body: JSON.stringify({ access_token: "access-1", expires_in: 3600 }) };
    return { status: 200 };
  });
  const sender = fcmSender({ project_id: "relay-test", client_email: "relay@relay-test.iam", private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString() }, fetch);
  assert.equal(await sender.send("registration-1"), "sent");
  assert.equal(await sender.send("registration-2"), "sent");
  const exchanges = requests.filter((r) => r.url.startsWith("https://oauth2"));
  assert.equal(exchanges.length, 1, "the access token is kept");
  const assertion = new URLSearchParams(exchanges[0].body).get("assertion")!;
  const jwt = readJwt(assertion, publicKey, "RS256");
  assert.ok(jwt.signed);
  assert.equal(jwt.claims.iss, "relay@relay-test.iam");
  const send = requests.find((r) => r.url.includes("messages:send"))!;
  assert.equal(send.url, "https://fcm.googleapis.com/v1/projects/relay-test/messages:send");
  assert.equal(send.headers.Authorization, "Bearer access-1");
  assert.deepEqual(JSON.parse(send.body!).message, { token: "registration-1", data: { wake: "1" }, android: { priority: "HIGH", ttl: "3600s" } });

  const gone = fcmSender({ project_id: "p", client_email: "e", private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString() }, fakeFetch((url) => (url.includes("oauth2") ? { status: 200, body: JSON.stringify({ access_token: "a", expires_in: 3600 }) } : { status: 404 })).fetch);
  assert.equal(await gone.send("old"), "gone");
});
