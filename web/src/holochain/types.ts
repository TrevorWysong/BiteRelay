// Shared wire types mirroring the Rust structs in relay_types / dispatch_types
// / dispute_types / profiles / catalog etc. Field names and casing here must
// match the msgpack-serialized Rust structs exactly (serde's default is
// snake_case, so these types intentionally use snake_case fields even though
// that's unusual for hand-written TS).

export type ActionHash = Uint8Array;
export type EntryHash = Uint8Array;
export type AgentPubKey = Uint8Array;
export type Timestamp = number; // microseconds since epoch, matching HDK's Timestamp wire form

// `dispatch_coordinator::signals::LocalSignal` -- what actually arrives over
// the app websocket's "signal" event, re-emitted by `recv_remote_signal`
// once it's handled the network-level `RemoteSignal`. These are Rust tuple
// variants (`NewOrderNearby(ActionHash)`), which serde serializes as
// `{ "VariantName": <value> }` -- the payload is the bare ActionHash, not a
// nested `{order_hash: ...}` object.
// `ChatMessage` is a Rust *struct* variant (named fields), unlike the tuple
// variants above, so it serializes as a nested object rather than a bare
// value -- `{ ChatMessage: { order_ref, from, text, sent_at } }`.
export type LocalSignal =
  | { NewOrderNearby: ActionHash }
  | { BidPlaced: ActionHash }
  | { BidAccepted: ActionHash }
  | { BidReleased: ActionHash }
  | { ChatMessage: { order_ref: ActionHash; from: AgentPubKey; text: string; sent_at: Timestamp } }
  | { LocationUpdate: { order_ref: ActionHash; lat: number; lon: number; sent_at: Timestamp } }
  | { PickupReady: ActionHash }
  /// `catalog_coordinator::signals::LocalSignal` -- see `bags::confirm_claim`.
  /// Arrives on the same app websocket as every signal above, just from a
  /// different zome's own `recv_remote_signal`.
  | { ClaimConfirmed: ActionHash };

export interface GeoPoint {
  lat: number;
  lon: number;
}

export type RoleTag = "Requester" | "Merchant" | "Provider";

export type DeliveryCapability = "Food" | "Goods";

// `Profile` the entry has no agent field of its own -- ownership comes from
// the AgentToProfile link base it's linked under (create_profile links
// `agent_info().agent_initial_pubkey -> action_hash`). Client code that
// needs "whose profile is this" alongside the decoded entry should carry
// the agent key separately (see ProfileWithAgent below), not expect it on
// the struct itself -- Rust's `profiles_integrity::Profile` genuinely has
// no such field.
export interface Profile {
  display_name: string;
  roles: RoleTag[];
  created_at: Timestamp;
  bio: string;
  /// A `data:image/...;base64,...` URI, not a hosted URL -- there's no image
  /// host in this system. Empty string means no avatar set.
  avatar_data_uri: string;
  phone: string;
}

export interface ProfileWithAgent {
  agent: AgentPubKey;
  profile: Profile;
  actionHash: ActionHash;
}

export interface ProviderCredential {
  profile_action: ActionHash;
  vehicle_description: string;
  capabilities: DeliveryCapability[];
  verified: boolean;
  license_plate: string;
  photo_data_uri: string;
}

export interface MerchantCatalog {
  owner: AgentPubKey;
  business_name: string;
  location: GeoPoint;
  geohash: string;
  is_open: boolean;
  description: string;
  cuisine_type: string;
  banner_data_uri: string;
  phone: string;
  address_line: string;
  hours_open: string;
  hours_close: string;
  /// The standard delivery-cost-sharing model (architecture plan §12,
  /// 2026-10-01 revision), 0-100 -- share of a winning bid's delivery fee
  /// this merchant covers, applied proportionally at settlement. Defaults
  /// to 50 (an even split with the customer) at catalog creation.
  delivery_subsidy_percent: number;
  /// Sorted, deduplicated union of every available menu item's own
  /// `dietary_tags`, maintained server-side by `add_menu_item`/
  /// `update_menu_item` -- never set directly. Lets Browse filter by
  /// dietary tag without fetching every candidate's full menu.
  dietary_tags: string[];
}

// `PromoRequirement`/`PromoReward` mirror `catalog_types`' Rust enums --
// see that crate's doc comments for why requirement and reward are two
// independent axes rather than one flat discount value (a plain code,
// "spend $X get item Y free," and buy-X-get-Y-free/BOGO deals are all just
// different (requirement, reward) pairs, not distinct hardcoded promo
// types). `None` is a bare unit variant (`"None"`, a plain string, same
// serde shape as `BidStatus`/`DeliveryStatus` below) -- the rest are tuple
// or struct variants (`{ VariantName: value }`).
export type PromoRequirement =
  | "None"
  | { MinimumSpend: number }
  | { MinimumItemQuantity: { item_ref: ActionHash; quantity: number } }
  | { LoyaltyOrderCount: number };

