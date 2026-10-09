import { callZome } from "../client";
import type { ActionHash, AgentPubKey, DeclineReason, DeliveryStatus, DropoffDetails, DropoffPreference, GeoPoint, HcRecord, RecurrenceRule, TemplateDetails, Timestamp, WarrantSummary } from "../types";

// --- orders ---

/// One thing to order, and how many. The zome prices it at the item's
/// latest version.
export interface OrderItemInput {
  item_ref: ActionHash;
  quantity: number;
}

/// `order_total` is the total the customer was shown: the order is refused
/// (with the new total) if the menu's prices no longer add up to it.
export async function requestDelivery(input: {
  merchant: AgentPubKey;
  catalog_ref: ActionHash;
  items: OrderItemInput[];
  order_total: number;
  dropoff: GeoPoint;
  max_delivery_fee: number | null;
  /// A note for the kitchen -- sealed to the store.
  kitchen_notes?: string;
  /// Drop-off instructions -- sealed with the address, for the driver.
  dropoff_notes?: string;
  tip_cents?: number;
  requested_delivery_time?: Timestamp | null;
  promo_code_ref?: ActionHash | null;
  dropoff_preference?: DropoffPreference;
  /// `null` for a normal cart order. Set only when this delivery is
  /// finalizing a confirmed goodie-bag claim -- see
  /// `useClaimFinalization`.
  bag_claim_ref?: ActionHash | null;
}): Promise<HcRecord> {
  return callZome("dispatch", "request_delivery", {
    kitchen_notes: "",
    dropoff_notes: "",
    tip_cents: 0,
    requested_delivery_time: null,
    promo_code_ref: null,
    dropoff_preference: "LeaveAtDoor",
    bag_claim_ref: null,
    ...input,
  });
}

/// The store accepting a delivery order, which opens it to drivers. Refused
/// if the order is priced from an outdated menu -- decline it instead.
export async function acceptDeliveryOrder(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "accept_delivery_order", orderOriginalAction);
}

/// The store turning a delivery down (or calling it off), and why.
export async function declineOrder(orderOriginalAction: ActionHash, reason: DeclineReason): Promise<HcRecord> {
  return callZome("dispatch", "decline_order", { order_original_action: orderOriginalAction, reason });
}

/// The customer withdrawing their delivery.
export async function cancelOrder(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "cancel_order", orderOriginalAction);
}

/// How long a store has to accept an order, in seconds (the DNA's setting).
export async function getStoreResponseSecs(): Promise<number> {
  return callZome("dispatch", "get_store_response_secs", null);
}

/// Every forward transition *except* Delivered (that one's gated -- see
/// `completeDelivery`) and Disputed-resolution (see `dispute.ts`'s
/// apply-resolution calls).
export async function setOrderStatus(orderOriginalAction: ActionHash, nextStatus: DeliveryStatus): Promise<HcRecord> {
  return callZome("dispatch", "set_order_status", { order_original_action: orderOriginalAction, next_status: nextStatus });
}

/// The gated completion path -- cross-zome-verifies both leg attestations
/// exist before flipping the order to Delivered and releasing payment.
export async function completeDelivery(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "complete_delivery", { order_original_action: orderOriginalAction });
}

export async function getOpenOrdersNear(geohash: string): Promise<HcRecord[]> {
  return callZome("dispatch", "get_open_orders_near", geohash);
}

/// Added alongside this client (see HOLOCHAIN_ISSUES.md's note on
/// `get()`-on-`ActionHash` literalness) -- every other order-bearing extern
/// returns the order it just touched, but nothing previously let a client
/// re-fetch a *given*, already-known order later (a page reload, a driver
/// polling their own accepted order, a third party checking status).
export async function getOrder(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "get_order", orderOriginalAction);
}

// --- order queues (see dispatch_integrity::order_queues) ---
//
// Active queues are bounded by current workload, so they're the ones to
// poll; history is paginated and read on demand.

/// One queue entry, either kind of order. `original_action` is the order's
/// stable identity (pass it to every order call); `record` is its latest
/// state, whose own action hash changes on every status update.
export interface OrderEntry {
  kind: "Delivery" | "Pickup";
  original_action: ActionHash;
  record: HcRecord;
}

export interface OrderHistoryPage {
  orders: OrderEntry[];
  next_before: Timestamp | null;
}

/// Every order the store is still working on, oldest first.
export async function getActiveOrdersForStore(catalogRef: ActionHash): Promise<OrderEntry[]> {
  return callZome("dispatch", "get_active_orders_for_store", catalogRef);
}

