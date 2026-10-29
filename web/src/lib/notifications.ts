// What to tell someone when something happens on one of their orders, from
// the signal alone -- `post_commit` sends each party what changed and which
// side of the order they're on. Pure, so it's tested on its own; showing it
// is `components/Notifier.tsx`'s job.
import { bytesToHex } from "../holochain/decode";
import type { DeliveryStatus, LocalSignal, OrderChange, OrderRole, PickupStatus } from "../holochain/types";
import type { LiveSignal } from "../holochain/live";
import { cancellationText } from "./storeAnswers";
import { t, type MessageKey } from "../i18n";

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

const deliveryText: Record<OrderRole, Partial<Record<DeliveryStatus, MessageKey>>> = {
  Customer: {
    Open: "notify.delivery.Customer.Open",
    DriverEnRouteToMerchant: "notify.delivery.Customer.DriverEnRouteToMerchant",
    DriverAtStore: "notify.delivery.Customer.DriverAtStore",
    PickedUp: "notify.delivery.Customer.PickedUp",
    Collecting: "notify.delivery.Customer.Collecting",
    Disputed: "notify.delivery.Customer.Disputed",
  },
  Store: {
    DriverEnRouteToMerchant: "notify.delivery.Store.DriverEnRouteToMerchant",
    PickedUp: "notify.delivery.Store.PickedUp",
    Delivered: "notify.delivery.Store.Delivered",
    Disputed: "notify.delivery.Store.Disputed",
  },
  Driver: {
    MerchantConfirmed: "notify.delivery.Driver.MerchantConfirmed",
    DriverAtStore: "notify.delivery.Driver.DriverAtStore",
    Delivered: "notify.delivery.Driver.Delivered",
    Disputed: "notify.delivery.Driver.Disputed",
  },
};

const pickupText: Record<OrderRole, Partial<Record<PickupStatus, MessageKey>>> = {
  Customer: {
    MerchantConfirmed: "notify.pickup.Customer.MerchantConfirmed",
    ReadyForPickup: "notify.pickup.Customer.ReadyForPickup",
    Disputed: "notify.pickup.Customer.Disputed",
  },
  Store: {
    PickedUp: "notify.pickup.Store.PickedUp",
    Disputed: "notify.pickup.Store.Disputed",
  },
  Driver: {},
};

function cancelledText(role: OrderRole, change: OrderChange): string {
  const cancellation = "Delivery" in change ? change.Delivery.cancellation : change.Pickup.cancellation;
  if (role === "Customer") return cancellationText(cancellation);
  if (cancellation === "ByCustomer") return t("notify.cancel.byCustomer");
  if (cancellation === "StoreDidNotRespond") return t("notify.cancel.noResponse");
  if (cancellation === "StoreLate") return t(role === "Driver" ? "notify.cancel.lateDriver" : "notify.cancel.lateStore");
  if (cancellation === "NoDriver") return t(role === "Driver" ? "notify.cancel.noDriverDriver" : "notify.cancel.noDriverStore");
  return t(role === "Driver" ? "notify.cancel.delivery" : "notify.cancel.order");
}

/// The notification a signal calls for, if any.
export function notificationFor(signal: LocalSignal | LiveSignal): AppNotification | null {
  if ("OrderPlaced" in signal) {
    return { title: t("notify.newOrder.title"), body: t("notify.newOrder.body"), tag: `order-${bytesToHex(signal.OrderPlaced)}`, route: "/merchant", urgent: true };
  }
  if ("OrderUpdated" in signal) {
    const { order_hash, change, role } = signal.OrderUpdated;
    const hex = bytesToHex(order_hash);
    const delivery = "Delivery" in change;
    const status = delivery ? change.Delivery.status : change.Pickup.status;
    const key = delivery ? deliveryText[role][change.Delivery.status] : pickupText[role][change.Pickup.status];
    const body = status === "Cancelled" ? cancelledText(role, change) : key && t(key);
    if (!body) return null;
    const route = role === "Customer" ? (delivery ? `/customer/orders/${hex}` : `/customer/pickup-orders/${hex}`) : role === "Store" ? "/merchant" : "/driver";
    return { title: t(status === "Cancelled" ? "notify.cancelled" : "notify.update"), body, tag: `order-${hex}`, route, urgent: false };
  }
  if ("BidPlaced" in signal) {
    return { title: t("notify.bid.title"), body: t("notify.bid.body"), tag: `bid-${bytesToHex(signal.BidPlaced)}`, route: "/customer/orders", urgent: false };
  }
  if ("BidAccepted" in signal) {
    return { title: t("notify.assigned.title"), body: t("notify.assigned.body"), tag: `bid-${bytesToHex(signal.BidAccepted)}`, route: "/driver", urgent: true };
  }
  if ("HandedOver" in signal) {
    return { title: t("notify.handed.title"), body: t("notify.handed.body"), tag: `order-${bytesToHex(signal.HandedOver)}`, route: "/driver", urgent: false };
  }
  if ("CollectRequested" in signal) {
    return { title: t("notify.collecting.title"), body: t("notify.collecting.body"), tag: `order-${bytesToHex(signal.CollectRequested)}`, route: "/merchant", urgent: false };
  }
  if ("ChatMessage" in signal) {
    return { title: t("notify.message"), body: signal.ChatMessage.text, tag: `chat-${bytesToHex(signal.ChatMessage.order_ref)}`, route: "/", urgent: false };
  }
  if ("HandoffRecorded" in signal) {
    const hex = bytesToHex(signal.HandoffRecorded);
    return { title: t("notify.delivered.title"), body: t("notify.delivered.body"), tag: `order-${hex}`, route: `/customer/orders/${hex}`, urgent: true };
  }
  if ("IssueReported" in signal) {
    const hex = bytesToHex(signal.IssueReported);
    return { title: t("notify.issue.title"), body: t("notify.issue.body"), tag: `issue-${hex}`, route: "/merchant", urgent: true };
  }
  if ("ClaimConfirmed" in signal) {
    return { title: t("notify.claim.title"), body: t("notify.claim.body"), tag: `claim-${bytesToHex(signal.ClaimConfirmed)}`, route: "/customer/orders", urgent: false };
  }
  return null;
}
