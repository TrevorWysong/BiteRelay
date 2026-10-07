//! Integrity zome for the delivery order lifecycle: `DeliveryOrder` (with
//! its state-machine transition table, `DeliveryStatus::can_transition_to`)
//! and `Bid` -- see `DeliveryOrder`'s doc comment for why this is a
//! concrete entry type rather than one generalized "Job".

use attestation_types::{Leg, LegKind, ReceiptAttestation};
use catalog_types::{BagClaim, BagClaimFulfillment, MerchantCatalog, PromoCode};
use dispute_types::{Dispute, DisputeOutcome, DisputeStatus};
use hdi::prelude::*;
use relay_types::GeoPoint;

mod store_queue;
pub use store_queue::{history_day, store_history_day, store_history_root, HISTORY_BUCKET_MICROS};
use store_queue::{validate_queue_link_create, validate_queue_link_delete, OpLinkFields};

// DeliveryStatus/RequiredAuthor/BidStatus/DeliveryOrder/Bid now live in
// dispatch_types so dispute_integrity can decode a DeliveryOrder too, for
// its own dispute-eligibility validation -- see that crate's doc comment
// for why a direct dependency on this crate wouldn't work. Re-exported here
// so nothing else in this crate or the coordinator crate (which imports via
// `dispatch_integrity::*`) needs to change.
pub use dispatch_types::{Bid, BidStatus, DeliveryOrder, DeliveryStatus, DropoffPreference, PickupOrder, PickupStatus, RequiredAuthor};

/// How often a `RecurringOrderTemplate` fires. Deliberately just these two
/// shapes -- the literal "same order every Monday" ask, plus daily as the
/// same shape with no weekday -- not a general cron expression, which
/// would need real per-agent timezone handling this app doesn't otherwise
/// carry anywhere (every `Timestamp` here is bare microseconds-since-epoch,
/// with no timezone concept at all -- the *client* that created the
/// template is responsible for meaning "9am in my own local time" when it
/// picks `hour`/`minute`, same as `requested_delivery_time` already is for
/// one-shot scheduled orders).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum RecurrenceRule {
    Daily { hour: u8, minute: u8 },
    Weekly { weekday: u8, hour: u8, minute: u8 },
}

/// A customer's own saved "repeat this order" recipe. Deliberately a plain
/// entry with **no DHT link at all** -- nobody but the owner ever needs to
/// discover these, so `list_my_recurring_templates` is a local chain
/// `query()`, the same zero-anchor-growth shape as
/// `attestation::list_my_receipts`, not a `get_links` anchor like
/// `DeliveryOrder` itself needs for matching. There is no p2p cron here
/// (and couldn't be, deterministically) -- see
/// `DeliveryOrder.requested_delivery_time`'s own doc comment for the
/// identical reasoning already applied to one-shot scheduled orders.
/// Firing is entirely client-driven: the requester's own client checks
/// `next_run_at` on a timer while the app is open and calls
/// `dispatch::request_delivery` + `advance_recurring_template` itself --
/// this entry is just the durable recipe plus bookkeeping, never an active
/// process.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct RecurringOrderTemplate {
    pub requester: AgentPubKey,
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    pub item_refs: Vec<ActionHash>,
    pub dropoff: GeoPoint,
    pub max_delivery_fee: Option<u64>,
    #[serde(default)]
    pub special_instructions: String,
    #[serde(default)]
    pub tip_cents: u64,
    #[serde(default)]
    pub dropoff_preference: DropoffPreference,
    #[serde(default)]
    pub promo_code_ref: Option<ActionHash>,
    pub recurrence: RecurrenceRule,
    /// Set once at creation, then advanced forward by
    /// `advance_recurring_template` every time the template fires --
    /// exactly like `next_page_cursor` advances a pagination cursor, the
    /// one field (besides `active`) this entry's update is allowed to
    /// change.
    pub next_run_at: Timestamp,
    pub active: bool,
    pub created_at: Timestamp,
}

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    DeliveryOrder(DeliveryOrder),
    Bid(Bid),
    RecurringOrderTemplate(RecurringOrderTemplate),
    PickupOrder(PickupOrder),
}

#[hdk_link_types]
pub enum LinkTypes {
    RequesterToOrder,
    OpenOrderGeohashAnchor,
    OrderToBid,
    /// `PickupOrder`'s discovery links -- no geohash anchor and no signal
    /// fan-out needed (see `PickupOrder`'s own doc comment: there's no
    /// driver to notify), just the same direct requester/merchant
    /// discoverability `DeliveryOrder` also has via its own two link types.
    RequesterToPickupOrder,
    /// A store's order queues, keyed by the store (its `catalog_ref`), not
    /// the merchant agent -- one owner can run several stores, and each
    /// store has its own queue, the way each DoorDash/Uber Eats location's
    /// tablet only shows that location's orders. Both order types share
    /// them. See `store_queue` for the active/history split.
    StoreToActiveOrder,
    /// Day-bucket anchor path links under a store's history root.
    StoreHistoryPath,
    /// From a store's day bucket to each order placed that day.
    StoreHistoryToOrder,
}

