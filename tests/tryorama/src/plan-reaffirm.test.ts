// Proves recovery stays cheap to validate however long an account is used:
// validation walks from where the account stands back to its recovery plan
// only, and the account's app re-affirms the plan once its chain has run
// far past it. The re-affirmed plan is the one that recovers the account;
// the earlier one no longer does.
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import { dhtLocationFrom32, type Record as HcRecord } from "@holochain/client";
import { actionHash, installManyAgents, retryUntil, shareAgentsOn, ST_PETE, useTestCoordinators } from "./helpers.js";

/// account coordinator `REAFFIRM_AFTER_ACTIONS`.
const REAFFIRM_AFTER = 2000;

function phraseKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  return { key: new Uint8Array([0x84, 0x20, 0x24, ...raw, ...dhtLocationFrom32(raw)]), sign: (m: Uint8Array) => new Uint8Array(sign(null, m, createPrivateKey({ key: der, format: "der", type: "pkcs8" }))) };
}

await runScenario(async (scenario) => {
  const [a, b] = [await scenario.addConductor(), await scenario.addConductor()];
  const [owner, account] = await installManyAgents(a, 2, "acct");
  const [early, late] = await installManyAgents(b, 2, "succ");
  const all = [owner, account, early, late];
  await shareAgentsOn([a, b], owner.cells[0].cell_id[0]);
  await useTestCoordinators(account, ["profiles"]);
  const call = (p: typeof owner, zome: string) => getZomeCaller(p.cells[0], zome);
  // A couple of thousand actions take minutes to spread on a busy runner.
  const sync = () => dhtSync(all, owner.cells[0].cell_id[0], 1000, 15 * 60_000);

  const store = actionHash(await call(owner, "catalog")<HcRecord>("publish_catalog", { business_name: "Pad target", location: ST_PETE }));
  await sync();
  const phrase = phraseKey();
  const first = await call(account, "account")<{ plan: Uint8Array }>("set_recovery_plan", { phrase_key: phrase.key, guardians: [], threshold: 0 });
  assert.equal(await call(account, "account")<boolean>("reaffirm_recovery_plan", null), false, "a recent plan isn't published again");

  for (let padded = 0; padded < REAFFIRM_AFTER; padded += 100) {
    await call(account, "profiles")("pad_chain_for_testing", { catalog: store, count: 100 });
    if (padded % 1000 === 900) await sync();
  }
  assert.equal(await call(account, "account")<boolean>("reaffirm_recovery_plan", null), true, "a plan the chain has run far past is published again");
  const reaffirmed = await call(account, "account")<{ plan: Uint8Array } | null>("my_recovery_plan", null);
  assert.ok(reaffirmed && !Buffer.from(reaffirmed.plan).equals(Buffer.from(first.plan)));
  await sync();
  console.log("[PASS] an account's app re-affirms its recovery plan once its chain has run far past it");

  const recover = async (successor: typeof owner, plan: Uint8Array) => {
    const head = (await retryUntil(() => call(successor, "account")<Uint8Array | null>("latest_action_of", account.agentPubKey), (h) => !!h, 60, 1000))!;
    const message = new Uint8Array([...new TextEncoder().encode("relay-recovery:v1:"), ...account.agentPubKey, 58, ...successor.agentPubKey, 58, ...head]);
    return call(successor, "account")("take_over", { predecessor: account.agentPubKey, authority: { Phrase: { plan, head, signature: phrase.sign(message) } } });
  };
  await assert.rejects(recover(early, first.plan), /latest recovery plan/, "the plan it replaced no longer recovers it");
  await recover(late, reaffirmed!.plan);
  console.log("[PASS] the re-affirmed plan recovers the account, walked back only that far");
});
