# Relay push relay

Wakes a customer's closed Relay app when their store or driver changes their order, without learning who they are or what they ordered. MOBILE.md, "Waking a closed app", has the design; this is the service.

```sh
cp .env.example .env
npm install
npm run keys >> .env     # its token key and a VAPID key -- keep them
npm start
npm test
```

Then set the network's `services.push_relay_url` to where the app reaches it (DEPLOYMENT.md).

## What it does

- `POST /devices {channel, address}` registers a device: where its channel reaches it, a Web Push subscription, an APNs device token or an FCM registration token. It answers with the device's id, its secret, and twenty wake tokens.
- `POST /devices/tokens {device, secret}` answers with twenty more.
- `DELETE /devices {device, secret}` forgets the device: every token it handed out stops working.
- `POST /wake {token}` wakes the device the token names, if it's this relay's, unexpired, and under the device's limits. Always answered alike.
- `GET /config` names the channels it delivers on and its VAPID public key.

A wake is the same content-free push every time: an empty Web Push message, an APNs alert in the app's own words (`WAKE_TITLE`, `WAKE_BODY`), an FCM data message `{"wake": "1"}`. A device its channel says is gone is forgotten.

## What it keeps

One SQLite table: each device's id, a hash of its secret, its channel and address. Nothing about who the device belongs to, and nothing about any wake. How often each device was woken lately is kept in memory, for its limits.

## Channels

Each is on when its credentials are set (`.env.example`); a relay needs at least one.

- **Web Push**: a VAPID key (`npm run keys`) and a contact (`VAPID_SUBJECT`).
- **APNs**: a token key (.p8) from the Apple developer account, its key id, the team id and the app's bundle id. `APNS_SANDBOX=1` for development builds.
- **FCM**: the Firebase project's service account JSON.

APNs and FCM are tested against fakes of Apple's and Google's services, not yet against real devices: there's no phone build yet (MOBILE.md).

## Keep safe

- `TOKEN_KEY`: replacing it voids every token devices hold (they fetch new ones, but orders already placed can't wake anyone).
- `VAPID_PRIVATE_KEY`: replacing it voids every browser's subscription; people turn waking on again.
- The database: losing it forgets every device, with the same effect.