/// An order (or recurring template) names both a `merchant` and the store
/// (`catalog_ref`) it's from -- and every per-store thing downstream (the
/// store's order queue, its reviews, its reputation events) trusts that
/// the two agree. `catalog_ref` is a catalog's original creation action
/// and its `owner` never changes, so the literal record
/// `must_get_valid_record` returns is the correct reference point.
fn check_merchant_owns_catalog(merchant: &AgentPubKey, catalog_ref: &ActionHash) -> ExternResult<Option<String>> {
    let record = must_get_valid_record(catalog_ref.clone())?;
    let Ok(Some(catalog)) = record.entry().to_app_option::<MerchantCatalog>() else {
        return Ok(Some("catalog_ref does not point at a MerchantCatalog entry".into()));
    };
    if &catalog.owner != merchant {
        return Ok(Some("merchant must be the owner of catalog_ref's store".into()));
    }
    Ok(None)
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::DeliveryOrder(order) => validate_new_order(&order, action.author(), action.timestamp()),
            EntryTypes::Bid(bid) => validate_new_bid(&bid, action.author()),
            EntryTypes::RecurringOrderTemplate(template) => validate_new_recurring_template(&template, action.author()),
            EntryTypes::PickupOrder(order) => validate_new_pickup_order(&order, action.author()),
        },
        FlatOp::CreateEntry(OpEntry::UpdateEntry { app_entry, action }) => match app_entry {
            EntryTypes::DeliveryOrder(order) => {
                validate_order_transition(&order, action.author(), &action.original_action_address, action.timestamp())
            }
            EntryTypes::Bid(bid) => validate_bid_update(&bid, action.author()),
            EntryTypes::RecurringOrderTemplate(template) => {
                validate_recurring_template_update(&template, action.author(), &action.original_action_address)
            }
            EntryTypes::PickupOrder(order) => validate_pickup_order_transition(&order, action.author(), &action.original_action_address),
        },
        FlatOp::Link(OpLink::CreateLink { link_type, action }) => validate_queue_link_create(OpLinkFields {
            link_type: &link_type,
            base: &action.base_address,
            target: &action.target_address,
            author: action.author(),
        }),
        FlatOp::Link(OpLink::DeleteLink { link_type, original_action, action }) => validate_queue_link_delete(OpLinkFields {
            link_type: &link_type,
            base: &original_action.base_address,
            target: &original_action.target_address,
            author: action.author(),
        }),
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_recurrence(recurrence: &RecurrenceRule) -> Option<&'static str> {
    match recurrence {
        RecurrenceRule::Daily { hour, minute } if *hour > 23 || *minute > 59 => Some("Daily's hour must be 0-23 and minute must be 0-59"),
        RecurrenceRule::Daily { .. } => None,
        RecurrenceRule::Weekly { weekday, hour, minute } if *weekday > 6 || *hour > 23 || *minute > 59 => {
            Some("Weekly's weekday must be 0-6, hour must be 0-23, and minute must be 0-59")
        }
        RecurrenceRule::Weekly { .. } => None,
    }
}

fn validate_new_recurring_template(template: &RecurringOrderTemplate, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if &template.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a recurring order template can only be authored by its own requester".into(),
        ));
    }
    if template.item_refs.is_empty() {
        return Ok(ValidateCallbackResult::Invalid("item_refs must not be empty".into()));
    }
    if let Some(reason) = validate_recurrence(&template.recurrence) {
        return Ok(ValidateCallbackResult::Invalid(reason.into()));
    }
    if let Some(reason) = check_merchant_owns_catalog(&template.merchant, &template.catalog_ref)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Only `active` and `next_run_at` may change -- the recipe itself
/// (merchant, items, dropoff, ...) is fixed at creation, mirroring
/// `PromoCode`'s "only active may change" immutability pattern, with one
/// addition: `next_run_at` must be allowed to advance too, since that's
/// exactly what firing the template is supposed to do each time.
fn validate_recurring_template_update(
    template: &RecurringOrderTemplate,
    author: &AgentPubKey,
    original_action_hash: &ActionHash,
) -> ExternResult<ValidateCallbackResult> {
    if &template.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a recurring order template can only be updated by its own requester".into(),
        ));
    }
    let prior_record = must_get_valid_record(original_action_hash.clone())?;
    let prior: RecurringOrderTemplate = prior_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "original_action_hash does not point at a RecurringOrderTemplate entry".into()
        )))?;
    let unchanged = prior.requester == template.requester
        && prior.merchant == template.merchant
        && prior.catalog_ref == template.catalog_ref
        && prior.item_refs == template.item_refs
        && prior.dropoff == template.dropoff
        && prior.max_delivery_fee == template.max_delivery_fee
        && prior.special_instructions == template.special_instructions
        && prior.tip_cents == template.tip_cents
        && prior.dropoff_preference == template.dropoff_preference
        && prior.promo_code_ref == template.promo_code_ref
        && prior.recurrence == template.recurrence
        && prior.created_at == template.created_at;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "a recurring order template update may only change active/next_run_at -- every other field must stay the same".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_new_order(order: &DeliveryOrder, author: &AgentPubKey, action_timestamp: Timestamp) -> ExternResult<ValidateCallbackResult> {
    if &order.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a delivery order can only be authored by its own requester".into(),
        ));
    }
    if order.item_refs.is_empty() {
        return Ok(ValidateCallbackResult::Invalid("an order must reference at least one item".into()));
    }
    if order.order_total == 0 {
        return Ok(ValidateCallbackResult::Invalid("order_total must be greater than zero".into()));
    }
    match (&order.status, order.requested_delivery_time) {
        (DeliveryStatus::Open, None) => {}
        (DeliveryStatus::Scheduled, Some(_)) => {}
        _ => {
            return Ok(ValidateCallbackResult::Invalid(
                "a new order must start Open with no requested_delivery_time, or Scheduled with one set".into(),
            ))
        }
    }
    if order.accepted_bid.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new order cannot already have an accepted bid".into()));
    }
    if !order.delivery_receipts.is_empty() {
        return Ok(ValidateCallbackResult::Invalid("a new order cannot already have delivery receipts".into()));
    }
    if order.dispute_ref.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new order cannot already have a dispute_ref".into()));
    }
    if let Some(reason) = check_merchant_owns_catalog(&order.merchant, &order.catalog_ref)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    // Only checks facts that are genuinely *immutable* once a PromoCode is
    // created (which merchant it belongs to, its fixed expiry) -- NOT
    // `active`, even though that field exists on the same entry.
    // `must_get_valid_record` is deterministic but literal: it always
    // returns the entry *as created*, and `active` always starts `true`
    // (see `create_promo_code`), so checking it here would silently never
    // catch a later deactivation -- the exact same "get() never resolves to
    // latest" trap this codebase has already hit for dispute timing and
    // warrants. There is no deterministic way to ask "what is this *other*
    // entry's current state" inside validate() -- forward-chain walking is
    // exactly the non-deterministic query it can't depend on. "Is this code
    // still active" is therefore a coordinator-level, best-effort check
    // only (`dispatch::request_delivery`'s own pre-check, same trust tier
    // as `check_warrants`), not enforced here. The discount's arithmetic
    // effect on `order_total` is also not independently re-derived here --
    // there's no deterministic way to recompute "what the undiscounted
    // total should have been" without passing full cart contents into
    // validate(), and `order_total` itself already has no such check today
    // (a known, pre-existing, separate trust gap).
    if let Some(promo_ref) = &order.promo_code_ref {
        let promo_record = must_get_valid_record(promo_ref.clone())?;
        let promo: PromoCode = promo_record
            .entry()
            .to_app_option()
            .map_err(|e| wasm_error!(e))?
            .ok_or(wasm_error!(WasmErrorInner::Guest(
                "promo_code_ref does not point at a PromoCode entry".into()
            )))?;
        if promo.catalog_ref != order.catalog_ref {
            return Ok(ValidateCallbackResult::Invalid(
                "promo_code_ref does not belong to this order's merchant".into(),
            ));
        }
        if let Some(expires) = promo.expires_at {
            if action_timestamp >= expires {
                return Ok(ValidateCallbackResult::Invalid("promo code has expired".into()));
            }
        }
    }
    // `must_get_valid_record` is literal, like `hdi`'s every other read --
    // it returns exactly the record at `claim_ref`'s own action hash, never
    // "whatever it was most recently updated to" (see `resolve_latest`'s
    // own doc comment for the general shape of this gap). `BagClaim.status`
    // is exactly the field `catalog::confirm_claim` updates, so checking
    // "is it Confirmed" via this literal fetch would almost always see the
    // original `Pending` content instead -- the exact same trap already
    // named for `promo_code_ref.active` above, for the same reason (`active`
    // is also mutated via a later `update_entry`, after the record's
    // original creation). So, also like `active`, "is this claim actually
    // Confirmed" is NOT checked here -- it's a coordinator-level,
    // non-deterministic pre-check in `request_delivery` instead (cross-zome
    // `catalog::get_bag_claim`, which calls `resolve_latest`). What *is*
    // checkable here are `customer`/`fulfillment`, since those are set once
    // at creation and never touched by `confirm_claim`'s own update (see
    // `validate_claim_confirmation`'s own "every other field must stay the
    // same" check) -- so whatever this literal fetch sees for them is
    // already correct, confirmed or not.
    if let Some(claim_ref) = &order.bag_claim_ref {
        let claim_record = must_get_valid_record(claim_ref.clone())?;
        let claim: BagClaim = claim_record
            .entry()
            .to_app_option()
            .map_err(|e| wasm_error!(e))?
            .ok_or(wasm_error!(WasmErrorInner::Guest(
                "bag_claim_ref does not point at a BagClaim entry".into()
            )))?;
        if claim.customer != order.requester {
            return Ok(ValidateCallbackResult::Invalid(
                "bag_claim_ref's own customer must match this order's requester".into(),
            ));
        }
        if !matches!(claim.fulfillment, BagClaimFulfillment::Delivery { .. }) {
            return Ok(ValidateCallbackResult::Invalid(
                "bag_claim_ref was not claimed for delivery".into(),
            ));
        }
    }
    Ok(ValidateCallbackResult::Valid)
}

