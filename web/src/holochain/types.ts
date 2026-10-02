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
export type LocalSignal =
  | { NewOrderNearby: ActionHash }
  | { BidPlaced: ActionHash }
  | { BidAccepted: ActionHash }
  | { BidReleased: ActionHash };

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
}

export interface ReceiptAttestation {
  leg: ActionHash;
  attested_at: Timestamp;
}

export interface PresenceBeacon {
  provider: AgentPubKey;
  geohash: string;
  capabilities: DeliveryCapability[];
  expires_at: Timestamp;
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
