//! What an order earns, read from the records as validation reads them --
//! the one function the app earns with and validation checks earning by.
//!
//! Points are earned once the refund period is over: after the store's
//! settlement, and the network's window to appeal it (when it has
//! arbiters), so they're earned on what the customer finally paid. An
//! appealed order earns once the arbiter rules, less what they awarded.

use crate::{order_points, RewardsProgram};
use catalog_types::{GoodieBag, MenuItem};
use dispatch_types::{Appeal, DeliveryOrder, DeliveryStatus, ItemSettlement, LinePricer, OrderLine, OrderRewards, PickupOrder, PickupStatus, Ruling};
use handshake_integrity_support::{decode, original_creation};
use hdi::prelude::*;

/// An order, as the rewards rules need it.
pub struct OrderForRewards {
    pub requester: AgentPubKey,
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    pub lines: Vec<OrderLine>,
    pub order_total: u64,
    pub tax_cents: u64,
    pub rewards: Option<OrderRewards>,
    pub promo_code_ref: Option<ActionHash>,
    pub bag_claim_ref: Option<ActionHash>,
}

impl OrderForRewards {
    /// The order a record is, of either kind.
    pub fn of(record: &Record) -> Option<Self> {
        if let Some(o) = decode::<DeliveryOrder>(record) {
            return Some(Self { requester: o.requester, merchant: o.merchant, catalog_ref: o.catalog_ref, lines: o.lines, order_total: o.order_total, tax_cents: o.tax_cents, rewards: o.rewards, promo_code_ref: o.promo_code_ref, bag_claim_ref: o.bag_claim_ref });
        }
        let o = decode::<PickupOrder>(record)?;
        Some(Self { requester: o.requester, merchant: o.merchant, catalog_ref: o.catalog_ref, lines: o.lines, order_total: o.order_total, tax_cents: o.tax_cents, rewards: o.rewards, promo_code_ref: o.promo_code_ref, bag_claim_ref: o.bag_claim_ref })
    }
}

/// What an order earned, and under what.
pub struct Earning {
    pub order: OrderForRewards,
    /// The program version the order cites, and the program at it.
    pub program_ref: ActionHash,
    pub program: RewardsProgram,
    /// Before the member's tier, cap and welcome (`points::order_points`).
    pub base: u64,
    /// When the store settled it: when it's earned.
    pub settled_at: Timestamp,
    /// When its refund period ends -- the earliest it's earned.
    pub available_at: Timestamp,
}

/// A store's program at `program_ref` -- one of its versions -- if it's
/// `catalog_ref`'s.
pub fn program_at(program_ref: &ActionHash, catalog_ref: &ActionHash) -> ExternResult<Result<RewardsProgram, &'static str>> {
    match decode::<RewardsProgram>(&must_get_valid_record(program_ref.clone())?) {
        Some(program) if &program.catalog_ref == catalog_ref => Ok(Ok(program)),
        Some(_) => Ok(Err("that program is another store's")),
        None => Ok(Err("that isn't a rewards program")),
    }
}

/// The order at `order_ref` (its original action), if it joined a running
/// program, with that program.
pub fn joined(order_ref: &ActionHash) -> ExternResult<Result<(OrderForRewards, ActionHash, RewardsProgram), &'static str>> {
    let record = must_get_valid_record(order_ref.clone())?;
    if !matches!(record.action().data, ActionData::Create(_)) {
        return Ok(Err("points are earned on an order, by its original action"));
    }
    let Some(order) = OrderForRewards::of(&record) else { return Ok(Err("that isn't an order")) };
    let Some(rewards) = order.rewards.clone() else { return Ok(Err("that order didn't join a rewards program")) };
    let program = match program_at(&rewards.program, &order.catalog_ref)? {
        Ok(program) => program,
        Err(reason) => return Ok(Err(reason)),
    };
    if !program.active {
        return Ok(Err("that program wasn't running"));
    }
    Ok(Ok((order, rewards.program, program)))
}

/// What an order's food comes to, line by line, before any discount --
/// each line's item and total.
pub fn line_totals(order: &OrderForRewards) -> ExternResult<Result<Vec<(ActionHash, u64)>, &'static str>> {
    let mut lines = Vec::with_capacity(order.lines.len());
    let mut pricer = LinePricer::default();
    for line in &order.lines {
        let version = must_get_valid_record(line.priced_version.clone())?;
        let unit = if let Some(item) = decode::<MenuItem>(&version) {
            match pricer.unit_price(&item, &line.selections)? {
                Ok(price) => price,
                Err(_) => return Ok(Err("that order's lines don't price")),
            }
        } else if let Some(bag) = decode::<GoodieBag>(&version) {
            bag.price_cents
        } else {
            return Ok(Err("that order's lines don't price"));
        };
        lines.push((line.item_ref.clone(), unit.saturating_mul(u64::from(line.quantity))));
    }
    Ok(Ok(lines))
}

