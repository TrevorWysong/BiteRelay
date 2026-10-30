// What a person has chosen for themselves in a role: a customer's usual
// checkout, a driver's own limits. Each only ever narrows that person's own
// choices -- nobody else relies on them, and the network enforces its own
// rules regardless -- so they're kept on this device, like `preferences`.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DropoffPreference } from "../holochain/types";
import { TYPICAL_DRIVER_KMH } from "../lib/driving/eta";

/// A customer's checkout as they last left it, offered again next time.
export interface CheckoutDefaults {
  /// A tip percentage, or `null` for an amount they typed.
  tipPercent: number | null;
  /// The fee cap they chose, in minor units.
  feeCapCents: number | null;
  dropoffPreference: DropoffPreference;
  priority: boolean;
  /// Whether their app picks a driver from the bids, by the network's rule.
  autoMatch: boolean;
}

/// Paying the balance back up by saved card when it runs low -- the
/// card's charges are still only ever the person's own, signed by their app
/// and capped a day by the issuer.
export interface AutoTopUp {
  /// The issuer whose saved card pays, as hex.
  issuer: string;
  /// Topping up once the balance is below this, in minor units.
  belowCents: number;
  amountCents: number;
}

interface CustomerSettings {
  checkout: CheckoutDefaults;
  rememberCheckout: (checkout: CheckoutDefaults) => void;
  /// Each identity's auto top-up on this device, by agent hex.
  autoTopUps: Record<string, AutoTopUp>;
  setAutoTopUp: (agent: string, autoTopUp: AutoTopUp | null) => void;
}

export const useCustomerSettings = create<CustomerSettings>()(
  persist(
    (set) => ({
      checkout: { tipPercent: 15, feeCapCents: null, dropoffPreference: "HandToMe", priority: false, autoMatch: true },
      rememberCheckout: (checkout) => set({ checkout }),
      autoTopUps: {},
      setAutoTopUp: (agent, autoTopUp) =>
        set((state) => {
          const { [agent]: _previous, ...others } = state.autoTopUps;
          return { autoTopUps: autoTopUp ? { ...others, [agent]: autoTopUp } : others };
        }),
    }),
    // Checkout defaults saved before a field existed take its default.
    {
      name: "relay.customer-settings.v1",
      merge: (saved, current) => {
        const stored = saved as Partial<CustomerSettings> | undefined;
        return { ...current, checkout: { ...current.checkout, ...stored?.checkout }, autoTopUps: stored?.autoTopUps ?? {} };
      },
    },
  ),
);

/// A driver's own limits on what they're offered -- within the network's.
export interface DriverLimits {
  /// The most orders they'll carry at once; `null` for the network's limit.
  maxAtOnce: number | null;
  /// Whether they're offered priority orders.
  takePriority: boolean;
  /// The lowest fee cap they'll see an order for, in minor units.
  minFeeCents: number;
}

/// A driver's rule for bidding automatically, as the big apps offer orders:
/// on every order they're offered, at their own rate.
export interface AutoBid {
  on: boolean;
  /// What they charge per km of the trip -- to the store and on to the
  /// drop-off -- in minor units; never under their lowest fee.
  perKmCents: number;
  /// Stores they skip: those with at least this many drivers' reports of
  /// refusing to check them in.
  skipRefusals: number;
}

interface DriverSettings {
  limits: DriverLimits;
  autoBid: AutoBid;
  setAutoBid: (autoBid: Partial<AutoBid>) => void;
  /// How fast they usually travel, door to door, in km/h -- what their bid
  /// ETAs are estimated from.
  travelSpeedKmh: number;
  setLimits: (limits: Partial<DriverLimits>) => void;
  setTravelSpeed: (kmh: number) => void;
}

export const useDriverSettings = create<DriverSettings>()(
  persist(
    (set) => ({
      limits: { maxAtOnce: null, takePriority: true, minFeeCents: 0 },
      autoBid: { on: false, perKmCents: 100, skipRefusals: 3 },
      setAutoBid: (autoBid) => set((state) => ({ autoBid: { ...state.autoBid, ...autoBid } })),
      travelSpeedKmh: TYPICAL_DRIVER_KMH,
      setLimits: (limits) => set((state) => ({ limits: { ...state.limits, ...limits } })),
      setTravelSpeed: (travelSpeedKmh) => set({ travelSpeedKmh }),
    }),
    // Settings saved before a field existed take its default.
    { name: "relay.driver-settings.v1", merge: (saved, current) => ({ ...current, ...(saved as Partial<DriverSettings> | undefined), autoBid: { ...current.autoBid, ...(saved as Partial<DriverSettings> | undefined)?.autoBid } }) },
  ),
);
