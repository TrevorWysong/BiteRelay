// Proves who pays when a driver leaves an order the store started cooking
// -- what DoorDash smooths over from the middle, done here by the order's
// own parties: a driver who leaves it answers for its food until another
// driver takes it on -- then they're clear. And only a driver or the store
// moves a driver on: the store only once they're late, a driver only with
// proof of the time.
//
// A store that keeps a driver waiting is `store-late.test.ts`; no driver
// coming at all, and the customer collecting it themselves,
// `no-driver.test.ts`.
import assert from "node:assert/strict";
import { runScenario } from "@holochain-open-dev/tryorama";
import { currentBeacon, deliveryStatus } from "./helpers.js";
import { FOOD, lateOrderWorld } from "./late-orders.world.js";

await runScenario(async (scenario) => {
  const { customer, merchant, first, second, call, balance, settlesTo, placed, driving, drop } = await lateOrderWorld(scenario);

  // ===== Hot potato =====
  const potato = await placed();
  await driving(potato, first);
  assert.equal(await balance(first), -FOOD, "committing holds the driver's collateral");
  await assert.rejects(call(customer, "dispatch")("release_raw_for_testing", { order_original_action: potato }), /requires author role/, "a customer can't move a driver on");
  await assert.rejects(call(merchant, "dispatch")("release_raw_for_testing", { order_original_action: potato, beacon: await currentBeacon() }), /only once they've missed their offer or are late/, "nor can the store before they're due");
  await assert.rejects(call(first, "dispatch")("release_raw_for_testing", { order_original_action: potato }), /fresh proof of the time/, "a driver leaving says when");
  await drop(potato, first);
  assert.equal(await deliveryStatus(customer, potato), "Open", "dropped, it opens to bids again");
  await settlesTo(customer, potato, -FOOD, "the customer's driver pay comes back");
  assert.equal(await balance(first), -FOOD, "the store had started cooking: the driver still answers for the food");
  await driving(potato, second);
  await settlesTo(first, potato, 0, "another driver took it on: the first is clear");
  console.log("[PASS] a driver who leaves a cooked order answers for it, until another driver takes it on");
});