/// `PickupOrder`'s sibling of `validate_new_order` -- same shape, minus
/// every check that only makes sense once a driver is in the loop
/// (dropoff/geohash, accepted_bid, delivery_receipts all simply don't
/// exist on this entry type at all, so there's nothing to check there).
fn validate_new_pickup_order(order: &PickupOrder, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if &order.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a pickup order can only be authored by its own requester".into(),
        ));
    }
    if order.item_refs.is_empty() {
        return Ok(ValidateCallbackResult::Invalid("an order must reference at least one item".into()));
    }
    if order.order_total == 0 {
        return Ok(ValidateCallbackResult::Invalid("order_total must be greater than zero".into()));
    }
    if order.status != PickupStatus::Placed {
        return Ok(ValidateCallbackResult::Invalid("a new pickup order must start Placed".into()));
    }
    if order.dispute_ref.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new pickup order cannot already have a dispute_ref".into()));
    }
    if let Some(reason) = check_merchant_owns_catalog(&order.merchant, &order.catalog_ref)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    // promo_code_ref check deliberately omitted from this first pass --
    // see validate_new_order's own doc comment for the full reasoning on
    // why this is coordinator-level/best-effort anyway; wiring promo
    // support into pickup orders is a separate, later addition, not part
    // of this entry type's initial shape.
    //
    // bag_claim_ref *is* checked here, symmetrically with validate_new_order's
    // own check -- same reasoning, "claimed for pickup" instead of delivery,
    // and the same "can't check `status` deterministically" exemption (see
    // validate_new_order's own doc comment for why -- `must_get_valid_record`
    // is literal, and `status` is exactly the field `confirm_claim` updates).
    // Named gap shared by both order types, not solved here: nothing stops
    // the same Confirmed claim from being spent on two separate orders (no
    // claim -> order back-link exists to detect that). Same honestly-named
    // trust tier as `confirm_claim`'s own re-derived quantity_total count --
    // low-stakes (at most a merchant over-delivers one extra bag's worth of
    // food, no money moves twice, since each resulting order still settles
    // its own independently-authored order_total), not worth a new link
    // type/redeemed-flag mechanism for this first pass.
    if let Some(claim_ref) = &order.bag_claim_ref {
        let claim_record = must_get_valid_record(claim_ref.clone())?;
        let claim: BagClaim = claim_record
            .entry()
            .to_app_option()
            .map_err(|e| wasm_error!(e))?
            .ok_or(wasm_error!(WasmErrorInner::Guest(
                "bag_claim_ref does not point at a BagClaim entry".into()
            )))?;
        if claim.customer != order.requester {
            return Ok(ValidateCallbackResult::Invalid(
                "bag_claim_ref's own customer must match this order's requester".into(),
            ));
        }
        if claim.fulfillment != BagClaimFulfillment::Pickup {
            return Ok(ValidateCallbackResult::Invalid(
                "bag_claim_ref was not claimed for pickup".into(),
            ));
        }
    }
    Ok(ValidateCallbackResult::Valid)
}