/// When the store accepted `order` (its original action), from the version
/// at `accepted_ref`: an update of it by its store, from `Placed`. What its
/// happy hours are judged by -- the store's clock, not the customer's.
pub fn accepted_at(order_ref: &ActionHash, merchant: &AgentPubKey, accepted_ref: &ActionHash) -> ExternResult<Result<Timestamp, &'static str>> {
    let record = must_get_valid_record(accepted_ref.clone())?;
    let ActionData::Update(update) = &record.action().data else { return Ok(Err("that isn't the store accepting the order")) };
    if record.action().author() != merchant || &original_creation(accepted_ref.clone())? != order_ref {
        return Ok(Err("that isn't the store accepting the order"));
    }
    let prior = must_get_valid_record(update.original_action_address.clone())?;
    let from_placed = decode::<DeliveryOrder>(&prior).is_some_and(|o| o.status == DeliveryStatus::Placed) || decode::<PickupOrder>(&prior).is_some_and(|o| o.status == PickupStatus::Placed);
    Ok(if from_placed { Ok(record.action().timestamp()) } else { Err("that isn't the store accepting the order") })
}

/// When the refund period after a settlement at `settled_at` ends: the
/// network's appeal window after it, or at once on a network without
/// arbiters, where nothing can be appealed.
pub fn refund_period_ends(settled_at: Timestamp) -> Timestamp {
    if handshake_governance::arbiters().is_empty() {
        return settled_at;
    }
    let window = handshake_governance::appeal_window().as_micros() as i64;
    Timestamp::from_micros(settled_at.as_micros().saturating_add(window))
}

/// What `order_ref` (an order's original action) earns on its store's
/// settlement `settlement_ref`, accepted by the store at `accepted_ref`,
/// with the arbiter's `ruling` on its appeal if it was appealed -- or why it
/// earns nothing. The food paid, after discounts, the settlement's refund
/// and any award, without tax, at the program version the order was placed
/// under.
pub fn earning(order_ref: &ActionHash, settlement_ref: &ActionHash, accepted_ref: &ActionHash, ruling_ref: Option<&ActionHash>) -> ExternResult<Result<Earning, &'static str>> {
    let (order, program_ref, program) = match joined(order_ref)? {
        Ok(joined) => joined,
        Err(reason) => return Ok(Err(reason)),
    };
    let settlement_record = must_get_valid_record(settlement_ref.clone())?;
    let Some(settlement) = decode::<ItemSettlement>(&settlement_record) else { return Ok(Err("points are earned on the store's settlement of the order")) };
    if &settlement.order != order_ref || settlement_record.action().author() != &order.merchant {
        return Ok(Err("points are earned on the store's settlement of the order"));
    }
    let accepted = match accepted_at(order_ref, &order.merchant, accepted_ref)? {
        Ok(at) => at,
        Err(reason) => return Ok(Err(reason)),
    };
    let award = match ruling_ref {
        Some(ruling_ref) => {
            let record = must_get_valid_record(ruling_ref.clone())?;
            let Some(ruling) = decode::<Ruling>(&record) else { return Ok(Err("that isn't a ruling")) };
            let appeal = decode::<Appeal>(&must_get_valid_record(ruling.appeal.clone())?);
            let ours = appeal.is_some_and(|a| &a.order == order_ref && &a.settlement == settlement_ref && record.action().author() == &a.arbiter);
            if !ours {
                return Ok(Err("that ruling is on another appeal"));
            }
            ruling.award
        }
        None => 0,
    };
    let eligible = order.order_total.saturating_sub(order.tax_cents).saturating_sub(settlement.refund).saturating_sub(award);
    let lines = match line_totals(&order)? {
        Ok(lines) => lines,
        Err(reason) => return Ok(Err(reason)),
    };
    let base = order_points(&program, &lines, eligible, accepted);
    let settled_at = settlement_record.action().timestamp();
    Ok(Ok(Earning { order, program_ref, program, base, settled_at, available_at: refund_period_ends(settled_at) }))
}
