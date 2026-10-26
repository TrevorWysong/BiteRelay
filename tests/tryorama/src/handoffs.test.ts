// Proves every handoff is proved by whoever hands the order over:
//
// - at the store, a driver checks in with the store's code, which the
//   store's own conductor checks (and stops answering after a few wrong
//   tries), and only for the order's driver -- the code shows they're at
//   the counter, never that they have the food;
// - a driver picks an order up only on the store's own record of handing it
//   over -- its scan of the driver's code, or its confirmation -- and
//   validation refuses a pickup that cites anything else;
// - at the door, the customer's scanned code, the six digits they read out
//   (checked by their own conductor, which stops answering after a few
//   wrong tries), or their own confirmation completes the delivery;
// - an order left at the door is the customer's choice and risk: it needs
//   their acceptance, completes once it's left, and can't then be claimed
//   undelivered -- and a store can refuse to leave its pricier orders;
// - a delivery is never completed without proof, and only a door drop-off
//   the customer chose is left at the door.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, collectFromStore, commitAndCook, decodeEntry, FULL_SIZE_PHOTO, latestLedgerEntry, pickUp, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators, retryingCaller } from "./helpers.js";

const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

interface PinSecret {
  pin: string;
  salt: Uint8Array;
}

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await setupPlayersWithProperties(scenario, 3, () => ({}));
  const all = [customer, merchant, driver];
  for (const p of all) await useTestCoordinators(p, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const status = async (ref: Uint8Array) => decodeEntry<{ status: string }>(await call(customer, "dispatch")<HcRecord>("get_order", ref)).status;

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 1000, available: true }));
  await sync();

  /// A delivery, as far as its driver heading to the store.
  async function toTheStore(extra: Record<string, unknown> = {}) {
    const ref = actionHash(
      await retryUntilOk(() =>
        call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000, dropoff: ST_PETE, max_delivery_fee: null, ...extra }),
      ),
    );
    await sync();
    await acceptOrder(merchant, ref, all);
    const bid = actionHash(await retryUntilOk(() => call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: ref, eta_seconds: 600, price_offer: 400 })));
    await sync();
    await retryUntilOk(() => call(customer, "dispatch")("accept_bid", { order_original_action: ref, bid_action: bid }));
    await sync();
    await commitAndCook(driver, merchant, ref, all);
    return ref;
  }
  const leg = (ref: Uint8Array, kind: "MerchantHandoff" | "CustomerHandoff", extra: Record<string, unknown> = {}) =>
    call(driver, "attestation")<HcRecord>("record_leg", { order_ref: ref, sequence: kind === "MerchantHandoff" ? 0 : 1, kind, to: kind === "MerchantHandoff" ? merchant.agentPubKey : customer.agentPubKey, geo_at_completion: ST_PETE, ...extra });
  const wrong = (secret: PinSecret) => ({ pin: secret.pin === "000000" ? "111111" : "000000", salt: secret.salt });

  // ===== Checking in =====
  const order = await toTheStore();
  const unproven = actionHash(await leg(order, "MerchantHandoff"));
  await assert.rejects(call(driver, "dispatch")("pick_up_order", order), /once the store has checked its driver in/, "no pickup before the store checks the driver in");
  const checkInCode = await call(merchant, "dispatch")<PinSecret | null>("get_my_pickup_code", order);
  assert.ok(checkInCode, "the store's app has its check-in code");
  assert.equal(await call(driver, "dispatch")("get_my_pickup_code", order), null, "nobody else can read it");
  await assert.rejects(call(customer, "attestation")("check_in_at_store", { order_ref: order, code: checkInCode.pin }), /Only the order's driver checks in for it/, "only the order's driver checks in for it");
  await assert.rejects(call(driver, "attestation")("check_in_at_store", { order_ref: order, code: wrong(checkInCode).pin }), /4 tries left/, "a wrong code is counted");
  await retryUntilOk(() => call(driver, "attestation")("check_in_at_store", { order_ref: order, code: checkInCode.pin }));
  await sync();
  assert.equal(await status(order), "DriverAtStore");
  console.log("[PASS] a driver checks in with the store's code, which the store's own conductor checks");

  // ===== Pickup =====
  await assert.rejects(call(driver, "dispatch")("pick_up_order", order), /Have the store scan your code/, "checked in isn't handed over");
  await assert.rejects(
    call(driver, "dispatch")("force_order_update_for_testing", { order_original_action: order, next_status: "PickedUp", delivery_receipts: [] }),
    /needs the store's record of handing it over/,
    "validation refuses a pickup with no proof",
  );
  await assert.rejects(
    call(driver, "dispatch")("force_order_update_for_testing", { order_original_action: order, next_status: "PickedUp", delivery_receipts: [], pickup_proof: unproven }),
    /the store's record of handing the order over/,
    "nor one citing the driver's own record",
  );
  await assert.rejects(leg(order, "MerchantHandoff", { scanned: checkInCode }), /The store hands the order over by scanning your code/, "the check-in code proves nothing about the food");
  await assert.rejects(call(driver, "attestation")("handoff_by_code", { leg: unproven, code: checkInCode.pin }), /confirming in its app|scanning your code/, "nor typed in");
  await retryUntilOk(() => call(merchant, "attestation")("acknowledge_leg", unproven));
  await sync();
  await pickUp(driver, order);
  await sync();
  assert.equal(await status(order), "PickedUp");
  console.log("[PASS] a driver picks up only on the store's own record of handing it over");

  const confirmedPickup = await toTheStore();
  await collectFromStore(driver, merchant, confirmedPickup, all);
  assert.equal(await status(confirmedPickup), "PickedUp");
  console.log("[PASS] ...which checks the driver in too, if they hadn't");

  // ===== Drop-off =====
  await assert.rejects(call(driver, "dispatch")("complete_delivery", { order_original_action: order }), /no proof yet/, "no delivery without proof");
  const dropoff = actionHash(await leg(order, "CustomerHandoff"));
  await sync();
  const code = await call(customer, "dispatch")<PinSecret>("get_my_handover_code", order);
  for (const left of [4, 3, 2, 1]) {
    await assert.rejects(call(driver, "attestation")("handoff_by_code", { leg: dropoff, code: wrong(code).pin }), new RegExp(left === 1 ? "One try left" : `${left} tries left`));
  }
  await assert.rejects(call(driver, "attestation")("handoff_by_code", { leg: dropoff, code: wrong(code).pin }), /Too many wrong codes/, "after five wrong codes it stops answering");
  await assert.rejects(call(driver, "attestation")("handoff_by_code", { leg: dropoff, code: code.pin }), /Too many wrong codes/, "even the right one, for this order");
  console.log("[PASS] a typed code is checked by the customer's own conductor, which stops after five wrong tries");

  await leg(order, "CustomerHandoff", { scanned: code });
  await retryUntilOk(() => call(driver, "dispatch")("complete_delivery", { order_original_action: order }));
  await sync();
  assert.equal(await status(order), "Delivered");
  await assert.rejects(call(customer, "dispatch")("claim_never_arrived", order), /until it's delivered/, "and it can't then be claimed");
  console.log("[PASS] the customer's scanned code completes the delivery, finally");

  const typed = actionHash(await leg(confirmedPickup, "CustomerHandoff"));
  await sync();
  const typedCode = await call(customer, "dispatch")<PinSecret>("get_my_handover_code", confirmedPickup);
  await retryUntilOk(() => call(driver, "attestation")("handoff_by_code", { leg: typed, code: typedCode.pin }));
  await sync();
  await retryUntilOk(() => call(driver, "dispatch")("complete_delivery", { order_original_action: confirmedPickup }));
  await sync();
  assert.equal(await status(confirmedPickup), "Delivered");
  console.log("[PASS] ...as do the six digits the customer reads out");

  // ===== Left at the door =====
  await assert.rejects(
    call(customer, "dispatch")("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000, dropoff: ST_PETE, max_delivery_fee: null, dropoff_preference: "LeaveAtDoor" }),
    /accept that it's delivered once it's left/,
    "the door is the customer's choice, and their risk to accept",
  );
  const door = await toTheStore({ dropoff_preference: "LeaveAtDoor", door_risk_accepted: true });
  await collectFromStore(driver, merchant, door, all);
  await assert.rejects(leg(door, "CustomerHandoff", { left_at_door: true }), /Take a photo/, "the driver photographs where they left it");
  const doorstep = actionHash(await leg(door, "CustomerHandoff", { left_at_door: true, photo_data_uri: FULL_SIZE_PHOTO }));
  await retryUntilOk(() => call(driver, "dispatch")("complete_delivery", { order_original_action: door }));
  await sync();
  assert.equal(await status(door), "Delivered");
  await assert.rejects(call(customer, "dispatch")("claim_never_arrived", door), /until it's delivered/, "left at the door, it's delivered");
  await sync();
  const evidence = await call(customer, "attestation")<{ photo_data_uri: string } | null>("get_handoff_evidence", doorstep);
  assert.equal(evidence?.photo_data_uri, FULL_SIZE_PHOTO, "the customer sees the full photo of where it was left");
  console.log("[PASS] an order left at the door, as the customer chose, is delivered once it's left -- with a full-size photo");

  // Three delivered: the driver's collateral for each comes back as each
  // settles, which their conductor does on its own schedule. Settled here,
  // rather than counting on that timing, before they take on a fourth.
  await retryUntil(
    async () => {
      for (const ref of [order, confirmedPickup, door]) {
        await call(merchant, "dispatch")("settle_order", ref).catch(() => 0);
        await call(driver, "dispatch")("settle_order", ref).catch(() => 0);
      }
      await sync();
      return (await latestLedgerEntry(driver)).in_hand.orders;
    },
    (inHand) => inHand < 3,
    60,
    1000,
  );
  const handToMe = await toTheStore();
  await collectFromStore(driver, merchant, handToMe, all);
  await assert.rejects(leg(handToMe, "CustomerHandoff", { left_at_door: true, photo_data_uri: PHOTO }), /only a drop-off the customer chose/, "a driver can't leave an order the customer wanted handed over");
  console.log("[PASS] only an order the customer chose to have left at the door is left there");

  // The driver completed each of those deliveries -- they still count
  // toward the customer's loyalty rewards at this store.
  assert.equal(await call(customer, "dispatch")<number>("count_my_completed_orders", store), 3, "deliveries count toward loyalty, whoever completed them");
  console.log("[PASS] delivered orders count toward the customer's loyalty, though their driver completed them");

  // ===== The store's limit =====
  await call(merchant, "catalog")("set_leave_at_door_limit", { original_action: store, max_cents: 500 });
  await sync();
  const pricey = actionHash(
    await retryUntilOk(() =>
      call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000, dropoff: ST_PETE, max_delivery_fee: null, dropoff_preference: "LeaveAtDoor", door_risk_accepted: true }),
    ),
  );
  await sync();
  await retryUntil(
    () => call(merchant, "dispatch")("accept_delivery_order", { order_original_action: pricey }).then(() => "accepted", (e: Error) => e.message),
    (outcome) => /over your limit/.test(outcome),
  );
  console.log("[PASS] a store refuses to leave orders over its limit at the door");
});