/// `PickupOrder`'s sibling of `check_raising_dispute`/`check_resolving_dispute`
/// -- much simpler, since there are only ever two parties (requester,
/// merchant) and no accepted-bidder derivation needed: whichever of the two
/// didn't author this update is the respondent.
fn pickup_other_party(order: &PickupOrder, author: &AgentPubKey) -> AgentPubKey {
    if author == &order.requester {
        order.merchant.clone()
    } else {
        order.requester.clone()
    }
}

fn check_raising_pickup_dispute(
    prior: &PickupOrder,
    order: &PickupOrder,
    author: &AgentPubKey,
    original_action_hash: &ActionHash,
) -> ExternResult<Result<(), String>> {
    if prior.dispute_ref.is_some() {
        return Ok(Err("dispute_ref must be empty before a dispute is first raised".into()));
    }
    let Some(new_dispute_ref) = &order.dispute_ref else {
        return Ok(Err("raising a dispute must set dispute_ref".into()));
    };
    let expected_respondent = pickup_other_party(prior, author);
    let order_original_creation = resolve_original_creation(original_action_hash.clone())?;
    validate_new_dispute_ref(&order_original_creation, new_dispute_ref, author, &expected_respondent)
}

fn check_resolving_pickup_dispute(prior: &PickupOrder, order: &PickupOrder, author: &AgentPubKey) -> ExternResult<Result<(), String>> {
    let Some(prior_dispute_ref) = &prior.dispute_ref else {
        return Ok(Err("a Disputed order with no dispute_ref cannot be resolved".into()));
    };
    let Some(new_dispute_ref) = &order.dispute_ref else {
        return Ok(Err("resolving a dispute must set dispute_ref to the resolved record".into()));
    };
    let new_dispute_original_creation = resolve_original_creation(new_dispute_ref.clone())?;
    if &new_dispute_original_creation != prior_dispute_ref {
        return Ok(Err("dispute_ref update must resolve back to the same dispute originally raised".into()));
    }
    // PickupOrder has no delivery-fee-split/FavorProvider-means-driver
    // concept -- "Provider" is reinterpreted as "merchant" here, the only
    // other party there is. validate_dispute_resolution_matches itself is
    // generic over target status, not over DeliveryStatus specifically, so
    // it's reused as-is: FavorProvider -> PickedUp (the merchant's side
    // wins, order completes), FavorRequester -> Cancelled.
    let target = match order.status {
        PickupStatus::PickedUp => DeliveryStatus::Delivered,
        PickupStatus::Cancelled => DeliveryStatus::Cancelled,
        _ => return Ok(Err("resolving a pickup dispute must target PickedUp or Cancelled".into())),
    };
    validate_dispute_resolution_matches(new_dispute_ref, &target, author)
}

fn validate_pickup_order_transition(
    order: &PickupOrder,
    author: &AgentPubKey,
    original_action_hash: &ActionHash,
) -> ExternResult<ValidateCallbackResult> {
    let prior_record = must_get_valid_record(original_action_hash.clone())?;
    let prior: PickupOrder = prior_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "original_action_hash does not point at a PickupOrder entry".into()
        )))?;

    let Some(required_author) = prior.status.transition_requirement(&order.status) else {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "illegal status transition: {:?} -> {:?}",
            prior.status, order.status
        )));
    };

    let is_requester_or_merchant = &prior.requester == author || &prior.merchant == author;
    let authorized = match required_author {
        RequiredAuthor::RequesterOrMerchant => is_requester_or_merchant,
        RequiredAuthor::Any => is_requester_or_merchant,
        RequiredAuthor::Arbitrator => relay_governance::is_arbitrator(author)?,
        // Never produced by PickupStatus::transition_requirement -- there is
        // no accepted-provider concept at all for this entry type.
        RequiredAuthor::AcceptedProvider => false,
    };
    if !authorized {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "transition {:?} -> {:?} requires author role {:?}, but the author holds none of the roles it permits",
            prior.status, order.status, required_author
        )));
    }

    let raising_dispute = matches!(prior.status, PickupStatus::ReadyForPickup | PickupStatus::PickedUp) && order.status == PickupStatus::Disputed;
    let resolving_dispute = prior.status == PickupStatus::Disputed && matches!(order.status, PickupStatus::PickedUp | PickupStatus::Cancelled);
    if raising_dispute {
        if let Err(reason) = check_raising_pickup_dispute(&prior, order, author, original_action_hash)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if resolving_dispute {
        if let Err(reason) = check_resolving_pickup_dispute(&prior, order, author)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if prior.dispute_ref != order.dispute_ref {
        return Ok(ValidateCallbackResult::Invalid(
            "dispute_ref may only change when a dispute is raised or resolved".into(),
        ));
    }

    let unchanged = prior.requester == order.requester
        && prior.merchant == order.merchant
        && prior.catalog_ref == order.catalog_ref
        && prior.item_refs == order.item_refs
        && prior.order_total == order.order_total
        && prior.requested_at == order.requested_at
        && prior.special_instructions == order.special_instructions
        && prior.promo_code_ref == order.promo_code_ref
        && prior.bag_claim_ref == order.bag_claim_ref;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "a pickup order update may only change status/dispute_ref -- every other field must stay the same".into(),
        ));
    }

    Ok(ValidateCallbackResult::Valid)
}

/// Required leg kinds for a delivery's completion chain (3-party:
/// merchant -> driver -> customer, so 2 legs) -- see `Leg`'s doc comment.
const REQUIRED_LEG_KINDS: [LegKind; 2] = [LegKind::MerchantHandoff, LegKind::CustomerHandoff];

