// Which stores this merchant runs, and which one the merchant screens are
// currently working on -- the client half of multi-store support (see the
// Rust `list_my_catalogs` doc comment). Same shape as Uber Eats Manager /
// the DoorDash Merchant Portal: one login, a store switcher at the top,
// and every per-store screen (menu, promos, goodie bags, reviews) scoped to
// the selected store. The incoming-orders screen can additionally show all
// stores at once (see merchant/Orders.tsx).
import { useEffect } from "react";
import { create } from "zustand";
import { listMyCatalogs } from "../holochain/zomes/catalog";
import { bytesToHex, decodeEntry } from "../holochain/decode";
import { myAgentPubKey } from "../holochain/client";
import type { ActionHash, MerchantCatalog } from "../holochain/types";

export interface StoreRow {
  /// The store's catalog `original_action` -- its stable identity, used as
  /// `catalog_ref` everywhere.
  hash: ActionHash;
  hex: string;
  catalog: MerchantCatalog;
}

/// Per identity, so two identities used in the same browser don't share a
/// selection -- same localStorage posture as the session's own location.
function activeKey(): string {
  return `relay.merchant.activeStore.v1.${bytesToHex(myAgentPubKey())}`;
}

function loadActive(): string | null {
  try {
    return localStorage.getItem(activeKey());
  } catch {
    return null;
  }
}

function saveActive(hex: string) {
  try {
    localStorage.setItem(activeKey(), hex);
  } catch {
    // Remembering the selection is a convenience, never required.
  }
}

interface MerchantStoresState {
  /// `null` until the first load finishes.
  stores: StoreRow[] | null;
  activeHex: string | null;
  /// Re-reads every store from the conductor. Call after anything that
  /// changes a store's own content (open/closed, details) so the switcher's
  /// names/statuses stay current. `selectHex` makes a just-created store
  /// the active one.
  load: (selectHex?: string) => Promise<StoreRow[]>;
  setActive: (hex: string) => void;
}

/// Two screens mounting at once (or a re-render mid-load) share one
/// in-flight read instead of racing two.
let inflight: Promise<StoreRow[]> | null = null;

export const useMerchantStores = create<MerchantStoresState>((set) => ({
  stores: null,
  activeHex: null,

  load: async (selectHex) => {
    if (inflight && selectHex === undefined) return inflight;
    const run = loadStores(selectHex);
    inflight = run;
    try {
      return await run;
    } finally {
      if (inflight === run) inflight = null;
    }
  },

  setActive: (hex) => {
    saveActive(hex);
    set({ activeHex: hex });
  },
}));

async function loadStores(selectHex: string | undefined): Promise<StoreRow[]> {
  const views = await listMyCatalogs();
  const stores = views.map((v) => ({ hash: v.original_action, hex: bytesToHex(v.original_action), catalog: decodeEntry<MerchantCatalog>(v.record) }));
  // Keep the current/remembered selection if it still exists, otherwise
  // fall back to the first store -- never leave a stale selection pointing
  // at nothing.
  const wanted = selectHex ?? useMerchantStores.getState().activeHex ?? loadActive();
  const activeHex = stores.find((s) => s.hex === wanted)?.hex ?? stores[0]?.hex ?? null;
  if (activeHex) saveActive(activeHex);
  useMerchantStores.setState({ stores, activeHex });
  return stores;
}

/// The merchant's store list, loaded on first use -- the one place any
/// screen needs to ask for it, instead of each running its own load
/// effect. `enabled: false` (e.g. a profile without the Merchant role)
/// skips the read entirely.
export function useMyStores(enabled = true): StoreRow[] | null {
  const stores = useMerchantStores((s) => s.stores);
  const load = useMerchantStores((s) => s.load);
  useEffect(() => {
    if (enabled && stores === null) void load();
  }, [enabled, stores, load]);
  return stores;
}

export function useActiveStore(): StoreRow | null {
  return useMerchantStores((s) => s.stores?.find((row) => row.hex === s.activeHex) ?? null);
}
