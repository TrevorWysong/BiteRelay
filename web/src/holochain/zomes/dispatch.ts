import { callZome } from "../client";
import type { ActionHash, AgentPubKey, AppealView, AppealsPage, Beacon, DeclineReason, DeliveryStatus, DropoffDetails, DropoffPreference, GeoPoint, HcRecord, InHand, IssueItems, IssueLine, IssueView, LineView, NetworkReach, NetworkTerms, OrderDecisions, OrderItem, OrderTiming, PinSecret, RankedBid, Receipt, RecurrenceRule, StoreStep, StoreStepDue, TemplateDetails, Timestamp, VerificationCheck, VerificationTerms, VerificationView, WarrantSummary } from "../types";

// --- orders ---

/// One thing to order -- an item, how many, and its choices (`OrderItem`).
/// The zome prices it at the item's and its choice groups' latest versions.
export type OrderItemInput = OrderItem;

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
  /// The customer accepting that an order left at their door is delivered
  /// once it's left -- required for `LeaveAtDoor`.
  door_risk_accepted?: boolean;
  /// A driver of the customer's own: one carrying no other order.
  priority?: boolean;
  /// Let the app choose a driver from the bids, by the network's rule
  /// (`rankBids`).
  auto_match?: boolean;
  /// `null` for a normal cart order. Set only when this delivery redeems a
  /// confirmed goodie-bag claim -- which the customer's conductor does on
  /// its own (`dispatch::claims`).
  bag_claim_ref?: ActionHash | null;
  /// Wake tokens from the network's push relay (lib/push.ts).
  wake_for_store?: string | null;
  wake_for_driver?: string | null;
}): Promise<HcRecord> {
  return callZome("dispatch", "request_delivery", {
    kitchen_notes: "",
    dropoff_notes: "",
    tip_cents: 0,
    requested_delivery_time: null,
    promo_code_ref: null,
    dropoff_preference: "HandToMe",
    door_risk_accepted: false,
    priority: false,
    bag_claim_ref: null,
    ...input,
  });
}

/// The store accepting a delivery order, which opens it to drivers, and
/// saying when it'll be ready: `prepMinutes` from now, or the store's usual
/// prep time. Refused if the order is priced from an outdated menu --
/// decline it instead.
export async function acceptDeliveryOrder(orderOriginalAction: ActionHash, prepMinutes?: number): Promise<HcRecord> {
  return callZome("dispatch", "accept_delivery_order", { order_original_action: orderOriginalAction, prep_minutes: prepMinutes ?? null });
}

/// The store turning a delivery down (or calling it off), and why.
export async function declineOrder(orderOriginalAction: ActionHash, reason: DeclineReason): Promise<HcRecord> {
  return callZome("dispatch", "decline_order", { order_original_action: orderOriginalAction, reason });
}

/// The itemized receipt for one of the caller's completed orders, with the
/// ledger transactions that paid it.
export async function getOrderReceipt(orderOriginalAction: ActionHash): Promise<Receipt> {
  return callZome("dispatch", "get_order_receipt", orderOriginalAction);
}

/// The customer withdrawing their delivery.
export async function cancelOrder(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "cancel_order", orderOriginalAction);
}

/// A delivery step by the status it moves to: the driver committing
/// (`DriverEnRouteToMerchant`), the store starting to cook
/// (`MerchantConfirmed`), the store checking its driver in
/// (`DriverAtStore`). Each app does these on its own; this is the manual
/// path.
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

/// A driver's bid. If it's accepted, they commit to it with collateral of
/// the food's value -- theirs again once it's delivered. `to_store_seconds`
/// is when they'd reach the store: with its ready time, when they're due.
export async function submitBid(input: { order_ref: ActionHash; eta_seconds: number; to_store_seconds: number; price_offer: number }): Promise<HcRecord> {
  return callZome("dispatch", "submit_bid", input);
}

/// The bids on an order, best first, by the network's published matching
/// rule -- what an order set to match automatically accepts.
export async function rankBids(orderRef: ActionHash): Promise<RankedBid[]> {
  return callZome("dispatch", "rank_bids", orderRef);
}

/// The driver picking the order up, on the store's record of handing it to
/// them. Their app does it on its own as soon as that arrives.
export async function pickUpOrder(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "pick_up_order", orderOriginalAction);
}

export async function withdrawBid(bidAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "withdraw_bid", { bid_action: bidAction });
}