/// Walks an action backward to the `Create` action that started its entry's
/// update chain. Needed because `Leg::order_ref` (as set by callers of
/// `attestation::record_leg`) is always the order's *original* creation
/// hash -- a stable identifier reused across the order's whole lifecycle --
/// while `validate_order_transition`'s `original_action_hash` is only the
/// *immediately preceding* action (it changes on every update). Mirrors
/// `relay_coordinator_support::resolve_latest`'s walk, just in the opposite
/// direction and via `hdi::must_get_valid_record` rather than `hdk`'s
/// `get_details`, since integrity zomes can't call coordinator-side hdk
/// functions.
fn resolve_original_creation(action_hash: ActionHash) -> ExternResult<ActionHash> {
    let record = must_get_valid_record(action_hash.clone())?;
    match &record.action().data {
        ActionData::Update(update) => resolve_original_creation(update.original_action_address.clone()),
        _ => Ok(action_hash),
    }
}

/// The actual completion gate, now run as part of deterministic validation
/// rather than trusted from the coordinator: every entry in
/// `delivery_receipts` must be a real `ReceiptAttestation` for a real `Leg`
/// that belongs to *this* order, and together they must cover every
/// required leg kind. Returns `Err(reason)` rather than bailing out with
/// `?` into `ValidateCallbackResult::Invalid` directly, so the caller can
/// build one consistent error message.
fn validate_delivery_receipts(order_original_creation: &ActionHash, receipts: &[ActionHash]) -> ExternResult<Result<(), String>> {
    let mut kinds_seen: Vec<LegKind> = Vec::new();
    for receipt_ref in receipts {
        let receipt_record = must_get_valid_record(receipt_ref.clone())?;
        // `ReceiptAttestation` is committed via countersigning, so its wire
        // shape is `Entry::CounterSign(session_data, bytes)`, not the plain
        // `Entry::App(bytes)` that `to_app_option` (Entry-agnostic, only
        // matches `Entry::App`) expects -- it would silently return `None`
        // here for every genuine receipt. The `TryFrom<&Entry>` impl that
        // `#[hdk_entry_helper]` generates handles both cases, so use that
        // instead.
        let Some(entry) = receipt_record.entry().as_option() else {
            return Ok(Err("a delivery_receipts entry has no entry data".into()));
        };
        let Ok(receipt) = ReceiptAttestation::try_from(entry) else {
            return Ok(Err("a delivery_receipts entry does not point at a ReceiptAttestation entry".into()));
        };
        let leg_record = must_get_valid_record(receipt.leg.clone())?;
        let Some(leg): Option<Leg> = leg_record.entry().to_app_option().map_err(|e| wasm_error!(e))? else {
            return Ok(Err("a delivery_receipts entry's receipt does not point at a Leg entry".into()));
        };
        let leg_order_creation = resolve_original_creation(leg.order_ref)?;
        if &leg_order_creation != order_original_creation {
            return Ok(Err("a delivery_receipts entry references a leg belonging to a different order".into()));
        }
        if !kinds_seen.contains(&leg.kind) {
            kinds_seen.push(leg.kind);
        }
    }
    for required in REQUIRED_LEG_KINDS {
        if !kinds_seen.contains(&required) {
            return Ok(Err(format!("missing an attested leg of kind {:?}", required)));
        }
    }
    Ok(Ok(()))
}

/// Checked when a `Disputed`-raising transition (`PickedUp`/`Delivered ->
/// Disputed`) sets `dispute_ref` for the first time: the referenced
/// `Dispute` must genuinely be a fresh, still-open case for *this* order,
/// raised by the same agent authoring this very order update (raising a
/// dispute is a two-call sequence -- `dispute::open_dispute` then this
/// order update -- and both calls execute in the same agent's context, so
/// they must agree on who raised it), and naming the order's actual *other*
/// party as respondent. `dispute_integrity`'s own validation deliberately
/// can't check this last part itself (it would need this order's *current*
/// mutable state, which isn't a deterministic fact from an unrelated entry's
/// perspective) -- this is the one place with correct temporal context
/// (`prior`/`expected_respondent`, both already resolved from the actual
/// transition being validated), so it's the one place this can be checked.
fn validate_new_dispute_ref(
    order_original_creation: &ActionHash,
    dispute_ref: &ActionHash,
    author: &AgentPubKey,
    expected_respondent: &AgentPubKey,
) -> ExternResult<Result<(), String>> {
    let dispute_record = must_get_valid_record(dispute_ref.clone())?;
    let Some(dispute): Option<Dispute> = dispute_record.entry().to_app_option().map_err(|e| wasm_error!(e))? else {
        return Ok(Err("dispute_ref does not point at a Dispute entry".into()));
    };
    if dispute.status != DisputeStatus::Open {
        return Ok(Err("dispute_ref must reference a still-Open dispute when first raised".into()));
    }
    if &dispute.raised_by != author {
        return Ok(Err("dispute_ref's raised_by must match the author of this order update".into()));
    }
    if &dispute.respondent != expected_respondent {
        return Ok(Err("dispute_ref's respondent must be the order's other party relative to raised_by".into()));
    }
    let dispute_order_creation = resolve_original_creation(dispute.order_ref)?;
    if &dispute_order_creation != order_original_creation {
        return Ok(Err("dispute_ref references a dispute belonging to a different order".into()));
    }
    Ok(Ok(()))
}

/// Checked on the two resolution transitions (`Disputed -> Delivered`/
/// `Cancelled`): the unchanged `dispute_ref` must point at a `Dispute` that
/// is actually `Resolved`, ruled by *this* update's own author (an
/// arbitrator can't apply another arbitrator's ruling), with an outcome
/// whose polarity matches the target status -- `FavorProvider` can only
/// land on `Delivered`, `FavorRequester` only on `Cancelled`.
fn validate_dispute_resolution_matches(dispute_ref: &ActionHash, target_status: &DeliveryStatus, author: &AgentPubKey) -> ExternResult<Result<(), String>> {
    let dispute_record = must_get_valid_record(dispute_ref.clone())?;
    let Some(dispute): Option<Dispute> = dispute_record.entry().to_app_option().map_err(|e| wasm_error!(e))? else {
        return Ok(Err("dispute_ref does not point at a Dispute entry".into()));
    };
    if dispute.status != DisputeStatus::Resolved {
        return Ok(Err("dispute_ref must reference a Resolved dispute before the order can leave Disputed".into()));
    }
    if dispute.arbitrator.as_ref() != Some(author) {
        return Ok(Err("the order update's author must be the same arbitrator who ruled on the dispute".into()));
    }
    let outcome_matches = match dispute.outcome {
        Some(DisputeOutcome::FavorProvider { .. }) => *target_status == DeliveryStatus::Delivered,
        Some(DisputeOutcome::FavorRequester { .. }) => *target_status == DeliveryStatus::Cancelled,
        None => false,
    };
    if !outcome_matches {
        return Ok(Err("the target status does not match the dispute's ruled outcome".into()));
    }
    Ok(Ok(()))
}

