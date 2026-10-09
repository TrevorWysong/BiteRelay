// Proves DropoffPreference: defaults to LeaveAtDoor when omitted, a
// custom value round-trips through request_delivery, and it survives the
// normal order lifecycle untouched (dispatch_integrity's field-immutability
// check already covers this generically -- see validate_order_transition's
// `unchanged` check -- this proves it doesn't regress for the new field).
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, ST_PETE, acceptOrder } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const all = [customer, merchant, driver];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 1000, available: true });
  const menuItemRef = actionHash(menuItemRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  async function placeOrder(dropoffPreference?: string) {
    const input: Record<string, unknown> = {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: menuItemRef, quantity: 1 }],
      order_total: 1000,
      dropoff: ST_PETE,
      max_delivery_fee: null,
    };
    if (dropoffPreference !== undefined) input.dropoff_preference = dropoffPreference;
    return dispatchOf(customer)<HcRecord>("request_delivery", input);
  }

  const defaultOrder = await placeOrder();
  assert.equal(decodeEntry<{ dropoff_preference: string }>(defaultOrder).dropoff_preference, "LeaveAtDoor", "omitting dropoff_preference must default to LeaveAtDoor");
  console.log("[PASS] dropoff_preference defaults to LeaveAtDoor when omitted");

  const customOrder = await placeOrder("MeetOutside");
  assert.equal(decodeEntry<{ dropoff_preference: string }>(customOrder).dropoff_preference, "MeetOutside", "an explicit dropoff_preference must round-trip");
  console.log("[PASS] a custom dropoff_preference round-trips through request_delivery");

  // Drive it through a real transition (bid/accept) and confirm the field
  // survives untouched -- proving the new field composes with the
  // existing field-immutability check rather than silently bypassing it.
  const customOrderRef = actionHash(customOrder);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await acceptOrder(merchant, customOrderRef, all);
  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: customOrderRef,
    eta_seconds: 600,
    price_offer: 400,
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const accepted = await dispatchOf(customer)<HcRecord>("accept_bid", { order_original_action: customOrderRef, bid_action: actionHash(bidRecord) });
  assert.equal(decodeEntry<{ dropoff_preference: string }>(accepted).dropoff_preference, "MeetOutside", "dropoff_preference must survive a real status transition unchanged");
  console.log("[PASS] dropoff_preference survives a real order transition (accept_bid) unchanged");
});
