// Proves `get_balance` always equals the sum of an agent's actual
// transactions, for the payer and the payee, however many balance
// checkpoints have been written along the way. The settling window is set
// to zero here so checkpoints fire within the test (one per 20 settled
// transactions); each order is a real completed pickup, the only way a
// payment validates. The payer's balance is checked after every payment;
// the payee's, which waits on gossip, every few -- each step waits only for
// what it needs rather than syncing the whole network.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, appWithProperties, decodeEntry, retryUntilOk, ST_PETE } from "./helpers.js";

/// Enough for at least two checkpoints on each side (one per 20).
const ORDERS = 45;
/// How often the payee's balance is checked, in payments.
const PAYEE_CHECK_EVERY = 5;

interface Txn {
  from: Uint8Array;
  to: Uint8Array;
  amount: number;
}

await runScenario(async (scenario) => {
  const app = appWithProperties({ ledger_settle_secs: 0 });
  const [customer, merchant] = await scenario.addPlayersWithApps([app, app]);
  const both = [customer, merchant];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(both, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Soup", price_cents: 100, available: true }));
  await sync();

  const transactionsOf = async (p: typeof customer) => {
    const all: Txn[] = [];
    let after: number | null = null;
    do {
      const page: { transactions: HcRecord[]; next_after: number | null } = await call(p, "ledger")("list_my_transactions", { after });
      all.push(...page.transactions.map((r) => decodeEntry<Txn>(r)));
      after = page.next_after;
    } while (after !== null);
    return all;
  };
  const sumFor = (txns: Txn[], agent: Uint8Array) =>
    txns.reduce((sum, t) => sum + (Buffer.from(t.to).equals(Buffer.from(agent)) ? t.amount : 0) - (Buffer.from(t.from).equals(Buffer.from(agent)) ? t.amount : 0), 0);
  /// The agent's own balance read, checked against their transactions.
  const checkBalance = async (p: typeof customer, expected: number, when: string) => {
    const balance = await call(p, "ledger")<number>("get_balance", p.agentPubKey);
    const actual = sumFor(await transactionsOf(p), p.agentPubKey);
    const checkpoints = await call(p, "ledger")<number>("count_balance_checkpoints", p.agentPubKey);
    assert.equal(actual, expected, `${when}: the transactions should sum to ${expected}`);
    assert.equal(balance, actual, `${when} (${checkpoints} checkpoints): get_balance must equal the sum of the transactions`);
    return checkpoints;
  };

  let paid = 0;
  for (let i = 1; i <= ORDERS; i++) {
    // Varying amounts: i bowls of soup at $1.00.
    const total = 100 * i;
    const order = actionHash(await call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity: i }], order_total: total }));
    // Each side retries until the other's last step has reached it.
    await retryUntilOk(() => call(merchant, "dispatch")("confirm_pickup_prep", order), 40);
    await call(merchant, "dispatch")("mark_ready_for_pickup", order);
    await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", order), 40);
    paid += total;
    await checkBalance(customer, -paid, `customer after order ${i}`);
    if (i % PAYEE_CHECK_EVERY === 0) {
      await sync();
      await checkBalance(merchant, paid, `store after order ${i}`);
    }
  }
  await sync();
  const customerCheckpoints = await checkBalance(customer, -paid, "customer at the end");
  const merchantCheckpoints = await checkBalance(merchant, paid, "store at the end");
  assert.ok(customerCheckpoints >= 2 && merchantCheckpoints >= 2, "checkpoints should have fired for both the payer and the payee");
  console.log(`[PASS] ${ORDERS} payments: the payer's (${customerCheckpoints} checkpoints) and payee's (${merchantCheckpoints}) balances always match their transactions`);

  // Each checkpoint is the agent's own: nobody else's read writes one.
  const before = await call(customer, "ledger")<number>("count_balance_checkpoints", merchant.agentPubKey);
  await call(customer, "ledger")("get_balance", merchant.agentPubKey);
  assert.equal(await call(customer, "ledger")<number>("count_balance_checkpoints", merchant.agentPubKey), before, "reading someone else's balance must not write a checkpoint for them");
  console.log("[PASS] only an agent's own reads write their checkpoints");
});