/// The cancellation-fairness equivalent of `validate_dispute_resolution_matches`
/// (architecture plan §11.1) -- no outcome/target-status polarity check,
/// since the order's status never changes here (already `Cancelled`, stays
/// `Cancelled` either way); only that the referenced dispute is genuinely
/// `Resolved` and ruled by this update's own author. This is also what
/// closes a real replay gap: without *some* validate()-enforced,
/// one-time-only state change gating `apply_cancellation_dispute_resolution`,
/// nothing would stop the winning party (who is legitimately "a party" to
/// the resulting ledger transaction, so `ledger_integrity`'s own check
/// alone wouldn't catch it) from calling it repeatedly to multiply the
/// forfeiture. Requiring `dispute_ref` to advance here, exactly once,
/// closes that the same way the original design already closes it for
/// `Disputed -> Delivered/Cancelled`.
fn validate_cancellation_dispute_resolution_matches(dispute_ref: &ActionHash, author: &AgentPubKey) -> ExternResult<Result<(), String>> {
    let dispute_record = must_get_valid_record(dispute_ref.clone())?;
    let Some(dispute): Option<Dispute> = dispute_record.entry().to_app_option().map_err(|e| wasm_error!(e))? else {
        return Ok(Err("dispute_ref does not point at a Dispute entry".into()));
    };
    if dispute.status != DisputeStatus::Resolved {
        return Ok(Err("dispute_ref must reference a Resolved dispute before its resolution can be applied".into()));
    }
    if dispute.arbitrator.as_ref() != Some(author) {
        return Ok(Err("the order update's author must be the same arbitrator who ruled on the dispute".into()));
    }
    Ok(Ok(()))
}

/// The dispute being first raised (`PickedUp`/`Delivered -> Disputed`, or
/// the `Cancelled -> Cancelled` cancellation-fairness case) -- extracted out
/// of `validate_order_transition`'s own dispute-ref handling so that
/// function's three-way branch (raise / resolve / resolve-cancellation)
/// reads as three named checks rather than one long inline block, same
/// pattern as `validate_delivery_receipts`/`validate_dispute_resolution_matches`
/// above. `is_accepted_provider`/`accepted_bidder` are passed in rather than
/// re-derived, since the caller already resolved them with the correct
/// prior-state context.
fn check_raising_dispute(
    prior: &DeliveryOrder,
    order: &DeliveryOrder,
    author: &AgentPubKey,
    is_accepted_provider: bool,
    accepted_bidder: &Option<AgentPubKey>,
    original_action_hash: &ActionHash,
) -> ExternResult<Result<(), String>> {
    if prior.dispute_ref.is_some() {
        return Ok(Err("dispute_ref must be empty before a dispute is first raised".into()));
    }
    let Some(new_dispute_ref) = &order.dispute_ref else {
        return Ok(Err("raising a dispute must set dispute_ref".into()));
    };
    // The order's *other* party relative to whoever raised this.
    let expected_respondent = if is_accepted_provider {
        prior.requester.clone()
    } else {
        match accepted_bidder {
            Some(bidder) => bidder.clone(),
            None => return Ok(Err("cannot raise a dispute on an order with no accepted bid".into())),
        }
    };
    let order_original_creation = resolve_original_creation(original_action_hash.clone())?;
    validate_new_dispute_ref(&order_original_creation, new_dispute_ref, author, &expected_respondent)
}

/// The `Disputed -> Delivered`/`Cancelled` resolution transition -- see
/// `check_raising_dispute`'s doc comment for why this is extracted.
fn check_resolving_dispute(prior: &DeliveryOrder, order: &DeliveryOrder, author: &AgentPubKey) -> ExternResult<Result<(), String>> {
    let Some(prior_dispute_ref) = &prior.dispute_ref else {
        return Ok(Err("a Disputed order with no dispute_ref cannot be resolved".into()));
    };
    let Some(new_dispute_ref) = &order.dispute_ref else {
        return Ok(Err("resolving a dispute must set dispute_ref to the resolved record".into()));
    };
    // dispute_ref is allowed to *advance* here, from the dispute's original
    // creation hash to its resolved-update hash -- must_get_valid_record is
    // literal, so validate_dispute_resolution_matches needs a reference that
    // already points directly at the Resolved content (the creation hash
    // would only ever show the original Open-status entry, the same
    // "get() is literal" gotcha as delivery_receipts elsewhere in this
    // file). Still must be the *same* dispute chain, not a swap to an
    // unrelated one.
    let new_dispute_original_creation = resolve_original_creation(new_dispute_ref.clone())?;
    if &new_dispute_original_creation != prior_dispute_ref {
        return Ok(Err("dispute_ref update must resolve back to the same dispute originally raised".into()));
    }
    validate_dispute_resolution_matches(new_dispute_ref, &order.status, author)
}

