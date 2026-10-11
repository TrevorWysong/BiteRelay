//! The caller's view of stores, read from the catalog zome: which stores
//! the caller runs, and a store's current settings.

use hdk::prelude::*;

/// The store's catalog at its latest state.
pub(crate) fn current_catalog(catalog_ref: &ActionHash) -> ExternResult<catalog_types::MerchantCatalog> {
    Ok(current_catalog_version(catalog_ref)?.1)
}

/// The store's latest version -- its action, and its catalog.
pub(crate) fn current_catalog_version(catalog_ref: &ActionHash) -> ExternResult<(ActionHash, catalog_types::MerchantCatalog)> {
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "catalog", "get_catalog".into(), None, catalog_ref.clone())? else {
        return Err(wasm_error!(WasmErrorInner::Guest("couldn't read the store's details".into())));
    };
    let record: Record = io.decode().map_err(|e| wasm_error!(e))?;
    let catalog = record
        .entry()
        .to_app_option::<catalog_types::MerchantCatalog>()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("catalog_ref is not a store".into())))?;
    Ok((record.action_address().clone(), catalog))
}

/// Just the identity of a store, from `catalog::list_my_catalogs`.
#[derive(Deserialize, Debug)]
struct StoreView {
    original_action: ActionHash,
}

/// Every store the caller runs, by identity.
pub(crate) fn my_stores() -> ExternResult<Vec<ActionHash>> {
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "catalog", "list_my_catalogs".into(), None, ())? else {
        return Err(wasm_error!(WasmErrorInner::Guest("listing your stores failed".into())));
    };
    let stores: Vec<StoreView> = io.decode().map_err(|e| wasm_error!(e))?;
    Ok(stores.into_iter().map(|store| store.original_action).collect())
}

/// When an order the store accepts now will be ready: `prep_minutes` from
/// now if the store chose a time for it, else its usual prep time, plus
/// its busy extra while it's busy.
pub(crate) fn ready_by(catalog_ref: &ActionHash, prep_minutes: Option<u16>) -> ExternResult<Timestamp> {
    let prep = prep_time(catalog_ref, prep_minutes)?;
    Ok(Timestamp::from_micros(sys_time()?.as_micros() + prep as i64 * 60 * 1_000_000))
}

/// The prep time a store quotes: `prep_minutes`, or its usual time (and any
/// extra while it's busy) -- within the network's longest.
pub(crate) fn prep_time(catalog_ref: &ActionHash, prep_minutes: Option<u16>) -> ExternResult<u16> {
    let prep = match prep_minutes {
        Some(minutes) => minutes,
        None => {
            let store = current_catalog(catalog_ref)?;
            store.prep_minutes.saturating_add(store.busy_extra_minutes)
        }
    };
    let max = relay_governance::max_prep_minutes();
    if prep == 0 || prep > max {
        return Err(wasm_error!(WasmErrorInner::Guest(format!("prep time must be between 1 and {max} minutes"))));
    }
    Ok(prep)
}

/// Why `catalog` isn't taking orders at `at` (microseconds since the
/// epoch), if it isn't: ordering paused, or outside its hours in its own
/// time zone -- worded for the customer, with when it next opens.
pub(crate) fn closed_reason(catalog: &catalog_types::MerchantCatalog, at: i64) -> Option<String> {
    if !catalog.is_open {
        return Some(format!("{} isn't taking orders right now", catalog.business_name));
    }
    let (weekday, minute) = local_weekday_minute(&catalog.time_zone, at);
    if catalog_types::open_at(&catalog.weekly_hours, weekday, minute) {
        return None;
    }
    let opens = match catalog_types::next_opening(&catalog.weekly_hours, weekday, minute) {
        Some((0, minute)) => format!(" -- it opens at {}", clock(minute)),
        Some((1, minute)) => format!(" -- it opens tomorrow at {}", clock(minute)),
        Some((_, minute)) => format!(" -- it next opens at {}", clock(minute)),
        None => String::new(),
    };
    Some(format!("{} is closed then{opens}", catalog.business_name))
}

/// The local weekday (0 = Sunday) and minute after midnight of `at` in
/// `time_zone`; an unknown zone reads as UTC.
fn local_weekday_minute(time_zone: &str, at: i64) -> (u8, u16) {
    use chrono::{Datelike, TimeZone, Timelike};
    let tz: chrono_tz::Tz = time_zone.parse().unwrap_or(chrono_tz::Tz::UTC);
    let local = tz.timestamp_micros(at).single().unwrap_or_else(|| chrono_tz::Tz::UTC.timestamp_micros(at).unwrap());
    (local.weekday().num_days_from_sunday() as u8, (local.hour() * 60 + local.minute()) as u16)
}

/// "08:00" for 480.
fn clock(minute: u16) -> String {
    format!("{:02}:{:02}", minute / 60, minute % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use catalog_types::{MerchantCatalog, OpeningPeriod};

    /// 2026-03-07 12:00 UTC, a Saturday (07:00 in New York).
    const SAT_NOON_UTC: i64 = 1_772_884_800_000_000;

    fn store(weekly_hours: Vec<OpeningPeriod>, time_zone: &str) -> MerchantCatalog {
        let mut catalog: MerchantCatalog = serde_json::from_value(serde_json::json!({
            "owner": AgentPubKey::from_raw_36(vec![0; 36]),
            "business_name": "Mo's",
            "location": { "lat": 0.0, "lon": 0.0 },
            "geohash": "s0000",
            "is_open": true,
            "prep_minutes": 15,
            "delivery_subsidy_percent": 50,
            "max_delivery_radius_km": 8.0,
        }))
        .unwrap();
        catalog.weekly_hours = weekly_hours;
        catalog.time_zone = time_zone.into();
        catalog
    }

    #[test]
    fn hours_are_read_in_the_stores_own_time_zone() {
        // Saturday 08:00-22:00.
        let hours = vec![OpeningPeriod { weekday: 6, opens: 480, closes: 1320 }];
        assert_eq!(closed_reason(&store(hours.clone(), "UTC"), SAT_NOON_UTC), None, "noon in UTC is open");
        assert_eq!(
            closed_reason(&store(hours, "America/New_York"), SAT_NOON_UTC).as_deref(),
            Some("Mo's is closed then -- it opens at 08:00"),
            "07:00 in New York isn't"
        );
    }

    #[test]
    fn a_paused_store_is_closed_whatever_its_hours() {
        let mut paused = store(Vec::new(), "UTC");
        paused.is_open = false;
        assert_eq!(closed_reason(&paused, SAT_NOON_UTC).as_deref(), Some("Mo's isn't taking orders right now"));
    }
}
