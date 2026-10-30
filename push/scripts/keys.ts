// Makes the relay's own keys, as .env lines: the token key, and a VAPID key
// for Web Push. Run once per relay, and keep both: a new token key voids
// every token devices hold, and a new VAPID key every browser subscription.
//
//   npm run keys >> .env
import { generateKeyPairSync, randomBytes } from "node:crypto";

const vapid = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
console.log(`TOKEN_KEY=${randomBytes(32).toString("base64")}`);
console.log(`VAPID_PRIVATE_KEY="${vapid.trim().replace(/\n/g, "\\n")}"`);