/// The cancellation-fairness resolution transition (`Cancelled -> Cancelled`
/// with `prior.dispute_ref` already set) -- see `check_raising_dispute`'s
/// doc comment for why this is extracted. Arbitrator-only authorship is
/// already enforced by `validate_order_transition`'s own `authorized` check
/// before this runs, so there's nothing further to check on that front here.
fn check_resolving_cancellation_dispute(prior: &DeliveryOrder, order: &DeliveryOrder, author: &AgentPubKey) -> ExternResult<Result<(), String>> {
    // Safe: callers only reach this once resolving_cancellation_dispute has
    // already established prior.dispute_ref.is_some().
    let prior_dispute_ref = prior.dispute_ref.as_ref().unwrap();
    let Some(new_dispute_ref) = &order.dispute_ref else {
        return Ok(Err("dispute_ref must remain set while resolving a cancellation dispute".into()));
    };
    if new_dispute_ref == prior_dispute_ref {
        return Ok(Err("applying a cancellation dispute resolution must advance dispute_ref to the resolved record".into()));
    }
    let new_dispute_original_creation = resolve_original_creation(new_dispute_ref.clone())?;
    if &new_dispute_original_creation != prior_dispute_ref {
        return Ok(Err("dispute_ref update must resolve back to the same dispute originally raised".into()));
    }
    validate_cancellation_dispute_resolution_matches(new_dispute_ref, author)
}

fn validate_order_transition(
    order: &DeliveryOrder,
    author: &AgentPubKey,
    original_action_hash: &ActionHash,
    action_timestamp: Timestamp,
) -> ExternResult<ValidateCallbackResult> {
    let prior_record = must_get_valid_record(original_action_hash.clone())?;
    let prior: DeliveryOrder = prior_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "original_action_hash does not point at a DeliveryOrder entry".into()
        )))?;

    let Some(required_author) = prior.status.transition_requirement(&order.status) else {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "illegal status transition: {:?} -> {:?}",
            prior.status, order.status
        )));
    };

    let is_requester_or_merchant = &prior.requester == author || &prior.merchant == author;
    let accepted_bidder: Option<AgentPubKey> = match &prior.accepted_bid {
        Some(bid_ref) => {
            let bid_record = must_get_valid_record(bid_ref.clone())?;
            let bid: Bid = bid_record
                .entry()
                .to_app_option()
                .map_err(|e| wasm_error!(e))?
                .ok_or(wasm_error!(WasmErrorInner::Guest(
                    "accepted_bid does not point at a Bid entry".into()
                )))?;
            Some(bid.bidder)
        }
        None => None,
    };
    let is_accepted_provider = accepted_bidder.as_ref() == Some(author);

    // Computed here (rather than down with the rest of the dispute_ref
    // handling below) because the (Cancelled, Cancelled) pair needs it to
    // pick the right required-author check too: that one status pair
    // covers *both* raising a cancellation-fairness dispute (Any: req/
    // merchant/provider) and applying its resolution (arbitrator only) --
    // transition_requirement's table has no way to express two different
    // requirements for the same pair, so the split happens here, keyed off
    // prior.dispute_ref, same signal the dispute_ref block below uses.
    let resolving_cancellation_dispute =
        prior.status == DeliveryStatus::Cancelled && order.status == DeliveryStatus::Cancelled && prior.dispute_ref.is_some();

    let authorized = match required_author {
        RequiredAuthor::RequesterOrMerchant => is_requester_or_merchant,
        RequiredAuthor::AcceptedProvider => is_accepted_provider,
        RequiredAuthor::Any if resolving_cancellation_dispute => relay_governance::is_arbitrator(author)?,
        RequiredAuthor::Any => is_requester_or_merchant || is_accepted_provider,
        RequiredAuthor::Arbitrator => relay_governance::is_arbitrator(author)?,
    };
    if !authorized {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "transition {:?} -> {:?} requires author role {:?}, but the author holds none of the roles it permits",
            prior.status, order.status, required_author
        )));
    }

    // Every field except status (and accepted_bid, only for the one
    // transition that's allowed to set it) must be unchanged. Without this,
    // an otherwise-authorized author could smuggle changes to order_total,
    // item_refs, dropoff, or swap accepted_bid to a different bid entirely
    // while making an unrelated, legitimately-authorized status update.
    let accepted_bid_ok = if prior.status == DeliveryStatus::Open && order.status == DeliveryStatus::BidAccepted {
        prior.accepted_bid.is_none() && order.accepted_bid.is_some()
    } else {
        prior.accepted_bid == order.accepted_bid
    };
    if !accepted_bid_ok {
        return Ok(ValidateCallbackResult::Invalid(
            "accepted_bid may only be set, once, during the Open -> BidAccepted transition".into(),
        ));
    }
    // A scheduled order can only actually open once its requested time has
    // arrived. Deliberately checked against *this action's own recorded
    // timestamp* (fixed, agreed-upon by every validator who looks at this
    // same action), not a fresh `sys_time()` call inside validate() -- the
    // latter would be non-deterministic, since different peers validating
    // the same action at different real-world moments could disagree.
    if prior.status == DeliveryStatus::Scheduled && order.status == DeliveryStatus::Open {
        let due = prior.requested_delivery_time.unwrap_or(Timestamp(0));
        if action_timestamp < due {
            return Ok(ValidateCallbackResult::Invalid(
                "a scheduled order cannot open for bidding before its requested_delivery_time".into(),
            ));
        }
    }
    // delivery_receipts may only be populated, once, during PickedUp ->
    // Delivered -- and when it is, it must actually check out: every
    // referenced ReceiptAttestation must be real, belong to a Leg on *this*
    // order, and together cover every required leg kind. This is the
    // completion gate that used to live only in `dispatch::complete_delivery`
    // (trusted from the coordinator) -- now it's enforced here too, so a
    // direct `update_entry` bypassing that coordinator function can't skip it.
    if prior.status == DeliveryStatus::PickedUp && order.status == DeliveryStatus::Delivered {
        if !prior.delivery_receipts.is_empty() {
            return Ok(ValidateCallbackResult::Invalid(
                "delivery_receipts must be empty before the Delivered transition sets it".into(),
            ));
        }
        let order_original_creation = resolve_original_creation(original_action_hash.clone())?;
        if let Err(reason) = validate_delivery_receipts(&order_original_creation, &order.delivery_receipts)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if prior.delivery_receipts != order.delivery_receipts {
        return Ok(ValidateCallbackResult::Invalid(
            "delivery_receipts may only be set, once, during the PickedUp -> Delivered transition".into(),
        ));
    }

    // dispute_ref: set once, when a dispute is first raised (PickedUp/
    // Delivered -> Disputed, or Cancelled -> Cancelled for a cancellation-
    // fairness dispute -- architecture plan §11.1, which reuses this exact
    // block unchanged: an order cancelled from Open never had an accepted
    // bid, so the "cannot raise a dispute on an order with no accepted bid"
    // check below already correctly refuses a fairness dispute where there
    // was never a provider to have one with), then immutable except that
    // the resolution transitions (Disputed -> Delivered/Cancelled) must
    // find it pointing at a genuinely Resolved dispute whose ruling matches
    // the target status -- see architecture plan §8. This is what stops a
    // peer from calling update_entry directly to flip a Disputed order to
    // Delivered/Cancelled without a real arbitrator ruling behind it, same
    // posture as the delivery_receipts completion gate above. A
    // cancellation-fairness dispute has no equivalent resolution transition
    // here at all -- the order is already terminal, so resolving one only
    // ever touches the Dispute entry and a ledger transaction, never this
    // order (see `dispatch::apply_cancellation_dispute_resolution`).
    // The (Cancelled, Cancelled) same-status pair covers *both* raising a
    // cancellation-fairness dispute (dispute_ref unset -> set) and applying
    // its resolution (dispute_ref advancing) -- transition_requirement's
    // table can't distinguish them (same status pair either way, and the
    // raise side deliberately needs RequiredAuthor::Any while the resolve
    // side needs an arbitrator only), so that distinction is made here,
    // from prior.dispute_ref, same as the other two dispute cases below.
    // (resolving_cancellation_dispute is already computed above, alongside
    // the `authorized` check it also feeds into.)
    let raising_dispute = (matches!(prior.status, DeliveryStatus::PickedUp | DeliveryStatus::Delivered)
        && order.status == DeliveryStatus::Disputed)
        || (prior.status == DeliveryStatus::Cancelled && order.status == DeliveryStatus::Cancelled && prior.dispute_ref.is_none());
    let resolving_dispute =
        prior.status == DeliveryStatus::Disputed && matches!(order.status, DeliveryStatus::Delivered | DeliveryStatus::Cancelled);
    if raising_dispute {
        if let Err(reason) = check_raising_dispute(&prior, order, author, is_accepted_provider, &accepted_bidder, original_action_hash)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if resolving_dispute {
        if let Err(reason) = check_resolving_dispute(&prior, order, author)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if resolving_cancellation_dispute {
        if let Err(reason) = check_resolving_cancellation_dispute(&prior, order, author)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if prior.dispute_ref != order.dispute_ref {
        return Ok(ValidateCallbackResult::Invalid(
            "dispute_ref may only change when a dispute is raised or resolved".into(),
        ));
    }

    let unchanged = prior.requester == order.requester
        && prior.merchant == order.merchant
        && prior.catalog_ref == order.catalog_ref
        && prior.item_refs == order.item_refs
        && prior.order_total == order.order_total
        && prior.dropoff == order.dropoff
        && prior.dropoff_geohash == order.dropoff_geohash
        && prior.max_delivery_fee == order.max_delivery_fee
        && prior.requested_at == order.requested_at
        && prior.special_instructions == order.special_instructions
        && prior.tip_cents == order.tip_cents
        && prior.requested_delivery_time == order.requested_delivery_time
        && prior.promo_code_ref == order.promo_code_ref
        && prior.dropoff_preference == order.dropoff_preference
        && prior.bag_claim_ref == order.bag_claim_ref;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "an order update may only change status (and accepted_bid, on acceptance) -- every other field must stay the same".into(),
        ));
    }

    Ok(ValidateCallbackResult::Valid)
}