/// Every order the store has received, newest first -- pass the previous
/// page's `next_before` to continue.
export async function getOrderHistoryForStore(catalogRef: ActionHash, before: Timestamp | null = null, limit: number | null = null): Promise<OrderHistoryPage> {
  return callZome("dispatch", "get_order_history_for_store", { catalog_ref: catalogRef, before, limit });
}

/// The caller's own orders still in progress, oldest first.
export async function getMyActiveOrders(): Promise<OrderEntry[]> {
  return callZome("dispatch", "get_my_active_orders", null);
}

/// The caller's own orders, newest first, a page at a time.
export async function getMyOrderHistory(before: Timestamp | null = null, limit: number | null = null): Promise<OrderHistoryPage> {
  return callZome("dispatch", "get_my_order_history", { before, limit });
}

/// How many of the caller's orders at this store they've completed --
/// what loyalty promos count. A local read of their own chain.
export async function countMyCompletedOrders(catalogRef: ActionHash): Promise<number> {
  return callZome("dispatch", "count_my_completed_orders", catalogRef);
}

/// The order the caller already placed redeeming this goodie-bag claim, if
/// any. A local read of their own chain.
export async function getMyOrderForClaim(claimRef: ActionHash): Promise<ActionHash | null> {
  return callZome("dispatch", "get_my_order_for_claim", claimRef);
}

/// An in-progress delivery and the accepted bid it's being delivered under.
export interface ActiveDelivery {
  order: OrderEntry;
  bid: HcRecord;
}

/// The caller's in-progress deliveries as a driver, oldest first.
export async function getMyActiveDeliveries(): Promise<ActiveDelivery[]> {
  return callZome("dispatch", "get_my_active_deliveries", null);
}

// --- bids ---

/// A driver's bid. It commits the order's required collateral (the value of
/// its food), which they post to the customer at pickup.
export async function submitBid(input: { order_ref: ActionHash; eta_seconds: number; price_offer: number }): Promise<HcRecord> {
  return callZome("dispatch", "submit_bid", input);
}

/// The driver picking the order up: posts their collateral to the customer
/// and marks it picked up, in one step. Returned on delivery.
export async function pickUpOrder(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "pick_up_order", orderOriginalAction);
}

export async function withdrawBid(bidAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "withdraw_bid", { bid_action: bidAction });
}

export async function checkWarrants(agent: AgentPubKey): Promise<WarrantSummary> {
  return callZome("dispatch", "check_warrants", agent);
}

export async function acceptBid(orderOriginalAction: ActionHash, bidAction: ActionHash, overrideWarrants = false): Promise<HcRecord> {
  return callZome("dispatch", "accept_bid", {
    order_original_action: orderOriginalAction,
    bid_action: bidAction,
    override_warrants: overrideWarrants,
  });
}

export interface BidsPage {
  bids: HcRecord[];
  next_after: Timestamp | null;
}

export async function listBidsForOrder(orderRef: ActionHash, after: Timestamp | null = null): Promise<BidsPage> {
  return callZome("dispatch", "list_bids_for_order", { order_ref: orderRef, after });
}

// --- disputes (raised/applied through dispatch, resolved through the
// dispute zome -- see zomes/dispute.ts for submit_resolution/get_dispute) ---

export type DisputeReasonWire = "NeverDelivered" | "WrongOrIncompleteItems" | "ProviderAbandoned" | "Other";

export async function raiseDispute(input: {
  order_original_action: ActionHash;
  reason: DisputeReasonWire;
  description: string;
  evidence_refs: ActionHash[];
}): Promise<HcRecord> {
  return callZome("dispatch", "raise_dispute", input);
}

export async function applyDisputeResolution(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "apply_dispute_resolution", { order_original_action: orderOriginalAction });
}

export async function raiseCancellationDispute(input: {
  order_original_action: ActionHash;
  description: string;
  evidence_refs: ActionHash[];
}): Promise<HcRecord> {
  return callZome("dispatch", "raise_cancellation_dispute", input);
}

export async function applyCancellationDisputeResolution(orderOriginalAction: ActionHash): Promise<void> {
  return callZome("dispatch", "apply_cancellation_dispute_resolution", { order_original_action: orderOriginalAction });
}

// --- chat (signal-only, never persisted -- see chat.rs's own doc comment) ---

export async function sendChatMessage(orderRef: ActionHash, text: string): Promise<void> {
  return callZome("dispatch", "send_chat_message", { order_ref: orderRef, text });
}

// --- live location (signal-only, driver -> requester, never persisted --
// see tracking.rs's own doc comment) ---

export async function sendLocationUpdate(orderRef: ActionHash, lat: number, lon: number): Promise<void> {
  return callZome("dispatch", "send_location_update", { order_ref: orderRef, lat, lon });
}

