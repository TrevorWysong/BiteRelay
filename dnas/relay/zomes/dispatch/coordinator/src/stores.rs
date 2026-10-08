//! The caller's view of stores, read from the catalog zome: which stores
//! the caller runs, and a store's current settings.

use hdk::prelude::*;

/// The store's catalog at its latest state.
pub(crate) fn current_catalog(catalog_ref: &ActionHash) -> ExternResult<catalog_types::MerchantCatalog> {
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "catalog", "get_catalog".into(), None, catalog_ref.clone())? else {
        return Err(wasm_error!(WasmErrorInner::Guest("couldn't read the store's details".into())));
    };
    io.decode::<Record>()
        .map_err(|e| wasm_error!(e))?
        .entry()
        .to_app_option::<catalog_types::MerchantCatalog>()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("catalog_ref is not a store".into())))
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
