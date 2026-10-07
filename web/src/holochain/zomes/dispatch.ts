import { callZome } from "../client";
import type { ActionHash, AgentPubKey, DeliveryStatus, DropoffPreference, GeoPoint, HcRecord, RecurrenceRule, Timestamp, WarrantSummary } from "../types";

// --- orders ---

export async function requestDelivery(input: {
  merchant: AgentPubKey;
  catalog_ref: ActionHash;
  item_refs: ActionHash[];
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

/// The requester's own `RequesterToOrder` links -- a real DHT read, not a
/// client-side memory of what this browser tab happens to have placed.
export async function getOrdersForRequester(requester: AgentPubKey): Promise<HcRecord[]> {
  return callZome("dispatch", "get_orders_for_requester", requester);
}

/// One store's delivery-order queue (`StoreToOrder`) -- see orders.rs's doc
/// comment: without this a merchant has no way to discover an order at all.
/// A multi-store owner's "all stores" view is one call per store.
export async function getOrdersForStore(catalogRef: ActionHash): Promise<HcRecord[]> {
  return callZome("dispatch", "get_orders_for_store", catalogRef);
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

/// A driver's own authored Bid entries, queried straight off their own
/// source chain -- no link/gossip needed, since they wrote every one of
/// these themselves. The only way a driver's dashboard can answer "which
/// orders am I bidding on/delivering" without client-side memory.
export async function listMyBids(): Promise<HcRecord[]> {
  return callZome("dispatch", "list_my_bids", null);
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

export async function listMyRecurringTemplates(): Promise<HcRecord[]> {
  return callZome("dispatch", "list_my_recurring_templates", null);
}

// --- pickup orders -- no driver, no bid, no dropoff at all. See
// dispatch_integrity::PickupOrder's own doc comment. ---

export async function requestPickupOrder(input: {
  merchant: AgentPubKey;
  catalog_ref: ActionHash;
  item_refs: ActionHash[];
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

export async function getMyPickupOrders(requester: AgentPubKey): Promise<HcRecord[]> {
  return callZome("dispatch", "get_my_pickup_orders", requester);
}

export async function getPickupOrdersForStore(catalogRef: ActionHash): Promise<HcRecord[]> {
  return callZome("dispatch", "get_pickup_orders_for_store", catalogRef);
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
