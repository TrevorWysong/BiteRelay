// Proves moving an account to a new phone with the same key (RECOVERY.md):
// the old phone waits until the network holds everything it wrote
// (`ready_to_move`); the new one restores the account's chain from the
// network and sets itself up (`prepare_device`) -- the grants that let
// other devices call it (signals, a driver's check-in code) are private to
// the device that wrote them, so a restore arrives without them. Then the
// same account carries on: its store, the order it had in hand, calls from
// others, and one unbroken chain everyone agrees on.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { CallableCell } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, retryUntil, retryUntilOk, restoreInPlace, retryingCaller, setupPlayersWithProperties } from "./helpers.js";

interface MoveReadiness {
  head: Uint8Array;
  seq: number;
  seen: number | null;
  ready: boolean;
}

const same = (a: Uint8Array | null | undefined, b: Uint8Array) => !!a && Buffer.from(a).equals(Buffer.from(b));

await runScenario(async (scenario) => {
  const players = await setupPlayersWithProperties(scenario, 3, () => ({}));
  const [customer, , neighbour] = players;
  let merchant = players[1];
  const dna = customer.cells[0].cell_id[0];
  const sync = () => dhtSync([customer, merchant, neighbour], dna);
  const call = (cell: CallableCell, zome: string) => retryingCaller(cell, zome);
  const grantTags = async () => {
    const listed = await merchant.conductor.adminWs().listCapabilityGrants({ installed_app_id: merchant.appId, include_revoked: false } as never);
    return (listed as unknown as [unknown, { cap_grant: { tag: string } }[]][]).flatMap(([, grants]) => grants.map((g) => g.cap_grant.tag)).filter((tag) => tag !== "zome-call-signing-key").sort();
  };

  // ===== The store, and an order it has in hand =====
  const store = actionHash(await call(merchant.cells[0], "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant.cells[0], "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 2000, available: true }));
  await sync();
  const order = { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 2000 };
  const first = actionHash(await retryUntilOk(() => call(customer.cells[0], "dispatch")<HcRecord>("request_pickup_order", order)));
  await sync();
  await retryUntilOk(() => call(merchant.cells[0], "dispatch")("accept_pickup_order", { order_original_action: first }));
  // A delivery with no driver yet: someone checking in for it asks the
  // store's own conductor (`check_in_at_store` -> `confirm_check_in`), which
  // only its "codes" grant lets them reach. The store's own answer -- they
  // aren't its driver -- proves the call got there; "isn't reachable" means
  // it was refused at the door.
  const delivery = actionHash(
    await retryUntilOk(() => call(customer.cells[0], "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 2000, dropoff: ST_PETE, max_delivery_fee: null })),
  );
  const checkIn = () => call(neighbour.cells[0], "attestation")("check_in_at_store", { order_ref: delivery, code: "000000" });
  await sync();
  await assert.rejects(checkIn(), /Only the order's driver/, "other devices reach the store's conductor");
  assert.deepEqual(await grantTags(), ["codes", "recv_remote_signal", "recv_remote_signal"], "a device set up at init holds its grants");

  // ===== The old phone: ready only once the network holds all it wrote =====
  const before = await retryingCaller(merchant.cells[0], "account")<MoveReadiness>("ready_to_move", null);
  await sync();
  const ready = await retryUntil(() => retryingCaller(merchant.cells[0], "account")<MoveReadiness>("ready_to_move", null), (r) => r.ready, 60, 1000);
  assert.ok(ready.seq >= before.seq && ready.seen === ready.seq, "the network's authorities hold this device's latest action");
  for (const zome of ["dispatch", "catalog", "attestation"]) await retryingCaller(merchant.cells[0], zome)("prepare_device", null);
  const after = await retryingCaller(merchant.cells[0], "account")<MoveReadiness>("ready_to_move", null);
  assert.ok(same(after.head, ready.head), "a device that's set up writes nothing to set up again");
  console.log("[PASS] the old phone sends its key only once the network holds everything it wrote");

  // ===== The new phone: the same key, restored from the network =====
  // The old phone stops before its key leaves (the runtime's `send`); its
  // background work may have written once more since the check.
  await merchant.conductor.adminWs().disableApp({ installed_app_id: merchant.appId });
  merchant = await restoreInPlace(merchant);
  const restored = await retryingCaller(merchant.cells[0], "account")<MoveReadiness>("ready_to_move", null);
  assert.ok(restored.seq >= ready.seq, "the whole chain comes back");
  assert.deepEqual(await grantTags(), [], "but not the grants: they were private to the old device");
  await assert.rejects(checkIn(), /isn't reachable/, "so nobody else can reach it yet");
  const prepare = async () => {
    for (const zome of ["dispatch", "catalog", "attestation"]) await retryingCaller(merchant.cells[0], zome)("prepare_device", null);
  };
  await prepare();
  // Written again, each grant is the same entry as the old one, so the old
  // grant's action counts again too.
  assert.deepEqual([...new Set(await grantTags())], ["codes", "recv_remote_signal"], "the new device writes its own");
  const prepared = await retryingCaller(merchant.cells[0], "account")<MoveReadiness>("ready_to_move", null);
  await prepare();
  const again = await retryingCaller(merchant.cells[0], "account")<MoveReadiness>("ready_to_move", null);
  assert.ok(same(again.head, prepared.head), "once");
  const stores = await retryingCaller(merchant.cells[0], "catalog")<unknown[]>("list_my_catalogs", null);
  assert.equal(stores.length, 1, "the store is still this account's: nothing to move or relist");
  console.log("[PASS] the new phone restores the account and sets itself up");

  // ===== The same account carries on =====
  // Past here each step waits on what it needs, not a whole-network sync: a
  // node whose app was uninstalled and restored never holds exactly the
  // same set of ops as the rest, which is what `dhtSync` asks.
  // The new install's peer record, as bootstrap would spread it.
  await scenario.shareAllAgents();
  const reached = await retryUntil(() => checkIn().then(() => "", (err) => String(err)), (answer) => /Only the order's driver/.test(answer), 60, 1000);
  assert.match(reached, /Only the order's driver/, "other devices reach the new phone, through the grant it wrote");
  await retryUntilOk(() => call(merchant.cells[0], "dispatch")("mark_ready_for_pickup", first), 60, 1000);
  await retryUntilOk(() => call(customer.cells[0], "dispatch")("complete_pickup", first), 120, 1000);
  console.log("[PASS] the order the old phone had in hand finishes on the new one");
  const carriedOn = await retryUntil(() => retryingCaller(merchant.cells[0], "account")<MoveReadiness>("ready_to_move", null), (r) => r.ready, 120, 1000);
  // `ready` is the network's authorities -- what everyone else reads --
  // reporting one valid chain, unwarranted, ending where this device's does.
  assert.ok(carriedOn.seq > restored.seq, "its chain carries on from where the old phone left it, one chain the network agrees on: no fork");
  console.log("[PASS] the same account carries on: its orders, calls from others, and one chain");
});
