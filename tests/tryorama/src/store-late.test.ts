// Proves who pays when a store runs late: a store that keeps a checked-in
// driver waiting past its own wait is called late -- proved against the
// public time source. The driver leaves paid in full by the store, the
// order reopens to another driver, and its customer may cancel for a full
// refund. A store never pays for food it didn't get to keep.
import assert from "node:assert/strict";
import { runScenario } from "@holochain-open-dev/tryorama";
import { currentBeacon, deliveryStatus, retryUntil, retryUntilOk } from "./helpers.js";
import { FEE, FOOD, lateOrderWorld, sleepUntil, type PinSecret } from "./late-orders.world.js";

await runScenario(async (scenario) => {
  const { customer, merchant, second, store, call, sync, balance, settlesTo, timing, placed, driving } = await lateOrderWorld(scenario);
  const potato = await placed();
  await driving(potato, second);

  // ===== The store late =====
  const code = await call(merchant, "dispatch")<PinSecret>("get_my_pickup_code", potato);
  await retryUntilOk(() => call(second, "attestation")("check_in_at_store", { order_ref: potato, code: code.pin }));
  await sync();
  assert.equal(await deliveryStatus(customer, potato), "DriverAtStore");
  assert.equal(await balance(merchant), -FEE, "checking the driver in holds the store's share of the fee, and the customer's again");
  await assert.rejects(call(second, "dispatch")("call_store_late", { order_ref: potato, beacon: await currentBeacon() }), /still has time/, "not before the store's wait is up");
  const lateAfter = (await timing(potato)).store_late_after;
  assert.ok(lateAfter, "a checked-in driver's wait is running");
  await sleepUntil(lateAfter);
  await retryUntilOk(async () => call(second, "dispatch")("call_store_late", { order_ref: potato, beacon: await currentBeacon() }));
  await sync();
  assert.equal(await deliveryStatus(customer, potato), "Open", "the order goes to another driver");
  await settlesTo(second, potato, FEE, "the driver leaves paid their whole fee by the store, with their collateral");
  await settlesTo(merchant, potato, -FEE, "the store pays it");
  await settlesTo(customer, potato, -FOOD, "what the customer set aside for that driver comes back");
  assert.equal((await timing(potato)).store_was_late, true, "the customer is told the store ran late");
  await retryUntilOk(() => call(customer, "dispatch")("cancel_order", potato));
  await sync();
  await settlesTo(customer, potato, 0, "the customer cancels for a full refund");
  assert.equal(await balance(merchant), -FEE, "the store gets nothing for the food");
  await retryUntil(() => call(customer, "reputation")<{ late_count: number }>("get_reputation_summary", { Store: store }), (s) => s.late_count === 1, 60, 1000);
  assert.equal((await call(customer, "reputation")<{ dropped_count: number }>("get_reputation_summary", { Driver: second.agentPubKey })).dropped_count, 0, "leaving a late store isn't a drop");
  console.log("[PASS] a store that keeps a checked-in driver waiting pays their fee, the order goes on, and the customer may cancel for a full refund");
});
