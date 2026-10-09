//! How drivers find work: every open order is indexed under its drop-off's
//! geohash cell (and a time bucket, so a read is bounded by recent orders,
//! never all of history), and a driver who's online reads the cells around
//! them (`get_open_orders_near`).
//!
//! Drivers pull; they never announce where they are. Anything a driver
//! published -- a presence beacon, say -- would be signed with their key,
//! and anyone could follow them through a shift (and home at the end of it).
//! So the only trace a driver's location leaves is a read of a public list,
//! seen only by whichever peer happens to store that list.

use dispatch_integrity::{open_order_anchor, LinkTypes, OPEN_ORDER_BUCKET_MILLIS};
use hdi::hash_path::path::Path;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, resolve_latest};

pub(crate) fn open_order_anchor_path(geohash: &str, bucket: i64) -> ExternResult<hdi::hash_path::path::TypedPath> {
    Path::from(open_order_anchor(geohash, bucket)).typed(LinkTypes::OpenOrderGeohashAnchor)
}

/// How precisely an order's drop-off is published (a ~1.2km x 0.6km cell):
/// enough for a driver to see it's nearby, never the address itself, which
/// only the assigned driver can open.
pub(crate) fn dropoff_geohash_precision() -> usize {
    6
}

/// Open orders in `geohash` and its neighbouring cells -- what an online
/// driver's app reads every few seconds.
#[hdk_extern]
pub fn get_open_orders_near(geohash: String) -> ExternResult<Vec<Record>> {
    use dispatch_integrity::DeliveryOrder;
    use dispatch_integrity::DeliveryStatus;

    let now = sys_time()?;
    let current_bucket = relay_types::time_bucket(now.as_millis(), OPEN_ORDER_BUCKET_MILLIS);
    let mut orders = Vec::new();
    for cell in relay_types::cell_and_neighbors(&geohash) {
        // Current bucket and the immediately preceding one -- see
        // architecture plan §9.2.
        for bucket in [current_bucket, current_bucket - 1] {
            let path = open_order_anchor_path(&cell, bucket)?;
            let path_hash = match path.path_entry_hash() {
                Ok(hash) => hash,
                Err(_) => continue,
            };
            let links = get_links(
                LinkQuery::try_new(path_hash, LinkTypes::OpenOrderGeohashAnchor)?,
                GetStrategy::default(),
            )?;
            for link in links {
                let Some(action_hash) = link.target.into_action_hash() else { continue };
                // Anchor links point at the store's acceptance (the version
                // that opened the order) -- resolve_latest is what makes this
                // reflect the order's real current status rather than
                // showing it as forever Open. Bids name that same version.
                let Ok(record) = resolve_latest(action_hash) else { continue };
                let Some(order) = decode_or::<DeliveryOrder>(&record) else { continue };
                if order.status == DeliveryStatus::Open {
                    orders.push(record);
                }
            }
        }
    }
    Ok(orders)
}