fn validate_new_bid(bid: &Bid, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if &bid.bidder != author {
        return Ok(ValidateCallbackResult::Invalid("a bid can only be authored by its own bidder".into()));
    }
    if bid.eta_seconds == 0 {
        return Ok(ValidateCallbackResult::Invalid("eta_seconds must be greater than zero".into()));
    }
    if bid.price_offer == 0 {
        return Ok(ValidateCallbackResult::Invalid("price_offer must be greater than zero".into()));
    }
    if bid.status != BidStatus::Open {
        return Ok(ValidateCallbackResult::Invalid("a new bid must start in the Open status".into()));
    }
    let record = must_get_valid_record(bid.order_ref.clone())?;
    let order: DeliveryOrder = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "order_ref does not point at a DeliveryOrder entry".into()
        )))?;
    if order.status != DeliveryStatus::Open {
        return Ok(ValidateCallbackResult::Invalid("bids can only be placed on an Open order".into()));
    }
    // Otherwise unenforced self-dealing: nothing else stops the requester or
    // merchant from bidding on (and accepting) their own order -- the first
    // symptom wouldn't be here, it'd be a much later, far more confusing
    // `InvalidCommit` at pickup-confirmation time, when `record_leg` tries to
    // create a Leg with identical `from`/`to` agents. Reject it here instead,
    // at the earliest point it's actually knowable, with a clear reason.
    if bid.bidder == order.requester {
        return Ok(ValidateCallbackResult::Invalid(
            "a requester cannot bid to deliver their own order".into(),
        ));
    }
    if bid.bidder == order.merchant {
        return Ok(ValidateCallbackResult::Invalid(
            "a merchant cannot bid to deliver their own order".into(),
        ));
    }
    if let Some(max_fee) = order.max_delivery_fee {
        if bid.price_offer > max_fee {
            return Ok(ValidateCallbackResult::Invalid(
                "price_offer exceeds the order's max_delivery_fee".into(),
            ));
        }
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_bid_update(bid: &Bid, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    // A bid only ever transitions via the bidder withdrawing it, or the
    // order's requester accepting/rejecting it as part of accept_bid --
    // accept_bid updates the *order*, not the bid, so the only self-authored
    // bid update left is a withdrawal.
    if &bid.bidder != author {
        return Ok(ValidateCallbackResult::Invalid(
            "only the bidder may update their own bid".into(),
        ));
    }
    if bid.status != BidStatus::Withdrawn {
        return Ok(ValidateCallbackResult::Invalid(
            "a bidder may only update their bid to Withdrawn".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}