/// The orders a driver has taken on -- assigned or in hand -- and whether
/// one is a priority order.
export async function getDriverLoad(driver: AgentPubKey): Promise<InHand> {
  return callZome("dispatch", "get_driver_load", driver);
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

// Chat and live location go app to app: holochain/live.ts.

/// How far something this agent wrote has got -- `null` unless they wrote
/// it (see reach.rs).
export async function getNetworkReach(actionHash: ActionHash): Promise<NetworkReach | null> {
  return callZome("dispatch", "network_reach", actionHash);
}

// --- recurring order templates ("same order every Monday") -- fired by
// the customer's own conductor when due, see recurring.rs ---

export async function createRecurringTemplate(input: {
  merchant: AgentPubKey;
  catalog_ref: ActionHash;
  items: OrderItem[];
  dropoff: GeoPoint;
  max_delivery_fee: number | null;
  /// A note for the kitchen -- sealed to the store.
  kitchen_notes?: string;
  /// Drop-off instructions -- sealed with the address, for the driver.
  dropoff_notes?: string;
  tip_cents?: number;
  dropoff_preference?: DropoffPreference;
  /// Required for `LeaveAtDoor` -- see `requestDelivery`.
  door_risk_accepted?: boolean;
  /// Each order asks for a driver of its own -- see `requestDelivery`.
  priority?: boolean;
  promo_code_ref?: ActionHash | null;
  recurrence: RecurrenceRule;
  /// The IANA zone `recurrence` is in -- the device's own.
  time_zone: string;
}): Promise<HcRecord> {
  return callZome("dispatch", "create_recurring_template", {
    kitchen_notes: "",
    dropoff_notes: "",
    tip_cents: 0,
    dropoff_preference: "HandToMe",
    door_risk_accepted: false,
    priority: false,
    promo_code_ref: null,
    ...input,
  });
}

export async function setRecurringTemplateActive(originalAction: ActionHash, active: boolean): Promise<HcRecord> {
  return callZome("dispatch", "set_recurring_template_active", { original_action: originalAction, active });
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
  /// The customer's name -- for the customer, the store, and the driver
  /// once assigned.
  customer_name: string | null;
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
  /// The customer confirming their age, for age-restricted items.
  age_confirmed?: boolean;
  /// A wake token from the network's push relay (lib/push.ts).
  wake_for_store?: string | null;
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

/// The store accepting a pickup order -- see `acceptDeliveryOrder`.
export async function acceptPickupOrder(orderOriginalAction: ActionHash, prepMinutes?: number): Promise<HcRecord> {
  return callZome("dispatch", "accept_pickup_order", { order_original_action: orderOriginalAction, prep_minutes: prepMinutes ?? null });
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

/// The customer telling the store they can't get their pickup order. The
/// store then hands it over, or cancels it and returns their money.
export async function reportPickupProblem(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "report_pickup_problem", orderOriginalAction);
}

/// The customer saying their delivery never arrived. The store decides.
export async function claimNeverArrived(orderOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "claim_never_arrived", orderOriginalAction);
}

/// The store deciding now that a claimed delivery never arrived.
export async function decideNotDelivered(orderOriginalAction: ActionHash): Promise<ActionHash> {
  return callZome("dispatch", "decide_not_delivered", orderOriginalAction);
}

/// How an order stands with its store: its outcome, its settlement, and
/// when each is due.
export async function getOrderDecisions(orderRef: ActionHash): Promise<OrderDecisions> {
  return callZome("dispatch", "get_order_decisions", orderRef);
}

/// The store's pickup code for a delivery, to show the driver collecting it.
export async function getMyPickupCode(orderRef: ActionHash): Promise<PinSecret | null> {
  return callZome("dispatch", "get_my_pickup_code", orderRef);
}

/// The caller's handover code for a delivery -- shown as a QR code for the
/// driver to scan at the door.
export async function getMyHandoverCode(orderRef: ActionHash): Promise<PinSecret | null> {
  return callZome("dispatch", "get_my_handover_code", orderRef);
}

// --- missing and wrong items (see the dispatch `issues` module) ---

/// The customer reporting items missing or wrong.
export async function reportIssue(input: { order: ActionHash; lines: IssueLine[]; note: string; photo_data_uri: string }): Promise<HcRecord> {
  return callZome("dispatch", "report_issue", input);
}

/// The store accepting or declining a report -- its answer is final.
export async function respondToIssue(issue: ActionHash, accept: boolean): Promise<HcRecord> {
  return callZome("dispatch", "respond_to_issue", { issue, accept });
}

export async function getIssuesForOrder(orderRef: ActionHash): Promise<IssueView[]> {
  return callZome("dispatch", "get_issues_for_order", orderRef);
}

/// An order's items as reports are made against them, and what the food
/// cost -- readable by its store as well as its customer.
/// An order's lines as people read them: item, quantity, price with its
/// choices, and the choices.
export async function getOrderLines(orderRef: ActionHash): Promise<LineView[]> {
  return callZome("dispatch", "get_order_lines", orderRef);
}

export async function getIssueItems(orderRef: ActionHash): Promise<IssueItems> {
  return callZome("dispatch", "get_issue_items", orderRef);
}

/// The rules this network runs by, from its DNA -- read once while
/// connecting (`store/network`).
export async function getNetworkTerms(): Promise<NetworkTerms> {
  return callZome("dispatch", "get_network_terms", null);
}

// --- a delivery's steps, and when they go wrong (`dispatch::deliveries`) ---

/// The deadlines an order is running against.
export async function getOrderTiming(orderRef: ActionHash): Promise<OrderTiming> {
  return callZome("dispatch", "get_order_timing", orderRef);
}

/// The driver committing to an order whose customer accepted their bid --
/// their app does it on its own; this is the manual path.
export async function commitToOrder(orderRef: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "commit_to_order", orderRef);
}