export type PromoReward =
  | { PercentOffSubtotal: number }
  | { FlatOffSubtotal: number }
  | { FreeItem: { item_ref: ActionHash; quantity: number } }
  | { PercentOffItem: { item_ref: ActionHash; percent: number; quantity: number } };

export interface PromoCode {
  catalog_ref: ActionHash;
  code: string;
  requirement: PromoRequirement;
  reward: PromoReward;
  active: boolean;
  expires_at: Timestamp | null;
  created_at: Timestamp;
  /// When true, an eligible customer gets this applied without typing a
  /// code -- the mechanism loyalty rewards need. Orthogonal to any
  /// specific requirement/reward combo.
  auto_apply: boolean;
}

export interface MenuItem {
  catalog_ref: ActionHash;
  name: string;
  price_cents: number;
  available: boolean;
  description: string;
  photo_data_uri: string;
  category: string;
  dietary_tags: string[];
}

export type DeliveryStatus =
  | "Scheduled"
  | "Open"
  | "BidAccepted"
  | "MerchantConfirmed"
  | "DriverEnRouteToMerchant"
  | "PickedUp"
  | "Delivered"
  | "Cancelled"
  | "Disputed";

export interface DeliveryOrder {
  requester: AgentPubKey;
  merchant: AgentPubKey;
  catalog_ref: ActionHash;
  item_refs: ActionHash[];
  order_total: number;
  dropoff: GeoPoint;
  dropoff_geohash: string;
  max_delivery_fee: number | null;
  status: DeliveryStatus;
  accepted_bid: ActionHash | null;
  delivery_receipts: ActionHash[];
  dispute_ref: ActionHash | null;
  requested_at: Timestamp;
  special_instructions: string;
  tip_cents: number;
  /// `null` means "order now." Set means this order starts in `Scheduled`
  /// status, invisible to matching until `open_scheduled_order` is called
  /// at/after this time.
  requested_delivery_time: Timestamp | null;
  /// `null` means no promo code applied.
  promo_code_ref: ActionHash | null;
  dropoff_preference: DropoffPreference;
  /// `null` for an ordinary menu order. Set means this delivery originated
  /// from a confirmed goodie-bag claim rather than a normal cart checkout.
  bag_claim_ref: ActionHash | null;
}

/// A limited-quantity, time-windowed, discounted mystery bag of surplus
/// food -- see `catalog_types::GoodieBag`'s own doc comment for why it's
/// deliberately not itemized (contents are the merchant's own call at
/// pack time).
export interface GoodieBag {
  catalog_ref: ActionHash;
  title: string;
  description: string;
  photo_data_uri: string;
  original_value_cents: number;
  price_cents: number;
  quantity_total: number;
  pickup_window_start: Timestamp;
  pickup_window_end: Timestamp;
  supports_pickup: boolean;
  supports_delivery: boolean;
  created_at: Timestamp;
}

/// Captured once, up front, so confirmation can finalize automatically into
/// a real order -- see `BagClaim`'s own Rust doc comment.
export type BagClaimFulfillment = "Pickup" | { Delivery: { dropoff: GeoPoint; max_delivery_fee: number | null } };

export type BagClaimStatus = "Pending" | "Confirmed";

export interface BagClaim {
  bag_ref: ActionHash;
  customer: AgentPubKey;
  fulfillment: BagClaimFulfillment;
  status: BagClaimStatus;
  claimed_at: Timestamp;
}

export type DropoffPreference = "LeaveAtDoor" | "HandToMe" | "MeetOutside";

export type PickupStatus = "Placed" | "MerchantConfirmed" | "ReadyForPickup" | "PickedUp" | "Cancelled" | "Disputed";

/// `PickupOrder`'s own, much smaller lifecycle -- no driver, no bid, no
/// dropoff at all. See `dispatch_integrity::PickupOrder`'s own doc comment.
export interface PickupOrder {
  requester: AgentPubKey;
  merchant: AgentPubKey;
  catalog_ref: ActionHash;
  item_refs: ActionHash[];
  order_total: number;
  status: PickupStatus;
  dispute_ref: ActionHash | null;
  requested_at: Timestamp;
  special_instructions: string;
  promo_code_ref: ActionHash | null;
  bag_claim_ref: ActionHash | null;
}

export type BidStatus = "Open" | "Accepted" | "Withdrawn" | "Expired" | "Rejected";

