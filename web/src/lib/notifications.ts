// What to tell someone when something happens on one of their orders, from
// the signal alone -- `post_commit` sends each party what changed and which
// side of the order they're on. Pure, so it's tested on its own; showing it
// is `components/Notifier.tsx`'s job.
import { bytesToHex } from "../holochain/decode";
import type { DeliveryStatus, LocalSignal, OrderChange, OrderRole, PickupStatus } from "../holochain/types";
import { cancellationText } from "./storeAnswers";

export interface AppNotification {
  title: string;
  body: string;
  /// Replaces an earlier notification about the same thing.
  tag: string;
  /// Where tapping it goes.
  route: string;
  /// A new order waiting on a store: it rings, and shows even with the app
  /// in front.
  urgent: boolean;
}

const deliveryText: Record<OrderRole, Partial<Record<DeliveryStatus, string>>> = {
  Customer: {
    Open: "The store accepted your order. Finding you a driver.",
    MerchantConfirmed: "The store is preparing your order.",
    DriverEnRouteToMerchant: "Your driver is heading to the store.",
    PickedUp: "Your driver picked up your order and is on the way.",
    Disputed: "Your order is being reviewed.",
  },
  Store: {
    BidAccepted: "A driver is assigned. Start preparing the order.",
    DriverEnRouteToMerchant: "The driver is on the way to pick up an order.",
    PickedUp: "The driver picked up an order.",
    Delivered: "An order was delivered.",
    Disputed: "An order is being reviewed.",
  },
  Driver: {
    MerchantConfirmed: "The store is preparing your delivery.",
    Delivered: "Delivery confirmed. You've been paid.",
    Disputed: "A delivery is being reviewed.",
  },
};

const pickupText: Record<OrderRole, Partial<Record<PickupStatus, string>>> = {
  Customer: {
    MerchantConfirmed: "The store accepted your order and is preparing it.",
    ReadyForPickup: "Your order is ready for pickup.",
    Disputed: "Your order is being reviewed.",
  },
  Store: {
    PickedUp: "An order was collected.",
    Disputed: "An order is being reviewed.",
  },
  Driver: {},
};

function cancelledText(role: OrderRole, change: OrderChange): string {
  const cancellation = "Delivery" in change ? change.Delivery.cancellation : change.Pickup.cancellation;
  if (role === "Customer") return cancellationText(cancellation);
  if (cancellation === "ByCustomer") return "The customer cancelled an order.";
  if (cancellation === "StoreDidNotRespond") return "An order wasn't accepted in time and was cancelled.";
  return role === "Driver" ? "A delivery was cancelled." : "An order was cancelled.";
}

/// The notification a signal calls for, if any.
export function notificationFor(signal: LocalSignal): AppNotification | null {
  if ("OrderPlaced" in signal) {
    return { title: "New order", body: "Accept it before the timer runs out.", tag: `order-${bytesToHex(signal.OrderPlaced)}`, route: "/merchant", urgent: true };
  }
  if ("OrderUpdated" in signal) {
    const { order_hash, change, role } = signal.OrderUpdated;
    const hex = bytesToHex(order_hash);
    const delivery = "Delivery" in change;
    const status = delivery ? change.Delivery.status : change.Pickup.status;
    const body = status === "Cancelled" ? cancelledText(role, change) : delivery ? deliveryText[role][change.Delivery.status] : pickupText[role][change.Pickup.status];
    if (!body) return null;
    const route = role === "Customer" ? (delivery ? `/customer/orders/${hex}` : `/customer/pickup-orders/${hex}`) : role === "Store" ? "/merchant" : "/driver";
    return { title: status === "Cancelled" ? "Order cancelled" : "Order update", body, tag: `order-${hex}`, route, urgent: false };
  }
  if ("BidPlaced" in signal) {
    return { title: "New driver bid", body: "A driver offered to deliver your order.", tag: `bid-${bytesToHex(signal.BidPlaced)}`, route: "/customer/orders", urgent: false };
  }
  if ("BidAccepted" in signal) {
    return { title: "Delivery assigned", body: "Your bid was accepted. Head to the store.", tag: `bid-${bytesToHex(signal.BidAccepted)}`, route: "/driver", urgent: true };
  }
  if ("ChatMessage" in signal) {
    return { title: "New message", body: signal.ChatMessage.text, tag: `chat-${bytesToHex(signal.ChatMessage.order_ref)}`, route: "/", urgent: false };
  }
  if ("HandoffRecorded" in signal) {
    const hex = bytesToHex(signal.HandoffRecorded);
    return { title: "Your order was delivered", body: "Confirm you have it, or report a problem.", tag: `order-${hex}`, route: `/customer/orders/${hex}`, urgent: true };
  }
  if ("ClaimConfirmed" in signal) {
    return { title: "Goodie bag confirmed", body: "The store confirmed your goodie bag.", tag: `claim-${bytesToHex(signal.ClaimConfirmed)}`, route: "/customer/orders", urgent: false };
  }
  return null;
}