/// The driver dropping an order before pickup, dated by the network's time
/// source: it opens to bids again.
export async function dropOrder(orderRef: ActionHash, beacon: Beacon): Promise<HcRecord> {
  return callZome("dispatch", "drop_order", { order_ref: orderRef, beacon });
}

/// A checked-in driver calling the store late, with proof of the time.
export async function callStoreLate(orderRef: ActionHash, beacon: Beacon): Promise<HcRecord> {
  return callZome("dispatch", "call_store_late", { order_ref: orderRef, beacon });
}

/// A driver reporting that the store wouldn't check them in.
export async function reportCheckInRefused(orderRef: ActionHash): Promise<void> {
  return callZome("dispatch", "report_check_in_refused", orderRef);
}

/// The customer asking to collect their delivery themselves -- recorded by
/// the store's app as soon as it's allowed.
export async function requestCollect(orderRef: ActionHash): Promise<ActionHash> {
  return callZome("dispatch", "request_collect", orderRef);
}

/// The customer confirming they've collected it.
export async function confirmCollected(orderRef: ActionHash): Promise<HcRecord> {
  return callZome("dispatch", "confirm_collected", orderRef);
}

/// The store handing a collected order over, against the customer's scanned code.
export async function handOverCollection(orderRef: ActionHash, code: PinSecret): Promise<HcRecord> {
  return callZome("dispatch", "hand_over_collection", { order_original_action: orderRef, code });
}

/// The store recording that a customer who chose to collect never came --
/// proved past their window by the time source.
export async function markNotCollected(orderRef: ActionHash, beacon: Beacon): Promise<HcRecord> {
  return callZome("dispatch", "mark_not_collected", { order_ref: orderRef, beacon });
}

/// The caller's stores' steps that are due and need proof of the time --
/// which the store's app takes (`useStoreSteps`).
export async function getStoreStepsDue(): Promise<StoreStepDue[]> {
  return callZome("dispatch", "get_store_steps_due", null);
}

/// Takes one store step, proved past its deadline by `beacon`.
export async function takeStoreStep(step: StoreStep, orderRef: ActionHash, beacon: Beacon): Promise<HcRecord> {
  const fn = { MoveDriverOn: "move_driver_on", RecordCollecting: "record_collecting", EndForNoDriver: "end_for_no_driver" }[step];
  return callZome("dispatch", fn, { order_ref: orderRef, beacon });
}

// --- driver verification ---

/// What the network asks of drivers: whether they're verified before
/// bidding, and who verifies them.
export async function getVerificationTerms(): Promise<VerificationTerms> {
  return callZome("dispatch", "get_verification_terms", null);
}

/// A driver's current verification -- `null` if none stands.
export async function driverVerification(driver: AgentPubKey): Promise<VerificationView | null> {
  return callZome("dispatch", "driver_verification", driver);
}

/// A verifier vouching for a driver they've checked, for `days` (at most
/// the network's limit).
export async function verifyDriver(driver: AgentPubKey, checks: VerificationCheck[], days: number | null): Promise<ActionHash> {
  return callZome("dispatch", "verify_driver", { driver, checks, days });
}

/// A verifier withdrawing their verification.
export async function revokeVerification(verification: ActionHash): Promise<void> {
  return callZome("dispatch", "revoke_verification", verification);
}

// --- appeals of a store's decision ---

/// The customer appealing their store's settlement to the network's arbiter.
export async function fileAppeal(input: { order: ActionHash; amount: number; note: string; photo_data_uri: string }): Promise<ActionHash> {
  return callZome("dispatch", "file_appeal", input);
}

/// The store's side of an appeal, sealed to its arbiter.
export async function answerAppeal(input: { appeal: ActionHash; note: string; photo_data_uri: string }): Promise<ActionHash> {
  return callZome("dispatch", "answer_appeal", input);
}

/// The arbiter's ruling: `award` (zero dismisses it), and why.
export async function ruleOnAppeal(input: { appeal: ActionHash; award: number; reasons: string }): Promise<ActionHash> {
  return callZome("dispatch", "rule_on_appeal", input);
}

export async function getAppealForOrder(order: ActionHash): Promise<AppealView | null> {
  return callZome("dispatch", "get_appeal_for_order", order);
}

/// The appeals before the caller, an arbiter -- newest first, a page at a
/// time, open ones first in each; pass a page's `next_before` to continue.
export async function getMyDocket(before: Timestamp | null = null): Promise<AppealsPage> {
  return callZome("dispatch", "get_my_docket", { before });
}

/// Appeals of the caller's decisions as a store owner, paged the same way.
export async function getAppealsAgainstMe(before: Timestamp | null = null): Promise<AppealsPage> {
  return callZome("dispatch", "get_appeals_against_me", { before });
}
