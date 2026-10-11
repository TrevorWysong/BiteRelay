//! The order entry types, for the chain walks the order rules make
//! (`relay_integrity_support::chain`).

use super::*;

/// The order entry types, delivery and pickup.
pub(crate) fn order_types() -> ExternResult<[ScopedEntryDefIndex; 2]> {
    Ok([UnitEntryTypes::DeliveryOrder.try_into()?, UnitEntryTypes::PickupOrder.try_into()?])
}
