// Sets up the issuer's identity on its conductor (scripts/conductor.mjs),
// in the two steps a network's bundle needs:
//
//   1. node scripts/provision.mjs key
//      Makes the issuer's agent key (or shows the one it has). Put it in the
//      network's deploy/properties.json `issuers` -- the roster is part of
//      the DNA, so it comes before the bundle is built.
//   2. node scripts/provision.mjs install ../deploy/relay.happ
//      After `npm run package` (in web/), installs that exact hApp for the
//      issuer's key, so the issuer is on the same network as everyone else.
//
// Both are safe to repeat. CONDUCTOR_ADMIN_URL and ISSUER_APP_ID as in
// .env.example; ISSUER_DATA_DIR where conductor.mjs keeps its data.
import { AdminWebsocket, decodeHashFromBase64, encodeHashToBase64 } from "@holochain/client";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const adminUrl = process.env.CONDUCTOR_ADMIN_URL ?? "ws://localhost:8870";
const appId = process.env.ISSUER_APP_ID ?? "relay-issuer";
const dataDir = process.env.ISSUER_DATA_DIR;
if (!dataDir) {
  console.error("ISSUER_DATA_DIR isn't set: where the issuer's conductor keeps its data (scripts/conductor.mjs).");
  process.exit(2);
}
const keyFile = path.join(path.resolve(dataDir), "issuer-agent-key");
const [command, happPath] = process.argv.slice(2);

const admin = await AdminWebsocket.connect({ url: new URL(adminUrl), wsClientOptions: { origin: "http://localhost" }, defaultTimeout: 120_000 });
try {
  const installed = (await admin.listApps({})).find((app) => app.installed_app_id === appId);
  if (command === "key") {
    if (installed) {
      console.log(encodeHashToBase64(installed.agent_pub_key));
    } else {
      if (!existsSync(keyFile)) writeFileSync(keyFile, encodeHashToBase64(await admin.generateAgentPubKey()));
      console.log(readFileSync(keyFile, "utf8"));
    }
    console.error("Add it to deploy/properties.json `issuers`, then `npm run package` in web/.");
  } else if (command === "install") {
    if (!happPath) throw new Error("Which hApp? node scripts/provision.mjs install ../deploy/relay.happ");
    if (installed) {
      console.log(`${appId} is already installed for ${encodeHashToBase64(installed.agent_pub_key)}.`);
    } else {
      if (!existsSync(keyFile)) throw new Error("Make the issuer's key first: node scripts/provision.mjs key");
      const agent = decodeHashFromBase64(readFileSync(keyFile, "utf8").trim());
      await admin.installApp({ source: { type: "bytes", value: new Uint8Array(readFileSync(happPath)) }, agent_key: agent, installed_app_id: appId });
      await admin.enableApp({ installed_app_id: appId });
      console.log(`Installed ${appId} for ${encodeHashToBase64(agent)}. Start the service: npm start`);
    }
  } else {
    throw new Error("Usage: node scripts/provision.mjs key | install <relay.happ>");
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await admin.client.close();
}
