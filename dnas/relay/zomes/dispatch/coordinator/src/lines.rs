//! An order's lines as people read them -- the item, what each unit cost
//! with its choices, and the choices themselves ("Large", "2 x Extra shot",
//! "Fries (Large)") -- for the kitchen, the customer, receipts and reports.
//! Prices come from the exact versions each line was priced at, so they're
//! what the customer paid.

use catalog_types::{GoodieBag, MenuItem, ModifierGroup};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, original_action_of, resolve_latest};

/// One line of an order, described.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LineView {
    /// The item's original action, as the order names it.
    pub item_ref: ActionHash,
    pub name: String,
    pub quantity: u32,
    /// With its choices.
    pub unit_price_cents: u64,
    /// Each chosen option, in the order the item asks for them.
    pub choices: Vec<String>,
}

/// An order's lines, described -- public, as the lines themselves are.
#[hdk_extern]
pub fn get_order_lines(order_ref: ActionHash) -> ExternResult<Vec<LineView>> {
    let record = resolve_latest(original_action_of(order_ref)?)?;
    let lines = match (decode_or::<DeliveryOrder>(&record), decode_or::<PickupOrder>(&record)) {
        (Some(o), _) => o.lines,
        (None, Some(o)) => o.lines,
        _ => return Err(guest("that isn't an order")),
    };
    describe(&lines)
}

pub(crate) fn describe(lines: &[OrderLine]) -> ExternResult<Vec<LineView>> {
    let mut pricer = LinePricer::default();
    lines.iter().map(|line| describe_line(line, &mut pricer)).collect()
}

fn describe_line(line: &OrderLine, pricer: &mut LinePricer) -> ExternResult<LineView> {
    let version = fetch(&line.priced_version)?;
    let (name, unit_price_cents) = if let Some(item) = decode_or::<MenuItem>(&version) {
        let price = pricer.unit_price(&item, &line.selections)?.map_err(guest)?;
        (item.name, price)
    } else if let Some(bag) = decode_or::<GoodieBag>(&version) {
        (bag.title, bag.price_cents)
    } else {
        return Err(guest("an order line isn't priced from an item"));
    };
    let mut choices = Vec::new();
    for selection in &line.selections {
        choices.extend(labels(selection)?);
    }
    Ok(LineView { item_ref: line.item_ref.clone(), name, quantity: line.quantity, unit_price_cents, choices })
}

/// What was chosen from one group, an entry per option: "2 x Extra shot",
/// with what was chosen from its nested group after it in brackets.
fn labels(selection: &Selection) -> ExternResult<Vec<String>> {
    let group = decode_or::<ModifierGroup>(&fetch(&selection.version)?).ok_or(guest("a choice on this order isn't from a choice group"))?;
    let mut out = Vec::with_capacity(selection.options.len());
    for chosen in &selection.options {
        let name = group.options.iter().find(|o| o.id == chosen.option).map_or("(removed)", |o| o.name.as_str());
        let mut label = if chosen.quantity > 1 { format!("{} x {name}", chosen.quantity) } else { name.to_string() };
        let mut nested = Vec::new();
        for inner in &chosen.nested {
            nested.extend(labels(inner)?);
        }
        if !nested.is_empty() {
            label = format!("{label} ({})", nested.join(", "));
        }
        out.push(label);
    }
    Ok(out)
}

fn fetch(version: &ActionHash) -> ExternResult<Record> {
    match get(version.clone(), GetOptions::local())? {
        Some(record) => Ok(record),
        None => get(version.clone(), GetOptions::network())?.ok_or(guest("something on this order couldn't be found")),
    }
}

fn guest(message: impl Into<String>) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message.into()))
}
