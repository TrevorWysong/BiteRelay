import { callZome } from "../client";
import type { ActionHash, AgentPubKey, DeliveryStatus, GeoPoint, HcRecord, WarrantSummary } from "../types";

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
}): Promise<HcRecord> {
  return callZome("dispatch", "request_delivery", { special_instructions: "", tip_cents: 0, ...input });
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

/// The `MerchantToOrder` counterpart -- see orders.rs's doc comment: without
/// this a merchant has no way to discover an order naming them at all.
export async function getOrdersForMerchant(merchant: AgentPubKey): Promise<HcRecord[]> {
  return callZome("dispatch", "get_orders_for_merchant", merchant);
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
  next_after: number | null;
}

export async function listBidsForOrder(orderRef: ActionHash, after: number | null = null): Promise<BidsPage> {
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
