// How validation's cost grows with a chain's length -- for the rules that
// walk back through an author's chain (see integrity_support::chain).
// Not part of the suite: run with `npx tsx bench/chain-cost.ts [sizes…]`.
//
// Measures recovery by phrase: the successor's take_over is validated
// against the predecessor's chain (`plan_as_of`), which walks from where it
// stands back to its latest recovery plan. The predecessor's chain is padded
// with cheap actions between checkpoints, and a fresh successor recovers it
// at each.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, installManyAgents, retryUntil, shareAgentsOn, ST_PETE, useTestCoordinators } from "../src/helpers.js";

const SIZES = (process.argv.slice(2).length ? process.argv.slice(2) : ["0", "1000", "4000"]).map(Number);
const PAD_BATCH = 100;

function phraseKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  // The app's form for an agent key: prefix, key, and its DHT location.
  return { raw, sign: (m: Uint8Array) => new Uint8Array(sign(null, m, createPrivateKey({ key: der, format: "der", type: "pkcs8" }))) };
}

await runScenario(async (scenario) => {
  const [a, b] = [await scenario.addConductor(), await scenario.addConductor()];
  const [owner, predecessor] = await installManyAgents(a, 2, "pred");
  const successors = await installManyAgents(b, SIZES.length, "succ");
  const all = [owner, predecessor, ...successors];
  await shareAgentsOn([a, b], owner.cells[0].cell_id[0]);
  await useTestCoordinators(predecessor, ["profiles"]);
  const call = (p: typeof owner, zome: string) => getZomeCaller(p.cells[0], zome);
  const sync = () => dhtSync(all, owner.cells[0].cell_id[0]);

  const store = actionHash(await call(owner, "catalog")<HcRecord>("publish_catalog", { business_name: "Pad target", location: ST_PETE }));
  await sync();
  // The phrase key as an agent key, the way account.test.ts derives one.
  const { dhtLocationFrom32 } = await import("@holochain/client");
  const phrase = phraseKey();
  const phraseAgentKey = new Uint8Array([0x84, 0x20, 0x24, ...phrase.raw, ...dhtLocationFrom32(phrase.raw)]);
  const plan = await call(predecessor, "account")<{ plan: Uint8Array }>("set_recovery_plan", { phrase_key: phraseAgentKey, guardians: [], threshold: 0 });

  let padded = 0;
  console.log("chain actions since plan  |  take_over (ms)");
  for (const [i, size] of SIZES.entries()) {
    const padStart = performance.now();
    while (padded < size) {
      const count = Math.min(PAD_BATCH, size - padded);
      const batchStart = performance.now();
      await call(predecessor, "profiles")("pad_chain_for_testing", { catalog: store, count });
      padded += count;
      if (padded % 1000 === 0) {
        console.error(`    ${padded} actions: last batch of ${count} took ${(performance.now() - batchStart).toFixed(0)} ms`);
        // Let the network take in what's been written before writing more:
        // an unbounded publish backlog stalls the conductor's database.
        await sync();
      }
    }
    console.error(`  padded to ${padded} in ${((performance.now() - padStart) / 1000).toFixed(0)} s`);
    const syncStart = performance.now();
    await sync();
    console.error(`  synced in ${((performance.now() - syncStart) / 1000).toFixed(0)} s`);
    const successor = successors[i];
    const head = await retryUntil(() => call(successor, "account")<Uint8Array | null>("latest_action_of", predecessor.agentPubKey), (h) => !!h, 60, 1000);
    const message = new Uint8Array([...new TextEncoder().encode("relay-recovery:v1:"), ...predecessor.agentPubKey, 58, ...successor.agentPubKey, 58, ...head!]);
    const started = performance.now();
    const outcome = await call(successor, "account")("take_over", { predecessor: predecessor.agentPubKey, authority: { Phrase: { plan: plan.plan, head, signature: phrase.sign(message) } } }).then(
      () => `${(performance.now() - started).toFixed(0)}`,
      (err: Error) => `failed after ${(performance.now() - started).toFixed(0)}: ${err.message.slice(0, 80)}`,
    );
    console.log(`${String(size).padStart(24)}  |  ${outcome}`);
  }
});
