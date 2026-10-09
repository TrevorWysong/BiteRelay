import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationFor } from "../src/lib/notifications.ts";

const order = new Uint8Array(39).fill(7);

test("a new order rings the store", () => {
  const n = notificationFor({ OrderPlaced: order });
  assert.equal(n?.urgent, true);
  assert.equal(n?.route, "/merchant");
});

test("each side hears an update in its own words", () => {
  const change = { Delivery: { status: "PickedUp" as const, cancellation: null } };
  assert.equal(notificationFor({ OrderUpdated: { order_hash: order, change, role: "Customer" } })?.body, "Your driver picked up your order and is on the way.");
  assert.equal(notificationFor({ OrderUpdated: { order_hash: order, change, role: "Store" } })?.body, "The driver picked up an order.");
  assert.match(notificationFor({ OrderUpdated: { order_hash: order, change, role: "Customer" } })!.route, /^\/customer\/orders\//);
});

test("a cancellation says why", () => {
  const change = { Pickup: { status: "Cancelled" as const, cancellation: { ByStore: "TooBusy" as const } } };
  assert.equal(notificationFor({ OrderUpdated: { order_hash: order, change, role: "Customer" } })?.body, "The store is too busy to take this order right now.");
  const byCustomer = { Pickup: { status: "Cancelled" as const, cancellation: "ByCustomer" as const } };
  assert.equal(notificationFor({ OrderUpdated: { order_hash: order, change: byCustomer, role: "Store" } })?.body, "The customer cancelled an order.");
});

test("steps nobody needs telling about stay quiet", () => {
  // A store hears nothing of its own "ready for pickup" -- it did that.
  const change = { Pickup: { status: "ReadyForPickup" as const, cancellation: null } };
  assert.equal(notificationFor({ OrderUpdated: { order_hash: order, change, role: "Store" } }), null);
});

test("a recorded drop-off asks the customer to confirm it", () => {
  const order = new Uint8Array([7, 7, 7]);
  const n = notificationFor({ HandoffRecorded: order });
  assert.equal(n?.title, "Your order was delivered");
  assert.equal(n?.route, "/customer/orders/070707");
  assert.equal(n?.urgent, true);
});