export interface LedgerCommitmentRef {
  account: string;
  amount: number;
  ledger_txn_ref: string;
}

export interface Bid {
  order_ref: ActionHash;
  bidder: AgentPubKey;
  eta_seconds: number;
  price_offer: number;
  collateral_commitment: LedgerCommitmentRef;
  status: BidStatus;
  created_at: Timestamp;
}

export type DisputeStatus = "Open" | "Resolved";

export type DisputeReason =
  | "NeverDelivered"
  | "WrongOrIncompleteItems"
  | "ProviderAbandoned"
  | "UnjustCancellation"
  | "Other";

export type DisputeOutcome =
  | { FavorProvider: { forfeit_amount: number } }
  | { FavorRequester: { forfeit_amount: number } };

export interface Dispute {
  order_ref: ActionHash;
  raised_by: AgentPubKey;
  respondent: AgentPubKey;
  reason: DisputeReason;
  description: string;
  evidence_refs: ActionHash[];
  status: DisputeStatus;
  outcome: DisputeOutcome | null;
  arbitrator: AgentPubKey | null;
  reasoning: string | null;
  raised_at: Timestamp;
  resolved_at: Timestamp | null;
}

export interface WarrantSummary {
  count: number;
  has_chain_fork: boolean;
  has_invalid_chain_op: boolean;
}

export interface ReputationSummary {
  completed_count: number;
  cancelled_by_them_count: number;
  dispute_raised_count: number;
  dispute_resolved_against_count: number;
  total_collateral_forfeited: number;
}

export interface Review {
  subject: AgentPubKey;
  author: AgentPubKey;
  order_ref: ActionHash;
  rating: number;
  comment: string;
  created_at: Timestamp;
}

export interface ItemReview {
  item_ref: ActionHash;
  author: AgentPubKey;
  order_ref: ActionHash;
  rating: number;
  comment: string;
  created_at: Timestamp;
}

export type ReputationEventKind =
  | { OrderCompleted: { subject_role: "Requester" | "Provider" | "Merchant" } }
  | "OrderCancelledByThem"
  | "DisputeRaised"
  | "DisputeResolvedAgainst"
  | { CollateralForfeited: { amount: number } };

export type LegKind = "MerchantHandoff" | "CustomerHandoff";

export interface Leg {
  order_ref: ActionHash;
  sequence: number;
  kind: LegKind;
  from: AgentPubKey;
  to: AgentPubKey;
  geo_at_completion: GeoPoint;
  completed_at: Timestamp;
  /// A data URI, or "" for no photo -- see the Rust `Leg.photo_data_uri`
  /// doc comment for why this is deliberately outside the countersigned
  /// `ReceiptAttestation` payload.
  photo_data_uri: string;
}

export interface ReceiptAttestation {
  leg: ActionHash;
  attested_at: Timestamp;
}

// `RecurrenceRule` mirrors dispatch_integrity's Rust enum -- struct
// variants, so `{ Daily: { hour, minute } }` / `{ Weekly: { weekday, hour,
// minute } }`.
export type RecurrenceRule = { Daily: { hour: number; minute: number } } | { Weekly: { weekday: number; hour: number; minute: number } };

export interface RecurringOrderTemplate {
  requester: AgentPubKey;
  merchant: AgentPubKey;
  catalog_ref: ActionHash;
  item_refs: ActionHash[];
  dropoff: GeoPoint;
  max_delivery_fee: number | null;
  special_instructions: string;
  tip_cents: number;
  dropoff_preference: DropoffPreference;
  promo_code_ref: ActionHash | null;
  recurrence: RecurrenceRule;
  next_run_at: Timestamp;
  active: boolean;
  created_at: Timestamp;
}

export interface PresenceBeacon {
  provider: AgentPubKey;
  geohash: string;
  capabilities: DeliveryCapability[];
  expires_at: Timestamp;
}

export type TxnReason = "Payment" | "CollateralForfeit";

export interface LedgerTransaction {
  from: AgentPubKey;
  to: AgentPubKey;
  amount: number;
  reason: TxnReason;
  related_order: ActionHash;
  created_at: Timestamp;
}

export interface NearbyProvider {
  provider: AgentPubKey;
  capabilities: DeliveryCapability[];
}

// A HcRecord as seen client-side -- callZome results carrying an entry
// always come back in this shape; `decodeEntry` below pulls the actual
// struct out.
export interface HcRecord {
  signed_action: { hashed: { hash: ActionHash; content: { author: AgentPubKey; timestamp: Timestamp } } };
  entry: { Present?: { entry_type: string; entry: Uint8Array | [unknown, Uint8Array] } } | "NotApplicable" | "Hidden" | "NotStored";
}
