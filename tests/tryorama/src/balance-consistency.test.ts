// Proves a balance is always the arithmetic of its owner's own ledger:
// across a run of real orders, every entry on the customer's and the
// store's chains leaves exactly the balance the one before it and its own
// amount imply, and `get_balance` -- for the agent themselves and for
// anyone else reading it -- is the last of them.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, appSource, decodeEntry, retryUntil, retryUntilOk, ST_PETE } from "./helpers.js";

const ORDERS = 8;
const PRICE = 1250;

interface LedgerEntry {
  kind: Record<string, unknown>;
  amount: number;
  balance: number;
  previous: Uint8Array | null;
}

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([{ appBundleSource: appSource }, { appBundleSource: appSource }]);
  const both = [customer, merchant];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(both, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Bowl", price_cents: PRICE, available: true }));
  await sync();

  for (let i = 1; i <= ORDERS; i++) {
    const order = actionHash(await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity: 1 }], order_total: PRICE })));
    await sync();
    await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order }));
    await call(merchant, "dispatch")("mark_ready_for_pickup", order);
    await sync();
    await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", order), 40);
    assert.equal(await call(customer, "ledger")("get_balance", customer.agentPubKey), -PRICE * i, `the customer has paid for ${i} orders`);
  }
  await sync();
  const paid = await retryUntil(() => call(merchant, "ledger")<number>("get_balance", merchant.agentPubKey), (b) => b === PRICE * ORDERS, 120, 1000);
  assert.equal(paid, PRICE * ORDERS, "the store has collected every order");
  console.log(`[PASS] after ${ORDERS} orders, the customer has paid and the store has collected exactly their total`);

  for (const [who, player] of [["customer", customer], ["store", merchant]] as const) {
    const page = await call(player, "ledger")<{ entries: HcRecord[] }>("list_my_ledger", { before: null });
    const entries = page.entries.map((r) => ({ hash: actionHash(r), entry: decodeEntry<LedgerEntry>(r) })).reverse();
    let balance = 0;
    let previous: Uint8Array | null = null;
    for (const { hash, entry } of entries) {
      const sign = "Hold" in entry.kind ? -1 : "Waive" in entry.kind ? 0 : 1;
      balance += sign * entry.amount;
      assert.equal(entry.balance, balance, `each ${who} entry's balance follows from the one before it`);
      assert.deepEqual(entry.previous && Buffer.from(entry.previous), previous && Buffer.from(previous), `each ${who} entry points at the one before it`);
      previous = hash;
    }
    assert.equal(await call(player === customer ? merchant : customer, "ledger")("get_balance", player.agentPubKey), balance, `anyone reads the ${who}'s balance as their last entry's`);
  }
  console.log("[PASS] every entry's balance follows from the one before it, and anyone reads a balance as the last entry's");
});