// --- recurring order templates ("same order every Monday") -- client-
// fired, no p2p cron, see recurring.rs's own doc comment ---

export async function createRecurringTemplate(input: {
  merchant: AgentPubKey;
  catalog_ref: ActionHash;
  item_refs: ActionHash[];
  dropoff: GeoPoint;
  max_delivery_fee: number | null;
  /// A note for the kitchen -- sealed to the store.
  kitchen_notes?: string;
  /// Drop-off instructions -- sealed with the address, for the driver.
  dropoff_notes?: string;
  tip_cents?: number;
  dropoff_preference?: DropoffPreference;
  promo_code_ref?: ActionHash | null;
  recurrence: RecurrenceRule;
  next_run_at: number;
}): Promise<HcRecord> {
  return callZome("dispatch", "create_recurring_template", {
    kitchen_notes: "",
    dropoff_notes: "",
    tip_cents: 0,
    dropoff_preference: "LeaveAtDoor",
    promo_code_ref: null,
    ...input,
  });
}

export async function setRecurringTemplateActive(originalAction: ActionHash, active: boolean): Promise<HcRecord> {
  return callZome("dispatch", "set_recurring_template_active", { original_action: originalAction, active });
}

export async function advanceRecurringTemplate(originalAction: ActionHash, nextRunAt: number): Promise<HcRecord> {
  return callZome("dispatch", "advance_recurring_template", { original_action: originalAction, next_run_at: nextRunAt });
}

/// `original_action` is the template's identity (what the other recurring
/// calls take); `record` is its latest state.
export interface RecurringTemplateView {
  original_action: ActionHash;
  record: HcRecord;
  /// The template's sealed details, opened for its owner.
  details: TemplateDetails | null;
}

/// What the caller may read of an order's sealed details: the drop-off
/// (the customer, and the driver once their bid is accepted) and the
/// kitchen note (the customer and the store).
export interface OrderPrivateDetails {
  dropoff: DropoffDetails | null;
  kitchen_note: string | null;
}

export async function getOrderPrivateDetails(orderOriginalAction: ActionHash): Promise<OrderPrivateDetails> {
  return callZome("dispatch", "get_order_private_details", orderOriginalAction);
}

export async function listMyRecurringTemplates(): Promise<RecurringTemplateView[]> {
  return callZome("dispatch", "list_my_recurring_templates", null);
}

// --- pickup orders -- no driver, no bid, no dropoff at all. See
// dispatch_integrity::PickupOrder's own doc comment. ---

/// See `requestDelivery` for `items` and `order_total`.
export async function requestPickupOrder(input: {
  merchant: AgentPubKey;
  catalog_ref: ActionHash;
  items: OrderItemInput[];
  order_total: number;
  /// A note for the kitchen -- sealed to the store.
  kitchen_notes?: string;
  promo_code_ref?: ActionHash | null;
  bag_claim_ref?: ActionHash | null;
}): Promise<HcRecord> {
  return callZome("dispatch", "request_pickup_order", {
    kitchen_notes: "",
    promo_code_ref: null,
    bag_claim_ref: null,
    ...input,
  });
}

export async function getPickupOrder(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "get_pickup_order", orderOriginalAction);
}

export async function confirmPickupPrep(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "confirm_pickup_prep", orderOriginalAction);
}

export async function markReadyForPickup(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "mark_ready_for_pickup", orderOriginalAction);
}

/// The customer withdrawing their pickup order.
export async function cancelPickupOrder(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "cancel_pickup_order", orderOriginalAction);
}

/// The store turning a pickup order down (or calling it off), and why.
export async function declinePickupOrder(orderOriginalAction: ActionHash, reason: DeclineReason): Promise<HcRecord> {
  return callZome("dispatch", "decline_pickup_order", { order_original_action: orderOriginalAction, reason });
}

/// The gated completion path -- the requester confirming they received it.
export async function completePickup(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "complete_pickup", orderOriginalAction);
}

export type PickupDisputeReasonWire = "NeverDelivered" | "WrongOrIncompleteItems" | "ProviderAbandoned" | "UnjustCancellation" | "Other";

export async function raisePickupDispute(input: {
  order_original_action: ActionHash;
  reason: PickupDisputeReasonWire;
  description: string;
  evidence_refs: ActionHash[];
}): Promise<HcRecord> {
  return callZome("dispatch", "raise_pickup_dispute", input);
}

export async function applyPickupDisputeResolution(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "apply_pickup_dispute_resolution", { order_original_action: orderOriginalAction });
}
