// Proves how a closed app gets woken (docs/MOBILE.md, "Waking a closed app"):
// a customer's order carries their wake tokens sealed, one to its store and
// one to its driver, and when either of them changes the order, their own
// app is handed their token -- to pass to the network's push relay. Each
// holds only their own; the customer, who made the change themselves or
// wasn't party to it, is handed none.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord, Signal } from "@holochain/client";
import { acceptOrder, actionHash, collectFromStore, commitAndCook, retryUntil, retryUntilOk, ST_PETE, testApp, retryingCaller } from "./helpers.js";

/// Every wake token `ws`'s app is handed, as they come.
function wakesHeardBy(ws: { on: (evt: "signal", cb: (s: Signal) => void) => () => void }): string[] {
  const heard: string[] = [];
  ws.on("signal", (signal) => {
    if (signal.type !== "app") return;
    const payload = signal.value.payload as Record<string, unknown>;
    if (typeof payload?.Wake === "string") heard.push(payload.Wake);
  });
  return heard;
}

await runScenario(async (scenario) => {
  const [customer, store, driver] = await scenario.addPlayersWithApps([testApp, testApp, testApp]);
  const all = [customer, store, driver];
  await scenario.shareAllAgents();
  const heard = { customer: wakesHeardBy(customer.appWs), store: wakesHeardBy(store.appWs), driver: wakesHeardBy(driver.appWs) };

  const profilesOf = (p: typeof customer) => retryingCaller(p.cells[0], "profiles");
  const dispatchOf = (p: typeof customer) => retryingCaller(p.cells[0], "dispatch");
  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(store)("create_profile", { display_name: "Sol's Kitchen", roles: ["Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });
  const catalog = actionHash(await retryingCaller(store.cells[0], "catalog")<HcRecord>("publish_catalog", { business_name: "Sol's Kitchen", location: ST_PETE }));
  const item = actionHash(await retryingCaller(store.cells[0], "catalog")<HcRecord>("add_menu_item", { catalog_ref: catalog, name: "Arepa", price_cents: 900, available: true }));
  await dhtSync(all, store.cells[0].cell_id[0]);

  // ===== A pickup: the store wakes its customer =====
  const pickup = actionHash(
    await dispatchOf(customer)<HcRecord>("request_pickup_order", { merchant: store.agentPubKey, catalog_ref: catalog, items: [{ item_ref: item, quantity: 1 }], order_total: 900, wake_for_store: "wake-pickup-store" }),
  );
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await retryUntilOk(() => dispatchOf(store)("accept_pickup_order", { order_original_action: pickup }));
  await retryUntil(async () => heard.store, (tokens) => tokens.includes("wake-pickup-store"));
  assert.ok(heard.store.includes("wake-pickup-store"), "accepting the order hands the store's app its token for the customer");
  console.log("[PASS] a store changing a pickup order is handed its customer's wake token");

  // ===== A delivery: the store, then the driver, each with their own =====
  const delivery = actionHash(
    await dispatchOf(customer)<HcRecord>("request_delivery", {
      merchant: store.agentPubKey,
      catalog_ref: catalog,
      items: [{ item_ref: item, quantity: 1 }],
      order_total: 900,
      dropoff: ST_PETE,
      max_delivery_fee: 500,
      wake_for_store: "wake-delivery-store",
      wake_for_driver: "wake-delivery-driver",
    }),
  );
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await acceptOrder(store, delivery, all);
  await retryUntil(async () => heard.store, (tokens) => tokens.includes("wake-delivery-store"));
  assert.ok(heard.store.includes("wake-delivery-store"));

  const bid = actionHash(await dispatchOf(driver)<HcRecord>("submit_bid", { order_ref: delivery, eta_seconds: 600, price_offer: 400 }));
  await dhtSync(all, driver.cells[0].cell_id[0]);
  await dispatchOf(customer)("accept_bid", { order_original_action: delivery, bid_action: bid });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await commitAndCook(driver, store, delivery, all);
  // The driver holds their token once the customer's app has shared the
  // drop-off with them; picking the order up is a change they make after.
  await collectFromStore(driver, store, delivery, all);
  await retryUntil(async () => heard.driver, (tokens) => tokens.includes("wake-delivery-driver"), 40, 500);
  assert.ok(heard.driver.includes("wake-delivery-driver"), "the driver changing the order is handed their own token for the customer");
  console.log("[PASS] a store and a driver changing a delivery are each handed their own token for its customer");

  assert.ok(!heard.store.includes("wake-delivery-driver") && !heard.driver.includes("wake-delivery-store"), "neither holds the other's");
  assert.ok(heard.driver.every((token) => token === "wake-delivery-driver"), "the driver holds nothing of the pickup order");
  assert.deepEqual(heard.customer, [], "the customer is never handed a token: nobody wakes themselves");
  console.log("[PASS] each party holds only its own token; the customer none");
});
