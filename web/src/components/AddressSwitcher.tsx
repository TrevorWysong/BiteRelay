import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, MapPin, Plus, Trash2, X } from "lucide-react";
import { useSession } from "../store/session";
import { saveAddress, deleteSavedAddress, listMyAddresses } from "../holochain/zomes/profiles";
import { decodeEntry, bytesToHex } from "../holochain/decode";
import { reverseGeocode } from "../lib/geocoding";
import { AddressSearch } from "./AddressSearch";
import { Button, Input } from "./ui";
import type { AddressComponents } from "../lib/geocoding";
import type { GeoPoint, SavedAddress } from "../holochain/types";

interface AddressRow {
  hash: Uint8Array;
  address: SavedAddress;
}

function cityStateZip(a: { city: string; state: string; zip: string }): string {
  const stateZip = [a.state, a.zip].filter(Boolean).join(" ");
  return [a.city, stateZip].filter(Boolean).join(", ");
}

/// The DoorDash/UberEats-style "deliver to" switcher -- a pill showing the
/// current browse/delivery location, tapping it opens a sheet to either
/// pick a saved address or search a brand new one. Deliberately decoupled
/// from `Profile`/onboarding: `location` (session.ts) is just "which
/// address am I using *right now*," independent of wherever the account
/// was first set up -- the same reasoning DoorDash's own switcher lets you
/// order for someone else at a completely different address without
/// touching your account's real home address at all.
///
/// The sheet is rendered through a portal straight onto `document.body`,
/// not inline in this component's own render tree -- confirmed directly
/// that `position: fixed` breaks (gets clipped to some inner box instead
/// of the real viewport) when a descendant of AppShell's own animated
/// route wrapper (`AnimatedOutlet`, which applies a CSS `transform` for
/// its page-transition `y` animation -- any transformed ancestor becomes
/// the containing block for `fixed` children, per the CSS spec). A portal
/// escapes that ancestor entirely.
///
/// `value`/`onChange` make this controllable -- omit both (Browse.tsx's
/// usage) and it drives the global browsing location in `session.ts`
/// exactly as before; pass them (Cart.tsx's per-order dropoff, which
/// should default from the session location but not need to permanently
/// change it -- ordering for someone else at a one-off address shouldn't
/// overwrite a customer's own saved "where I am" pointer) to have this
/// drive any other piece of state instead, same address book and search
/// UI either way. `onValidate` is checked before any pick (search result,
/// saved address, or manual entry) is accepted -- returning a message
/// blocks the pick and shows it inline instead of closing the sheet,
/// which is how Cart.tsx rejects a dropoff outside the merchant's own
/// delivery radius without duplicating this sheet's own pick-handling.
export function AddressSwitcher({
  value,
  onChange,
  onValidate,
  label = "Choose a delivery address",
}: {
  value?: GeoPoint;
  onChange?: (point: GeoPoint) => void;
  onValidate?: (point: GeoPoint) => string | null;
  label?: string;
} = {}) {
  const sessionLocation = useSession((s) => s.location);
  const setSessionLocation = useSession((s) => s.setLocation);
  const location = value ?? sessionLocation;
  const setLocation = onChange ?? setSessionLocation;
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<{ label: string; components: AddressComponents } | null>(null);
  const [addresses, setAddresses] = useState<AddressRow[] | null>(null);
  const [picked, setPicked] = useState<{ point: GeoPoint; components: AddressComponents } | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingHex, setDeletingHex] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Reverse-geocode the pill's own display text whenever `location`
  // changes -- a plain lat/lon means nothing to a human glancing at the
  // header.
  useEffect(() => {
    const controller = new AbortController();
    reverseGeocode(location, controller.signal)
      .then((result) => result && setCurrent(result))
      .catch(() => {});
    return () => controller.abort();
  }, [location]);

  function loadAddresses() {
    listMyAddresses()
      .then((views) => setAddresses(views.map((v) => ({ hash: v.original_action, address: decodeEntry<SavedAddress>(v.record) }))))
      .catch(() => setAddresses([]));
  }

  // Opening/closing is always a user action, so its side effects live in
  // the handlers rather than an effect watching `open`.
  function openSheet() {
    setOpen(true);
    loadAddresses();
  }

  function closeSheet() {
    setOpen(false);
    setValidationError(null);
  }

  function pickAddress(point: GeoPoint) {
    const error = onValidate?.(point) ?? null;
    if (error) {
      setValidationError(error);
      return;
    }
    setValidationError(null);
    setLocation(point);
    closeSheet();
    setPicked(null);
    setNewLabel("");
  }

  async function saveCurrentPick() {
    if (!picked || !newLabel.trim()) return;
    setSaving(true);
    try {
      await saveAddress({
        label: newLabel.trim(),
        location: picked.point,
        street: picked.components.street,
        city: picked.components.city,
        state: picked.components.state,
        zip: picked.components.zip,
        created_at: Date.now() * 1000,
      });
      loadAddresses();
      pickAddress(picked.point);
    } finally {
      setSaving(false);
    }
  }

  async function removeAddress(row: AddressRow) {
    setDeletingHex(bytesToHex(row.hash));
    try {
      await deleteSavedAddress(row.hash);
      loadAddresses();
    } finally {
      setDeletingHex(null);
    }
  }

  // DoorDash shows just the street line in its collapsed address pill --
  // city/state/zip only shows up once you open the switcher. Falls back
  // to the full label when there's no street component to show (e.g. a
  // manually-entered lat/lon with nothing nearby to resolve a house
  // number against).
  const pillText = current?.components.street || current?.label || "Set a delivery address";

  return (
    <>
      <button
        onClick={openSheet}
        className="mb-3 flex w-full items-center gap-2 rounded-full border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900 px-4 py-2.5 text-left transition hover:border-relay-300"
      >
        <MapPin size={16} className="shrink-0 text-relay-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{pillText}</span>
        <ChevronDown size={16} className="shrink-0 text-ink-400" />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
              onClick={closeSheet}
            >
              <motion.div
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 28, stiffness: 300 }}
                onClick={(e) => e.stopPropagation()}
                className="flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-white dark:bg-ink-900"
              >
                <div className="flex items-center justify-between p-4 pb-0">
                  <h2 className="text-base font-black text-ink-900 dark:text-ink-50">{label}</h2>
                  <button onClick={closeSheet} className="grid h-8 w-8 place-items-center rounded-full text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800">
                    <X size={18} />
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4 pt-3">
                  {current?.components.street && (
                    <div className="mb-4 rounded-xl bg-relay-50 dark:bg-relay-900/20 p-3">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-relay-600 dark:text-relay-400">Currently using</p>
                      <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{current.components.street}</p>
                      <p className="text-xs text-ink-400">{cityStateZip(current.components)}</p>
                    </div>
                  )}

                  <AddressSearch
                    value={location}
                    onChange={(point) => setPicked((prev) => ({ point, components: prev?.components ?? { street: "", city: "", state: "", zip: "" } }))}
                    onSelectComponents={(components) => setPicked((prev) => (prev ? { ...prev, components } : null))}
                    label="Search for a new address"
                    placeholder="Enter a street address…"
                  />

                  {picked && (
                    <div className="mt-3 flex items-center gap-2 rounded-xl bg-ink-50 dark:bg-ink-800/50 p-3">
                      <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Label (e.g. Home, Work)" className="flex-1" />
                      <Button loading={saving} disabled={!newLabel.trim()} onClick={saveCurrentPick} className="px-3 py-2.5 text-xs">
                        <Plus size={14} /> Save
                      </Button>
                    </div>
                  )}
                  {picked && (
                    <button onClick={() => pickAddress(picked.point)} className="mt-2 text-xs font-semibold text-relay-600 underline-offset-2 hover:underline">
                      Just use this address once, without saving
                    </button>
                  )}
                  {validationError && <p className="mt-2 text-xs font-semibold text-red-500">{validationError}</p>}

                  <div className="mt-5">
                    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">Saved addresses</p>
                    {addresses === null && <p className="text-xs text-ink-400">Loading…</p>}
                    {addresses?.length === 0 && <p className="text-xs text-ink-400">No saved addresses yet -- search above and save one for next time.</p>}
                    <div className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800">
                      {addresses?.map((row) => {
                        const hex = bytesToHex(row.hash);
                        const isCurrent = location.lat === row.address.location.lat && location.lon === row.address.location.lon;
                        return (
                          <div key={hex} className="flex items-center gap-2 py-3">
                            <button onClick={() => pickAddress(row.address.location)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                              <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${isCurrent ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500"}`}>
                                <MapPin size={15} />
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{row.address.label}</p>
                                <p className="truncate text-xs text-ink-400">
                                  {row.address.street}
                                  {row.address.street && ", "}
                                  {cityStateZip(row.address)}
                                </p>
                              </div>
                            </button>
                            <button
                              onClick={() => removeAddress(row)}
                              disabled={deletingHex === hex}
                              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-300 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20"
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
