import { callZome } from "../client";
import type { ActionHash, AgentPubKey, DeliveryStatus, DropoffPreference, GeoPoint, HcRecord, RecurrenceRule, Timestamp, WarrantSummary } from "../types";

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
  special_instructions?: string;
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
    special_instructions: "",
    tip_cents: 0,
    requested_delivery_time: null,
    promo_code_ref: null,
    dropoff_preference: "LeaveAtDoor",
    bag_claim_ref: null,
    ...input,
  });
}

/// The one narrow transition out of `Scheduled` -- see orders.rs's own doc
/// comment: no server-side scheduler exists, the requester's own client is
/// expected to call this once the requested time arrives.
export async function openScheduledOrder(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "open_scheduled_order", orderOriginalAction);
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

export async function submitBid(input: {
  order_ref: ActionHash;
  eta_seconds: number;
  price_offer: number;
  collateral_commitment: { account: string; amount: number; ledger_txn_ref: string };
}): Promise<HcRecord> {
  return callZome("dispatch", "submit_bid", input);
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
  special_instructions?: string;
  tip_cents?: number;
  dropoff_preference?: DropoffPreference;
  promo_code_ref?: ActionHash | null;
  recurrence: RecurrenceRule;
  next_run_at: number;
}): Promise<HcRecord> {
  return callZome("dispatch", "create_recurring_template", {
    special_instructions: "",
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
  special_instructions?: string;
  promo_code_ref?: ActionHash | null;
  bag_claim_ref?: ActionHash | null;
}): Promise<HcRecord> {
  return callZome("dispatch", "request_pickup_order", {
    special_instructions: "",
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

export async function cancelPickupOrder(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "cancel_pickup_order", orderOriginalAction);
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
